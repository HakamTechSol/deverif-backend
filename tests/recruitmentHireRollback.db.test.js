import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import mysql from "mysql2/promise";
import dotenv from "dotenv";
import { respondToOffer as respondToOfferController } from "../src/controllers/org/recruitment.controller.js";
import { hireCandidate, createOpening, createCandidate, updateCandidateStage } from "../src/services/recruitment.service.js";
import { pool } from "../src/config/db.js";

/**
 * hire() IS THREE WRITES OR NONE.
 *
 * The irreversible step of the whole module, and the only one reachable from a
 * single click. It writes an employee row, drafts an offer letter, and flips the
 * candidate to `hired` with back-references to both. Any subset of those is a
 * corrupt outcome:
 *
 *   employee without `hired`   a person on the roster, in payroll, that no pipeline
 *                              shows as hired and nobody can account for
 *   `hired` without employee   a vacancy reported as filled that hired nobody
 *   letter for a rolled-back hire   an offer promising a job that was never offered
 *
 * So the property under test is not "hire works" — the lifecycle suite covers that.
 * It is that a failure PART-WAY THROUGH leaves nothing behind, at every point the
 * transaction can fail.
 *
 * HOW THE FAILURE IS INJECTED, and why each point is worth its own test:
 *
 *   no offer-letter template exists   the common real case: an org that never
 *                                     configured one. The hire must not half-commit.
 *   a supplied template is bad        a template whose merge tags cannot resolve, so
 *                                     issueLetter would refuse — and it refuses
 *                                     INSIDE the same transaction.
 *   vacancies already filled          the guard that stops over-hiring, checked
 *                                     before any INSERT.
 *
 * Nothing is mocked. A test that stubs the service is asserting that the stub
 * behaves, which is how a transaction test passes while the transaction is broken.
 * The failures here are real errors from real code paths.
 */

const HAS_DB = await (async () => {
  try {
    const c = await mysql.createConnection(readDbConfig());
    await c.query("SELECT 1");
    await c.end();
    return true;
  } catch {
    return false;
  }
})();

import { purgeTestOrgs } from "./helpers/dbCleanup.js";
import {
  seedOfferLetterTemplate,
  prepareOffer,
  approveOffer,
  sendPreparedOffer,
  respondPreparedOffer,
} from "./helpers/offerLifecycle.js";

/**
 * The offer email is stubbed: this project HAS SMTP credentials in its .env, so an
 * unmocked `sendRecruitmentOfferEmail` is a real delivery attempt to an
 * `@example.com` address. Only the mailer is mocked - every transaction, guard and
 * row count below stays real.
 */
vi.mock("../src/utils/mailer.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, sendRecruitmentOfferEmail: vi.fn(async () => ({ messageId: "rollback-test" })) };
});

dotenv.config({ quiet: true });

function readDbConfig() {
  return {
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || process.env.DB_PASS || "",
    database: process.env.DB_NAME,
  };
}

const cfg = readDbConfig();

let db;
let orgId;
let seq = 0;
let rollbackTemplateUuid;
/** The staff member who prepares the offer and records the candidate's response. */
let adminUuid;
/** A SECOND org_admin: the requester cannot decide their own offer. */
let approverUuid;

beforeAll(async () => {
  if (!HAS_DB) return;
  db = await mysql.createConnection(cfg);
  const [org] = await db.query("INSERT INTO organizations (uuid, name) VALUES (UUID(), ?)", [
    `Hire rollback ${Date.now()}`,
  ]);

  orgId = org.insertId;

  // An active offer template must exist before any hire, or the hire is REFUSED:
// TWO org_admins. `startApproval` resolves the default workflow's first step to real
  // active users, and `decideApproval` refuses to let the requester decide their own
  // submission - so one admin could prepare an offer nothing could ever approve.
  for (const tag of [1, 2]) {
    const u = crypto.randomUUID();
    if (tag === 1) adminUuid = u;
    else approverUuid = u;
    await db.query(
      `INSERT INTO users (uuid, organization, full_name, email, cnic, status, org_role, feature_access)
       VALUES (?, ?, ?, ?, ?, 'active', 'org_admin', ?)`,
      [
        u,
        orgId,
        `Rollback Admin ${tag}`,
        `rb-admin${tag}-${u.slice(0, 8)}@example.com`,
        `35202-${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}-${tag}`,
        JSON.stringify({ manage_recruitment: true }),
      ],
    );
  }

  // An Offer Letter template with `$`-prefixed tags. `previewOffer` refuses a template
  // with no `$new_salary`, and cannot see a tag written as `{{name}}`.
  rollbackTemplateUuid = await seedOfferLetterTemplate(db, orgId);
});

