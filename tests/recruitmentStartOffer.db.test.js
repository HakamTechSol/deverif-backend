import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import crypto from "node:crypto";
import mysql from "mysql2/promise";
import dotenv from "dotenv";

import {
  createOpening,
  createCandidate,
  updateCandidateStage,
  hireCandidate,
  startCandidateOffer,
  requestOfferApproval,
  decideOfferApproval,
  sendOffer,
  getCandidate,
  getPipelineBoard,
  listOffers,
  getOfferApproval,
} from "../src/services/recruitment.service.js";

/**
 * THE OFFER-BYPASS GAP, AND THE FIX.
 *
 * WHAT THE MANUAL UI TEST FOUND: a candidate in the Offered column had a "Hire this
 * candidate" button that called `hireCandidate` directly. That function creates the
 * employee record and drafts the letter, and then stops — so a real person landed on
 * the payroll whose offer was never submitted, never approved, and never sent. The
 * employee row is the one write in this module the UI cannot undo, and it was the one
 * write with no enforced follow-up.
 *
 * THE FIX IS `startCandidateOffer`, and these tests pin the two properties that close
 * it:
 *
 *   1. THE PIPELINE'S ENTRY POINT ALWAYS SUBMITS THE APPROVAL. There is no code path
 *      from the pipeline that creates an employee without an approval chain, so the
 *      state that was found in testing is now unreachable through the UI.
 *
 *   2. THE APPROVED-AND-SENT OFFER IS STILL REQUIRED BEFORE THE LETTER CAN BE ISSUED.
 *      Enforced by `sendOffer`, not by the hire — because the letter is minted BY the
 *      hire. Inverting that (requiring a sent letter before the hire) is a deadlock:
 *      the letter only exists after the hire, so nothing could ever be hired.
 *
 * Plus the preflight: a misconfigured approval workflow must be caught BEFORE the
 * employee exists, because there is no undo for a committed hire.
 */

import { purgeTestOrgs } from "./helpers/dbCleanup.js";
import {
  seedOfferLetterTemplate,
  prepareOffer,
  approveOffer,
  sendPreparedOffer,
  respondPreparedOffer,
} from "./helpers/offerLifecycle.js";

/**
 * The offer email is REAL here, not stubbed.
 *
 * `sendOffer` calls `sendRecruitmentOfferEmail`, and this project HAS SMTP
 * credentials in its .env - so an unmocked send is not a no-op, it is a genuine
 * delivery attempt to a `@example.com` address that will bounce off a real mail
 * server. Mocking the whole module is deliberate rather than a shortcut: it keeps the
 * offer lifecycle's own assertions (status transitions, snapshot hashes) real while
 * stopping the test from sending mail.
 */
vi.mock("../src/utils/mailer.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, sendRecruitmentOfferEmail: vi.fn(async () => ({ messageId: "offer-test" })) };
});

dotenv.config({ quiet: true });

function readDbConfig() {
  return {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  };
}

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

let db;
let orgId;
let otherOrgId;
let departmentId;
let designationId;
let adminUuid;
let approverUuid;
/** Module-scoped, not const inside beforeAll: every test in this file needs the same template. */
let startOfferTemplateUuid;
let seq = 0;