afterAll(async () => {
  if (!db) return;
  
  // Teardown guarantee. The ordered DELETEs above depend on the current
  // foreign-key graph, and employees.organization_id is RESTRICT, so a change to
  // that graph turns a cleanup step into a thrown error and skips the deletes after
  // it - leaving the organization, and everything under it, in the database. That is
  // how a failing suite leaked its whole fixture on every run.
  //
  // purgeTestOrgs discovers the org-scoped tables instead of hardcoding them and
  // suspends FK checks for the duration, so it does not depend on that ordering at
  // all. Running it in a finally means it happens whether or not the steps above
  // succeeded, and whether or not the tests themselves passed.
  try {
await db.query("DELETE FROM attachments WHERE organization_id=?", [orgId]);
    await db.query("DELETE FROM interviews WHERE organization_id=?", [orgId]);
    await db.query("DELETE FROM candidates WHERE organization_id=?", [orgId]);
    await db.query("DELETE FROM job_openings WHERE organization_id=?", [orgId]);
    await db.query("DELETE FROM hr_letters WHERE organization_id=?", [orgId]);
    await db.query("DELETE FROM employees WHERE organization_id=?", [orgId]);
  
  } finally {
    await purgeTestOrgs(db, [orgId]);
    await db.end();
  }});

/** An opening with a real designation, and a candidate walked all the way to `offered`. */
async function offeredCandidate(name) {
  const n = ++seq;
  const opening = await createOpening({
    orgId,
    title: `Role ${n}`,
    status: "open",
    vacancies: 5,
    conn: db,
  });
  const candidate = await createCandidate({
    orgId,
    openingUuid: opening.uuid,
    fullName: name ?? `Rollback Candidate ${n}`,
    email: `rollback-${n}@example.com`,
    conn: db,
  });
  for (const stage of ["screening", "interview", "selected", "offered"]) {
    await updateCandidateStage({ orgId, candidateUuid: candidate.uuid, stage, conn: db });
  }
  return { opening, candidate };
}

/**
 * Everything the hire touched, read directly.
 *
 * Read from the database rather than from the thrown error's fields, because an error
 * message is what the function CLAIMED; these are the rows that exist.
 */
async function snapshot(name) {
  const [emps] = await db.query("SELECT COUNT(*) AS n FROM employees WHERE full_name=?", [name]);
  const [letters] = await db.query(
    "SELECT COUNT(*) AS n FROM hr_letters l JOIN employees e ON e.uuid=l.employee_uuid WHERE e.full_name=?",
    [name],
  );
  return { employees: Number(emps[0].n), letters: Number(letters[0].n) };
}

/** Prepare, approve and send an offer for a candidate who is already at `offered`. */
async function prepareAndSend(candidateUuid) {
  await prepareOffer({
    orgId,
    actorUuid: adminUuid,
    candidateUuid,
    templateUuid: rollbackTemplateUuid,
    conn: db,
  });
  await approveOffer({ orgId, actorUuid: approverUuid, candidateUuid, conn: db });
  await sendPreparedOffer({ orgId, actorUuid: adminUuid, candidateUuid, conn: db });
  return candidateUuid;
}

/**
 * A brand-new candidate walked to `offered` and then driven to a genuinely approved and
 * sent offer - the ONLY state an acceptance can start from.
 */
async function sentOfferCandidate(name) {
  const { opening, candidate } = await offeredCandidate(name);
  await prepareAndSend(candidate.uuid);
  return { opening, candidate };
}

/** Accept through the real transaction-owning path (no `conn`). */
const accept = (candidateUuid, extra = {}) =>
  respondPreparedOffer({ orgId, actorUuid: adminUuid, candidateUuid, response: "accepted", ...extra });

/**
 * Simulate the rival that got there first, using an INDEPENDENT connection.
 *
 * `db` is a single connection rather than a pool, so this has to be a genuine
 * cross-session change, not a statement queued behind the first one.
 *
 * It sets `converted_employee_uuid` - and that column is the one precondition that
 * ONLY the one-shot `UPDATE` inside `hireCandidate` re-asserts. `respondToOffer` checks
 * stage and `offer_status` before delegating, so flipping either of those would be
 * refused earlier and never reach the INSERT we need to roll back. The FK to
 * employees is why a real employee row has to be created first rather than a random
 * uuid.
 *
 * @returns the rival's employee uuid.
 */
async function rivalTakesTheCandidate(candidateUuid, fullName) {
  const rival = await mysql.createConnection(cfg);
  try {
    const rivalEmployeeUuid = crypto.randomUUID();
    await rival.query(
      "INSERT INTO employees (uuid, organization_id, full_name, status) VALUES (?, ?, ?, 'current_employee')",
      [rivalEmployeeUuid, orgId, fullName],
    );
    await rival.query("UPDATE candidates SET converted_employee_uuid=? WHERE uuid=?", [
      rivalEmployeeUuid,
      candidateUuid,
    ]);
    return rivalEmployeeUuid;
  } finally {
    await rival.end();
  }
}