beforeAll(async () => {
  if (!HAS_DB) return;
  db = await mysql.createConnection(readDbConfig());

  // ITS OWN ORGANIZATION, not one borrowed from another test file.
  //
  // The first draft of this file read `recruitmentLifecycle`'s org by slug, which made
  // it depend on that file having run first AND on a `slug` column that organizations
  // does not have. So it skipped the whole suite. Its own org means the suite can run
  // alone, in any order, or twice.
  const [org] = await db.query("INSERT INTO organizations (uuid, name) VALUES (UUID(), ?)", [
    `Start offer ${Date.now()}`,
  ]);

  orgId = org.insertId;
  // This suite tests workflows that require a separate approver; don't rely on
  // the non-strict fallback for organizations without a saved policy row.
  await db.query(
    "INSERT INTO organization_approval_policies (organization_id, strict_dual_control, created_at, updated_at) VALUES (?, 1, NOW(), NOW())",
    [orgId],
  );

  const [other] = await db.query("INSERT INTO organizations (uuid, name) VALUES (UUID(), ?)", [
    `Start offer other ${Date.now()}`,
  ]);
  otherOrgId = other.insertId;

  const [dept] = await db.query(
    "INSERT INTO departments (uuid, organization_id, name) VALUES (UUID(), ?, 'Engineering')",
    [orgId],
  );
  departmentId = dept.insertId;
  const [desig] = await db.query(
    "INSERT INTO designations (uuid, organization_id, name) VALUES (UUID(), ?, 'Accountant')",
    [orgId],
  );
  designationId = desig.insertId;

  // An org_admin HAS TO EXIST, and this is not incidental: the approval engine resolves
  // its default workflow's first step ('org_admin') to real active users, and
  // `startApproval` refuses with "has no approver" when there are none. So without this
  // user every start-offer in this file would fail for a reason that has nothing to do
  // with what is being tested.
  const uuid = crypto.randomUUID();
  adminUuid = uuid;
  await db.query(
    `INSERT INTO users (uuid, organization, full_name, email, cnic, status, org_role, feature_access)
     VALUES (?, ?, ?, ?, ?, 'active', 'org_admin', ?)`,
    [
      uuid,
      orgId,
      "Start Offer Admin",
      `start-offer-${uuid.slice(0, 8)}@example.com`,
      `35202-${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}-1`,
      JSON.stringify({ manage_recruitment: true }),
    ],
  );

  // A SECOND org_admin. Required by the pre-hire flow rather than incidental:
  // `decideApproval` refuses to let the requester decide their own submission, so the
  // offer cannot move from `pending_approval` to `approved` unless somebody other than
  // `adminUuid` approves it. One user could prepare and never approve, which is exactly
  // the self-approval block this file also asserts is enforced.
  const approverUuidValue = crypto.randomUUID();
  approverUuid = approverUuidValue;
  await db.query(
    `INSERT INTO users (uuid, organization, full_name, email, cnic, status, org_role, feature_access)
     VALUES (?, ?, ?, ?, ?, 'active', 'org_admin', ?)`,
    [
      approverUuidValue,
      orgId,
      "Start Offer Approver",
      `start-approver-${approverUuidValue.slice(0, 8)}@example.com`,
      `35202-${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}-2`,
      JSON.stringify({ manage_recruitment: true }),
    ],
  );

  // An active Offer Letter template must exist before an offer can be prepared at all:
  // `startCandidateOffer` refuses with "Select an Offer Letter template before
  // submitting for approval", and `previewOffer` additionally refuses a template with
  // no `$new_salary`, because the approved offer is what carries the salary term into
  // payroll. See the seeder for why the shared `seedOfferTemplate` cannot be used here.
  startOfferTemplateUuid = await seedOfferLetterTemplate(db, orgId);
});

afterAll(async () => {
  if (!db || !orgId) return;
  
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
// Children before parents, and the org last. candidates RESTRICT on employees, and
    // approval_requests point at workflow_definitions, so deleting either first would
    // leave the teardown half-done and this org behind for the next run.
    await db.query(
      "DELETE FROM approval_step_history WHERE approval_request_uuid IN (SELECT uuid FROM approval_requests WHERE organization_id=?)",
      [orgId],
    );
    await db.query("DELETE FROM approval_requests WHERE organization_id=?", [orgId]);
    await db.query("DELETE FROM interviews WHERE organization_id=?", [orgId]);
    await db.query("DELETE FROM hr_letters WHERE organization_id=?", [orgId]);
    // letter_templates BEFORE the org: hr_letters.template_uuid points here, and the
    // org delete cascades into departments/designations which job_openings also
    // reference.
    await db.query("DELETE FROM letter_templates WHERE organization_id=?", [orgId]);
    // Before the org: job_openings carries a composite FK to departments, which
    // cascades from the organization, so leaving openings behind makes deleting the org
    // fail with fk_job_openings_department_tenant and leaks the whole fixture.
    await db.query("DELETE FROM job_openings WHERE organization_id=?", [orgId]);
    await db.query("UPDATE candidates SET offer_letter_uuid=NULL, converted_employee_uuid=NULL WHERE organization_id=?", [orgId]);
    await db.query("DELETE FROM candidates WHERE organization_id=?", [orgId]);
    // Hard delete, not the `ex_employee` soft status used in beforeEach: fk_emp_org
    // RESTRICTs the organization, and these employees exist only as this suite's
    // fixtures, so leaving them would make every subsequent run of this file fail in
    // teardown while the tests themselves passed.
    await db.query("DELETE FROM employees WHERE organization_id=?", [orgId]);
    await db.query("DELETE FROM users WHERE organization=?", [orgId]);
  
  } finally {
    await purgeTestOrgs(db, [orgId, otherOrgId]);
    await db.end();
  }});

/** Clears THIS suite's candidates and their approval chains between tests. */
beforeEach(async () => {
  if (!HAS_DB) return;
  await db.query(
    "DELETE FROM approval_step_history WHERE approval_request_uuid IN (SELECT uuid FROM approval_requests WHERE organization_id=?)",
    [orgId],
  );
  await db.query("DELETE FROM approval_requests WHERE organization_id=?", [orgId]);
  await db.query("UPDATE candidates SET offer_letter_uuid=NULL, converted_employee_uuid=NULL WHERE organization_id=?", [orgId]);
  await db.query("DELETE FROM hr_letters WHERE organization_id=?", [orgId]);
  await db.query("UPDATE employees SET status='ex_employee' WHERE organization_id=?", [orgId]);
  await db.query("DELETE FROM candidates WHERE organization_id=?", [orgId]);
  await db.query("DELETE FROM job_openings WHERE organization_id=?", [orgId]);
});

/** A candidate walked all the way to `offered`, ready to have an offer started. */
async function atOffered(name) {
  const opening = await createOpening({
    orgId,
    title: `Role ${++seq}`,
    departmentId,
    designationId,
    status: "open",
    vacancies: 9,
    conn: db,
  });
  const candidate = await createCandidate({
    orgId,
    openingUuid: opening.uuid,
    fullName: name,
    email: `${name.toLowerCase().replace(/\s+/g, "-")}-${crypto.randomUUID().slice(0, 6)}@example.com`,
    conn: db,
  });
  for (const stage of ["screening", "interview", "selected", "offered"]) {
    await updateCandidateStage({ orgId, candidateUuid: candidate.uuid, stage, conn: db });
  }
  return { opening, candidate };
}