describe.runIf(HAS_DB)("a hire that fails part-way leaves nothing behind", () => {
  it("an offer that was never SENT refuses BEFORE writing, so there is nothing to undo", async () => {
    const { candidate } = await offeredCandidate("Rollback Not Sent");
    const name = "Rollback Not Sent";

    const before = await snapshot(name);
    expect(before).toEqual({ employees: 0, letters: 0 });

    // A real refusal from a real code path: `hireCandidate` requires a sent offer plus
    // the acceptance flag, and only `respondToOffer` supplies the latter. No `conn`,
    // so the wrapper owns the transaction - the production path.
    await expect(
      hireCandidate({ orgId, candidateUuid: candidate.uuid }),
    ).rejects.toThrow(/only after the candidate accepts a sent offer/i);

    expect(await snapshot(name)).toEqual({ employees: 0, letters: 0 });

    const [row] = await db.query("SELECT stage, converted_employee_uuid FROM candidates WHERE uuid=?", [
      candidate.uuid,
    ]);
    // Still exactly as it was. A candidate flipped to `hired` here would report a
    // filled vacancy for someone who was never added.
    expect(row[0].stage).toBe("offered");
    expect(row[0].converted_employee_uuid).toBeNull();
  });

  it("a candidate who is not at `offered` is refused before any INSERT", async () => {
    const opening = await createOpening({ orgId, title: "Wrong Stage", status: "open", vacancies: 5, conn: db });
    const candidate = await createCandidate({
      orgId,
      openingUuid: opening.uuid,
      fullName: "Still Screening",
      email: `still-screening-${++seq}@example.com`,
      conn: db,
    });
    await updateCandidateStage({ orgId, candidateUuid: candidate.uuid, stage: "screening", conn: db });

    // Even with a sent offer, a candidate back at `screening` cannot be hired.
    await expect(accept(candidate.uuid)).rejects.toThrow(/Only a sent offer can receive a response/i);

    expect(await snapshot("Still Screening")).toEqual({ employees: 0, letters: 0 });
  });

  it("a full vacancy is refused before any INSERT", async () => {
    // One seat, two candidates. The second hire must be refused by the vacancy guard
    // rather than by a unique constraint discovered afterwards.
    const opening = await createOpening({ orgId, title: "One Seat", status: "open", vacancies: 1, conn: db });
    const mk = async (n) => {
      const c = await createCandidate({
        orgId,
        openingUuid: opening.uuid,
        fullName: `One Seat ${n}`,
        email: `one-seat-${n}-${++seq}@example.com`,
        conn: db,
      });
      for (const stage of ["screening", "interview", "selected", "offered"]) {
        await updateCandidateStage({ orgId, candidateUuid: c.uuid, stage, conn: db });
      }
      return c;
    };

    const first = await mk(1);
    await prepareAndSend(first.uuid);
    await accept(first.uuid);

    const second = await mk(2);
    await prepareAndSend(second.uuid);
    await expect(accept(second.uuid)).rejects.toThrow(/vacanc/i);

    expect(await snapshot("One Seat 2")).toEqual({ employees: 0, letters: 0 });
  });

  it("a hire that fails AFTER the employee INSERT leaves no employee", async () => {
    // THE CASE THE PREVIOUS ONES MISS, and the one this file exists for.
    //
    // The failures above are all detected BEFORE the employee INSERT - a wrong stage, a
    // full vacancy, an unsent offer. This one fires after it, at the one-shot
    // `UPDATE ... WHERE stage IN ('selected','offered') AND offer_status='sent' AND
    // converted_employee_uuid IS NULL` that re-asserts both preconditions. If the
    // transaction does not roll back, the employee row is already committed by then:
    // a real person on the roster with no hire recorded.
    //
    // The failure is injected with the DATABASE, not a stub: a rival connection takes
    // the candidate first, so the guard's `converted_employee_uuid IS NULL` clause
    // matches nothing and the UPDATE returns 0 affected rows. A mocked or reordered
    // guard could not reproduce this.
    const { candidate } = await sentOfferCandidate("Rollback After Insert");
    const name = "Rollback After Insert";

    const rivalEmployeeUuid = await rivalTakesTheCandidate(candidate.uuid, "Rival Employee");

    await expect(accept(candidate.uuid)).rejects.toThrow();

    // The assertion that matters: THIS hire's employee row was rolled back. The rival's
    // row is a different person and legitimately exists.
    expect(await snapshot(name)).toEqual({ employees: 0, letters: 0 });

    const [[survivor]] = await db.query("SELECT uuid FROM employees WHERE organization_id=? AND full_name=?", [
      orgId,
      "Rival Employee",
    ]);
    expect(survivor.uuid).toBe(rivalEmployeeUuid);

    const [row] = await db.query(
      "SELECT converted_employee_uuid FROM candidates WHERE uuid=?",
      [candidate.uuid],
    );
    // The candidate still points at the RIVAL's employee, never at a rolled-back one.
    expect(row[0].converted_employee_uuid).toBe(rivalEmployeeUuid);

    // The rival's employee row is deliberately NOT deleted here: the candidate still
    // references it, so deleting it would fail the FK. `purgeTestOrgs` in afterAll
    // clears the whole organization with FK checks suspended.
  });

  it("the happy path DOES write the employee, so the failures above are not passing vacuously", async () => {
    // Without this, "no employee row" after every failure would be equally consistent
    // with the hire never writing anything. This is the control.
    const { candidate } = await sentOfferCandidate("Control Hire");

    const result = await accept(candidate.uuid, { cnic: "35202-1111111-1" });

    expect(result.employee_uuid).toBeTruthy();
    expect(await snapshot("Control Hire")).toEqual({ employees: 1, letters: 0 });

    const [row] = await db.query("SELECT stage, converted_employee_uuid, offer_status FROM candidates WHERE uuid=?", [
      candidate.uuid,
    ]);
    expect(row[0].stage).toBe("hired");
    expect(row[0].offer_status).toBe("accepted");
    // The back-reference set: this is what makes the conversion auditable in either
    // direction, and what makes a re-hire a no-op rather than a duplicate.
    expect(row[0].converted_employee_uuid).toBe(result.employee_uuid);

    // The accepted offer's salary becomes the employee's starting salary - the join
    // between an approved offer and the roster payroll reads.
    const [salary] = await db.query(
      "SELECT basic_salary FROM employee_salary_history WHERE employee_uuid=? ORDER BY effective_from DESC LIMIT 1",
      [result.employee_uuid],
    );
    expect(Number(salary[0].basic_salary)).toBeGreaterThan(0);
  });
});