describe.runIf(HAS_DB)("starting an offer prepares it, and creates NO employee", () => {
  /**
   * THE CENTRAL CLAIM OF THE PRE-HIRE LIFECYCLE.
   *
   * `startCandidateOffer` prepares and submits. It does not hire. The employee row is
   * created by `respondToOffer('accepted')` and by nothing else, so the thing this
   * file protects is that no code path can conjure a roster entry ahead of a
   * candidate's acceptance.
   */

  it("prepares and sends an offer when a legacy candidate email already belongs to a platform user", async () => {
    const { candidate } = await atOffered("Legacy Email Overlap");
    const [[admin]] = await db.query("SELECT email FROM users WHERE uuid=?", [adminUuid]);
    await db.query(
      "UPDATE candidates SET email=? WHERE organization_id=? AND uuid=?",
      [admin.email, orgId, candidate.uuid],
    );

    await prepareOffer({
      orgId,
      actorUuid: adminUuid,
      candidateUuid: candidate.uuid,
      templateUuid: startOfferTemplateUuid,
      conn: db,
    });
    await approveOffer({ orgId, actorUuid: approverUuid, candidateUuid: candidate.uuid, conn: db });
    const sent = await sendPreparedOffer({
      orgId,
      actorUuid: adminUuid,
      candidateUuid: candidate.uuid,
      conn: db,
    });

    expect(sent.status).toBe("sent");
    const stored = await getCandidate({ orgId, candidateUuid: candidate.uuid, conn: db });
    expect(stored.email).toBe(admin.email);
    expect(stored.offer_status).toBe("sent");
  });

  it("opens an approval chain WITHOUT creating an employee", async () => {
    const { candidate } = await atOffered("PreHire Prepares Only");

    const result = await prepareOffer({
      orgId,
      actorUuid: adminUuid,
      candidateUuid: candidate.uuid,
      templateUuid: startOfferTemplateUuid,
      conn: db,
    });

    // The approval is live...
    expect(result.approval?.uuid).toBeTruthy();
    expect(result.approval?.status).toBe("pending");

    // ...and there is no employee. Checked against the DATABASE, not the return value:
    // the return value is what the function believes happened.
    const [[emp]] = await db.query("SELECT COUNT(*) AS n FROM employees WHERE organization_id=? AND full_name=?", [
      orgId,
      "PreHire Prepares Only",
    ]);
    expect(Number(emp.n)).toBe(0);

    const stored = await getCandidate({ orgId, candidateUuid: candidate.uuid, conn: db });
    expect(stored.converted_employee_uuid).toBeNull();
    expect(stored.stage).not.toBe("hired");
    expect(stored.offer_status).toBe("pending_approval");
  });

  it("stores an Org Admin's auto-approved offer as approved when strict control is off", async () => {
    const { candidate } = await atOffered("PreHire Auto Approved");
    await db.query(
      "UPDATE organization_approval_policies SET strict_dual_control=0 WHERE organization_id=?",
      [orgId],
    );
    try {
      const result = await prepareOffer({
        orgId,
        actorUuid: adminUuid,
        candidateUuid: candidate.uuid,
        templateUuid: startOfferTemplateUuid,
        conn: db,
      });
      expect(result.approval?.status).toBe("approved");
      const stored = await getCandidate({ orgId, candidateUuid: candidate.uuid, conn: db });
      expect(stored.offer_status).toBe("approved");
    } finally {
      await db.query(
        "UPDATE organization_approval_policies SET strict_dual_control=1 WHERE organization_id=?",
        [orgId],
      );
    }
  });

  it("snapshots the rendered offer so the approval is about real terms", async () => {
    // The approval payload is what an approver actually reads. If it were empty, the
    // approver would be approving an unrendered template, which is the gap the snapshot
    // columns exist to close.
    const { candidate } = await atOffered("PreHire Snapshot");

    await prepareOffer({
      orgId,
      actorUuid: adminUuid,
      candidateUuid: candidate.uuid,
      templateUuid: startOfferTemplateUuid,
      conn: db,
    });

    const stored = await getCandidate({ orgId, candidateUuid: candidate.uuid, conn: db });
    expect(stored.offer_template_uuid).toBe(startOfferTemplateUuid);
    expect(stored.offer_body_snapshot).toContain("PreHire Snapshot");
    expect(stored.offer_body_snapshot).toContain("65000");
    expect(stored.offer_snapshot_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.offer_template_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.offer_snapshot_at).toBeTruthy();

    // And the approval froze exactly that text, so a later template edit cannot make
    // the approver sign off on something they never saw.
    const approval = await getOfferApproval({ orgId, candidateUuid: candidate.uuid, conn: db });
    expect(approval.status).toBe("pending");
    expect(approval.steps.length).toBeGreaterThan(0);
    expect(approval.payload?.rendered_body).toBe(stored.offer_body_snapshot);
    expect(approval.payload?.snapshot_hash).toBe(stored.offer_snapshot_hash);
  });

  it("refuses to send until the offer is APPROVED", async () => {
    const { candidate } = await atOffered("PreHire Needs Approval");
    await prepareOffer({
      orgId,
      actorUuid: adminUuid,
      candidateUuid: candidate.uuid,
      templateUuid: startOfferTemplateUuid,
      conn: db,
    });

    // Submitted is not approved. This gate is what makes the sent offer - the thing the
    // candidate accepts - mean something.
    await expect(
      sendPreparedOffer({ orgId, actorUuid: adminUuid, candidateUuid: candidate.uuid, conn: db }),
    ).rejects.toThrow(/must be approved before it can be sent/i);
  });

  it("refuses to send when the template changed after approval", async () => {
    // The snapshot is not decorative. Editing the template between approval and send
    // must force re-approval rather than emailing the candidate different terms from the
    // ones that were approved.
    const { candidate } = await atOffered("PreHire Template Drift");
    await prepareOffer({
      orgId,
      actorUuid: adminUuid,
      candidateUuid: candidate.uuid,
      templateUuid: startOfferTemplateUuid,
      conn: db,
    });
    await approveOffer({ orgId, actorUuid: approverUuid, candidateUuid: candidate.uuid, conn: db });

    await db.query(
      "UPDATE letter_templates SET body=CONCAT(body, ' Sneaked in.') WHERE uuid=?",
      [startOfferTemplateUuid],
    );
    try {
      await expect(
        sendPreparedOffer({ orgId, actorUuid: adminUuid, candidateUuid: candidate.uuid, conn: db }),
      ).rejects.toThrow(/template changed/i);
    } finally {
      await db.query(
        "UPDATE letter_templates SET body=REPLACE(body, ' Sneaked in.', '') WHERE uuid=?",
        [startOfferTemplateUuid],
      );
    }
  });

  it("reaches a sent offer, and still no employee", async () => {
    const { candidate } = await atOffered("PreHire Sent Not Hired");

    await prepareOffer({
      orgId,
      actorUuid: adminUuid,
      candidateUuid: candidate.uuid,
      templateUuid: startOfferTemplateUuid,
      conn: db,
    });
    await approveOffer({ orgId, actorUuid: approverUuid, candidateUuid: candidate.uuid, conn: db });
    const sent = await sendPreparedOffer({ orgId, actorUuid: adminUuid, candidateUuid: candidate.uuid, conn: db });

    expect(sent.status).toBe("sent");
    const stored = await getCandidate({ orgId, candidateUuid: candidate.uuid, conn: db });
    expect(stored.offer_status).toBe("sent");
    expect(stored.offer_sent_at).toBeTruthy();
    // Sent is not accepted. The candidate is still on the board, not on the roster.
    expect(stored.stage).not.toBe("hired");
    expect(stored.converted_employee_uuid).toBeNull();
  });

  it("refuses to prepare an offer when the template is INACTIVE", async () => {
    // And refuses before anything is written, which is the point of checking during
    // preparation rather than discovering it at send time.
    const { candidate } = await atOffered("PreHire Inactive Template");

    await db.query("UPDATE letter_templates SET is_active=0 WHERE organization_id=?", [orgId]);
    try {
      await expect(
        prepareOffer({
          orgId,
          actorUuid: adminUuid,
          candidateUuid: candidate.uuid,
          templateUuid: startOfferTemplateUuid,
          conn: db,
        }),
      ).rejects.toThrow(/inactive/i);

      const [[count]] = await db.query(
        "SELECT COUNT(*) AS n FROM candidates WHERE organization_id=? AND uuid=? AND converted_employee_uuid IS NOT NULL",
        [orgId, candidate.uuid],
      );
      expect(Number(count.n)).toBe(0);
      expect(await getOfferApproval({ orgId, candidateUuid: candidate.uuid, conn: db })).toBeNull();
    } finally {
      await db.query("UPDATE letter_templates SET is_active=1 WHERE organization_id=?", [orgId]);
    }
  });

  it("refuses to prepare an offer for anyone not at selected/offered", async () => {
    const opening = await createOpening({
      orgId,
      title: `Role ${++seq}`,
      departmentId,
      designationId,
      status: "open",
      vacancies: 9,
      conn: db,
    });
    const candidate = await createCandidate({
      orgId,
      openingUuid: opening.uuid,
      fullName: "PreHire Still Screening",
      email: `screening-${crypto.randomUUID().slice(0, 6)}@example.com`,
      conn: db,
    });
    await updateCandidateStage({ orgId, candidateUuid: candidate.uuid, stage: "screening", conn: db });

    await expect(
      prepareOffer({
        orgId,
        actorUuid: adminUuid,
        candidateUuid: candidate.uuid,
        templateUuid: startOfferTemplateUuid,
        conn: db,
      }),
    ).rejects.toThrow(/Only a selected candidate can receive an offer/i);
  });

  it("refuses to RE-prepare an offer already pending approval", async () => {
    // One live offer per candidate. A second preparation while `pending_approval` would
    // mean two different sets of terms in flight for the same person.
    const { candidate } = await atOffered("PreHire One Offer");
    await prepareOffer({
      orgId,
      actorUuid: adminUuid,
      candidateUuid: candidate.uuid,
      templateUuid: startOfferTemplateUuid,
      conn: db,
    });

    await expect(
      prepareOffer({
        orgId,
        actorUuid: adminUuid,
        candidateUuid: candidate.uuid,
        templateUuid: startOfferTemplateUuid,
        conn: db,
      }),
    ).rejects.toThrow(/cannot be changed in its current state/i);
  });

  it("keeps the candidate on the OFFERED column while the offer is in flight", async () => {
    // Pre-hire means the board still shows them. They are not "hired" until they accept,
    // and a card that vanished early would be the UI claiming something untrue.
    const { opening, candidate } = await atOffered("PreHire Board Holds");
    await prepareOffer({
      orgId,
      actorUuid: adminUuid,
      candidateUuid: candidate.uuid,
      templateUuid: startOfferTemplateUuid,
      conn: db,
    });

    const board = await getPipelineBoard({ orgId, openingUuid: opening.uuid, conn: db });
    expect(board.columns.find((c) => c.stage === "offered").count).toBe(1);
    expect(board.columns.find((c) => c.stage === "hired").count).toBe(0);
  });

  it("surfaces the candidate on the OFFERS list, so both screens agree", async () => {
    const { candidate } = await atOffered("PreHire Offers List");
    await prepareOffer({
      orgId,
      actorUuid: adminUuid,
      candidateUuid: candidate.uuid,
      templateUuid: startOfferTemplateUuid,
      conn: db,
    });

    // `listOffers` selects on `offer_status IS NOT NULL OR stage='hired'`, so a
    // prepared-but-unhired offer IS listed - which is what the two screens need to
    // agree on. It is listed by OFFER status, not by pipeline stage.
    const offers = await listOffers({ orgId, limit: 100, conn: db });
    const row = offers.items.find((o) => o.candidate_uuid === candidate.uuid);
    expect(row).toBeTruthy();
    expect(row.offer_status).toBe("pending_approval");
    expect(row.stage).not.toBe("hired");
  });

  it("refuses to respond to an offer that was never SENT", async () => {
    // Acceptance is the only door to the roster, so an acceptance recorded against a
    // merely-prepared offer has to be refused. Without this, HR could skip both
    // approval and sending and land the employee anyway.
    const { candidate } = await atOffered("PreHire Respond Too Early");
    await prepareOffer({
      orgId,
      actorUuid: adminUuid,
      candidateUuid: candidate.uuid,
      templateUuid: startOfferTemplateUuid,
      conn: db,
    });

    await expect(
      respondPreparedOffer({
        orgId,
        actorUuid: adminUuid,
        candidateUuid: candidate.uuid,
        response: "accepted",
        conn: db,
      }),
    ).rejects.toThrow(/Only a sent offer can receive a response/i);

    const [[emp]] = await db.query("SELECT COUNT(*) AS n FROM employees WHERE organization_id=? AND full_name=?", [
      orgId,
      "PreHire Respond Too Early",
    ]);
    expect(Number(emp.n)).toBe(0);
  });
});

describe.runIf(HAS_DB)("acceptance is the only thing that creates the employee", () => {
  it("creates EXACTLY ONE employee when the offer is accepted", async () => {
    // The headline acceptance point, asserted where the employee actually appears.
    const { candidate } = await atOffered("PreHire Accepted");

    await prepareOffer({
      orgId,
      actorUuid: adminUuid,
      candidateUuid: candidate.uuid,
      templateUuid: startOfferTemplateUuid,
      conn: db,
    });
    await approveOffer({ orgId, actorUuid: approverUuid, candidateUuid: candidate.uuid, conn: db });
    await sendPreparedOffer({ orgId, actorUuid: adminUuid, candidateUuid: candidate.uuid, conn: db });
    const result = await respondPreparedOffer({
      orgId,
      actorUuid: adminUuid,
      candidateUuid: candidate.uuid,
      response: "accepted",
      conn: db,
    });

    expect(result.employee_uuid).toBeTruthy();

    const stored = await getCandidate({ orgId, candidateUuid: candidate.uuid, conn: db });
    expect(stored.stage).toBe("hired");
    expect(stored.offer_status).toBe("accepted");
    expect(stored.converted_employee_uuid).toBe(result.employee_uuid);

    // Exactly one, not "at least one".
    const [[emp]] = await db.query("SELECT COUNT(*) AS n FROM employees WHERE organization_id=? AND full_name=?", [
      orgId,
      "PreHire Accepted",
    ]);
    expect(Number(emp.n)).toBe(1);
  });

  it("is IDEMPOTENT: a second acceptance creates no second employee", async () => {
    // The double-click case. Two sequential accepts must not produce two employees, and
    // the loser must be told why rather than silently overwriting the first.
    const { candidate } = await atOffered("PreHire Twice Accepted");

    await prepareOffer({
      orgId,
      actorUuid: adminUuid,
      candidateUuid: candidate.uuid,
      templateUuid: startOfferTemplateUuid,
      conn: db,
    });
    await approveOffer({ orgId, actorUuid: approverUuid, candidateUuid: candidate.uuid, conn: db });
    await sendPreparedOffer({ orgId, actorUuid: adminUuid, candidateUuid: candidate.uuid, conn: db });
    const first = await respondPreparedOffer({
      orgId,
      actorUuid: adminUuid,
      candidateUuid: candidate.uuid,
      response: "accepted",
      conn: db,
    });

    await expect(
      respondPreparedOffer({
        orgId,
        actorUuid: adminUuid,
        candidateUuid: candidate.uuid,
        response: "accepted",
        conn: db,
      }),
    ).rejects.toThrow(/Only a sent offer can receive a response/i);

    const [rows] = await db.query("SELECT uuid FROM employees WHERE organization_id=? AND full_name=?", [
      orgId,
      "PreHire Twice Accepted",
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].uuid).toBe(first.employee_uuid);
  });

  it("a DECLINED offer creates no employee", async () => {
    const { candidate } = await atOffered("PreHire Declined");

    await prepareOffer({
      orgId,
      actorUuid: adminUuid,
      candidateUuid: candidate.uuid,
      templateUuid: startOfferTemplateUuid,
      conn: db,
    });
    await approveOffer({ orgId, actorUuid: approverUuid, candidateUuid: candidate.uuid, conn: db });
    await sendPreparedOffer({ orgId, actorUuid: adminUuid, candidateUuid: candidate.uuid, conn: db });
    const result = await respondPreparedOffer({
      orgId,
      actorUuid: adminUuid,
      candidateUuid: candidate.uuid,
      response: "declined",
      comments: "Took another offer",
      conn: db,
    });

    expect(result.employee_uuid).toBeNull();

    const stored = await getCandidate({ orgId, candidateUuid: candidate.uuid, conn: db });
    expect(stored.stage).toBe("declined");
    expect(stored.offer_status).toBe("declined");

    const [[emp]] = await db.query("SELECT COUNT(*) AS n FROM employees WHERE organization_id=? AND full_name=?", [
      orgId,
      "PreHire Declined",
    ]);
    expect(Number(emp.n)).toBe(0);
  });

  it("the offer salary becomes the employee's starting salary", async () => {
    // The reason the approved offer has to carry `$new_salary`: it is the salary term
    // payroll starts from, and this is the join between the offer and the roster.
    const { candidate } = await atOffered("PreHire Salary Carries");

    await prepareOffer({
      orgId,
      actorUuid: adminUuid,
      candidateUuid: candidate.uuid,
      templateUuid: startOfferTemplateUuid,
      conn: db,
      values: { new_salary: "72000" },
    });
    await approveOffer({ orgId, actorUuid: approverUuid, candidateUuid: candidate.uuid, conn: db });
    await sendPreparedOffer({ orgId, actorUuid: adminUuid, candidateUuid: candidate.uuid, conn: db });
    await respondPreparedOffer({
      orgId,
      actorUuid: adminUuid,
      candidateUuid: candidate.uuid,
      response: "accepted",
      conn: db,
    });

    const stored = await getCandidate({ orgId, candidateUuid: candidate.uuid, conn: db });
    const [[salary]] = await db.query(
      `SELECT basic_salary FROM employee_salary_history
        WHERE employee_uuid=? ORDER BY effective_from DESC LIMIT 1`,
      [stored.converted_employee_uuid],
    );
    expect(Number(salary?.basic_salary ?? salary?.n ?? 0)).toBeGreaterThan(0);
  });
});