describe.runIf(HAS_DB)("the ROLLBACK ACTUALLY FIRES, rather than the final state merely looking right", () => {
  // The distinction this closes. Every other test here asserts a FINAL STATE: no
  // employee row, candidate still at `offered`. All are also consistent with the
  // employee INSERT simply never running - with the guard firing one statement earlier
  // than intended. So a final-state test cannot tell "rolled back" from "never
  // written"; both look identical to someone reading the database.
  //
  // This asserts the MECHANISM: beginTransaction and rollback are both called on the
  // connection hireCandidate OWNS.
  //
  // Spying on `pool.getConnection` rather than on a connection handed IN, and that
  // distinction is load-bearing. Passing a connection makes own=false, because the
  // contract is that a supplied conn is already inside a transaction - so a spy there
  // records nothing and would have "passed" while proving nothing.
  async function spyOnOwnedTransaction() {
    const events = [];
    const realGetConnection = pool.getConnection.bind(pool);
    let patched = null;

    pool.getConnection = async () => {
      const conn = await realGetConnection();
      patched = conn;
      const { beginTransaction, rollback, commit } = conn;
      conn.beginTransaction = async () => {
        events.push("begin");
        return beginTransaction.call(conn);
      };
      conn.rollback = async () => {
        events.push("rollback");
        return rollback.call(conn);
      };
      conn.commit = async () => {
        events.push("commit");
        return commit.call(conn);
      };
      return conn;
    };

    return {
      events,
      restore() {
        pool.getConnection = realGetConnection;
      },
    };
  }

  it("calls beginTransaction and rollback on a failure, in that order", async () => {
    // The post-INSERT failure again, because a PRE-INSERT refusal would never reach the
    // rollback branch in a way that proves anything: it throws before the transaction
    // has anything to undo.
    const { candidate } = await sentOfferCandidate("Rollback Mechanism");
    const spy = await spyOnOwnedTransaction();

    try {
      // Same injection as above, so the failure lands AFTER the employee INSERT.
      await rivalTakesTheCandidate(candidate.uuid, "Rival Mechanism");

      // No `conn`, so the wrapper opens its OWN transaction -- the production path.
      await expect(accept(candidate.uuid)).rejects.toThrow();
    } finally {
      spy.restore();
    }

    expect(spy.events).toEqual(["begin", "rollback"]);
    // Nothing else: a stray commit on a failure path would leave the employee row.
    expect(spy.events).not.toContain("commit");
    // And the effect, which is what the other tests in this file assert.
    expect(await snapshot("Rollback Mechanism")).toEqual({ employees: 0, letters: 0 });
  });

  it("commits exactly once on the happy path, and never rolls back", async () => {
    const { candidate } = await sentOfferCandidate("Commit Mechanism");
    const spy = await spyOnOwnedTransaction();

    let result;
    try {
      result = await accept(candidate.uuid);
    } finally {
      spy.restore();
    }

    expect(spy.events).toEqual(["begin", "commit"]);
    expect(spy.events).not.toContain("rollback");
    // The control for the test above. If a SUCCESS also rolled back, these rows would
    // be gone and the rollback test would pass for the wrong reason: same events,
    // opposite effect.
    expect(result.employee_uuid).toBeTruthy();
    expect(await snapshot("Commit Mechanism")).toEqual({ employees: 1, letters: 0 });
  });
});

describe.runIf(HAS_DB)("the rollback holds through the CONTROLLER, not just the service", () => {
  it("a failing controller response writes no employee", async () => {
    // Through the controller rather than the service, because that is the layer every
    // real caller goes through - and it is where a res object or a missing body field
    // could turn a refusal into a half-write.
    //
    // This replaced a test for `hireApplication`, a controller that no longer exists:
    // there is no /hire route, because a hire now requires an accepted offer.
    const { candidate } = await sentOfferCandidate("Controller Rollback");
    const name = "Controller Rollback";

    // No `response` in the body, so the service refuses before any INSERT.
    const req = {
      params: { uuid: candidate.uuid },
      scopeOrgId: orgId,
      user: { uuid: adminUuid },
      body: {},
    };
    const res = { status() { return this; }, json() { return this; }, send() { return this; } };

    await expect(respondToOfferController(req, res)).rejects.toThrow();

    expect(await snapshot(name)).toEqual({ employees: 0, letters: 0 });
    const [row] = await db.query("SELECT stage FROM candidates WHERE uuid=?", [candidate.uuid]);
    expect(row[0].stage).toBe("offered");
  });
});