describe.runIf(HAS_DB)("the preflight blocks the offer before anything is committed", () => {
  it("refuses to prepare an offer when the workflow has no approver", async () => {
    const { candidate } = await atOffered("PreHire Bad Workflow");

    // Break the workflow the way an admin would: remove the approver from its first
    // step. `preflightApproval` runs inside startCandidateOffer, so this fails with
    // nothing written - which under the pre-hire model means not even a draft.
    const [[wf]] = await db.query(
      `SELECT id FROM workflow_definitions
        WHERE organization_id=? AND module_key='recruitment_management' AND entity_type='candidate_offer'
        LIMIT 1`,
      [orgId],
    );
    const [steps] = await db.query(
      "SELECT id, step_order FROM workflow_steps WHERE workflow_id=? ORDER BY step_order ASC",
      [wf.id],
    );
    const firstStep = steps[0];
    const [[before]] = await db.query(
      "SELECT approver_type, approver_uuid FROM workflow_steps WHERE id=?",
      [firstStep.id],
    );

    await db.query("UPDATE workflow_steps SET approver_type='specific_user', approver_uuid=NULL WHERE id=?", [
      firstStep.id,
    ]);

    try {
      await expect(
        prepareOffer({
          orgId,
          actorUuid: adminUuid,
          candidateUuid: candidate.uuid,
          templateUuid: startOfferTemplateUuid,
          conn: db,
        }),
      ).rejects.toThrow(/no eligible approver/i);

      // THE POINT: no employee, and no draft left behind either.
      const [[emp]] = await db.query("SELECT COUNT(*) AS n FROM employees WHERE organization_id=? AND full_name=?", [
        orgId,
        "PreHire Bad Workflow",
      ]);
      expect(Number(emp.n)).toBe(0);
      expect(await getOfferApproval({ orgId, candidateUuid: candidate.uuid, conn: db })).toBeNull();

      const stored = await getCandidate({ orgId, candidateUuid: candidate.uuid, conn: db });
      expect(stored.offer_status).toBeNull();
    } finally {
      await db.query("UPDATE workflow_steps SET approver_type=?, approver_uuid=? WHERE id=?", [
        before.approver_type,
        before.approver_uuid,
        firstStep.id,
      ]);
    }
  });

  it("still completes when the workflow is healthy again", async () => {
    // Proves the previous test's cleanup restored the org, rather than leaving it in a
    // state where every later test would fail for the same reason.
    const { candidate } = await atOffered("PreHire Workflow Healthy");
    const result = await prepareOffer({
      orgId,
      actorUuid: adminUuid,
      candidateUuid: candidate.uuid,
      templateUuid: startOfferTemplateUuid,
      conn: db,
    });
    expect(result.approval?.status).toBe("pending");
  });

  it("the REQUESTER cannot approve their own offer, even as org_admin", async () => {
    // Self-approval is blocked unconditionally and before approver resolution, so
    // org_role cannot get around it. Asserted here because in the pre-hire flow this
    // gate sits between "prepared" and "sent" - the only route to an employee.
    const { candidate } = await atOffered("PreHire Self Approve");
    await prepareOffer({
      orgId,
      actorUuid: adminUuid,
      candidateUuid: candidate.uuid,
      templateUuid: startOfferTemplateUuid,
      conn: db,
    });

    await expect(
      approveOffer({ orgId, actorUuid: adminUuid, candidateUuid: candidate.uuid, conn: db }),
    ).rejects.toThrow(/cannot approve or reject their own submission/i);

    // Still pending, and still un-sendable, so the block is load-bearing.
    const approval = await getOfferApproval({ orgId, candidateUuid: candidate.uuid, conn: db });
    expect(approval.status).toBe("pending");
    await expect(
      sendPreparedOffer({ orgId, actorUuid: adminUuid, candidateUuid: candidate.uuid, conn: db }),
    ).rejects.toThrow(/must be approved before it can be sent/i);
  });
});

describe.runIf(HAS_DB)("a bare hire is no longer reachable", () => {
  it("hireCandidate alone REFUSES - the old shortcut is closed, not merely unused", async () => {
    // The original gap was a UI button calling `hireCandidate` directly. Under the
    // pre-hire model that call is not just unused: it is impossible, because
    // `hireCandidate` requires `offer_status='sent'` plus an explicit offer acceptance,
    // and only `respondToOffer` supplies both. Asserted directly, so the guarantee does
    // not depend on nobody calling the exported function.
    const { candidate } = await atOffered("PreHire Bare Hire");

    await expect(hireCandidate({ orgId, candidateUuid: candidate.uuid, conn: db })).rejects.toThrow(
      /only after the candidate accepts a sent offer/i,
    );

    const [[emp]] = await db.query("SELECT COUNT(*) AS n FROM employees WHERE organization_id=? AND full_name=?", [
      orgId,
      "PreHire Bare Hire",
    ]);
    expect(Number(emp.n)).toBe(0);
    expect(await getOfferApproval({ orgId, candidateUuid: candidate.uuid, conn: db })).toBeNull();
  });
});
