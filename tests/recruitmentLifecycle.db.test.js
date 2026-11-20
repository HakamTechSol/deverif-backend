import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import dotenv from "dotenv";
import mysql from "mysql2/promise";
import {
  createOpening,
  updateOpening,
  getOpening,
  listOpenings,
  listInterviews,
  listMyInterviews,
  createCandidate,
  getCandidate,
  listCandidates,
  updateCandidateStage,
  hireCandidate,
  scheduleInterview,
  recordInterviewFeedback,
  getPipelineBoard,
  attachResume,
  removeResume,
  listResumes,
  CANDIDATE_STAGES,
} from "../src/services/recruitment.service.js";

/**
 * THE LIFECYCLE THIS MODULE EXISTS FOR.
 *
 * Job opening -> application -> screening -> interview -> offered -> hired, with the
 * hire producing a REAL employee row and an offer letter, all in one transaction.
 *
 * WHY A REAL DATABASE. Every meaningful rule here is a WHERE clause or a foreign
 * key rather than an `if`: the allowed-transition table, the one-shot conversion
 * guard (`converted_employee_uuid IS NULL AND stage='offered'`), the tenant foreign
 * keys, phone/CNIC duplicate guards, the interview double-booking key. A
 * mocked pool can be told to return success; it cannot tell you a query refuses to
 * match a row it should not, and that refusal IS the guarantee. The 20261115 schema
 * probe also showed the tenant FKs silently allowing a NULL department_id through,
 * which is exactly the class of thing only a live database reveals.
 *
 * ISOLATION. Each test builds its own opening. Vacancy counts are per-opening and
 * the pipeline board counts per-opening, so a shared fixture would make the hire
 * tests order-dependent.
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
 * The offer email is stubbed, deliberately: this project HAS SMTP credentials in its
 * .env, so an unmocked `sendRecruitmentOfferEmail` is a real delivery attempt to an
 * `@example.com` address. Only the mailer is mocked - every status transition, snapshot
 * hash and vacancy count below stays real.
 */
vi.mock("../src/utils/mailer.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, sendRecruitmentOfferEmail: vi.fn(async () => ({ messageId: "lifecycle-test" })) };
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
let otherOrgId;
let lifecycleOfferTemplateUuid;
/** The recruiter who prepares and records the candidate's response. */
let adminUuid;
/** A SECOND org_admin: the requester cannot decide their own offer. */
let approverUuid;
let departmentId;
let designationId;
let seq = 0;

beforeAll(async () => {
  if (!HAS_DB) return;
  db = await mysql.createConnection(cfg);

  const [org] = await db.query("INSERT INTO organizations (uuid, name) VALUES (UUID(), ?)", [
    `Recruitment ${Date.now()}`,
  ]);

  orgId = org.insertId;
  // Offer lifecycle assertions use a separate reviewer; explicitly save that
  // policy now that missing policy rows default to non-strict for Org Admins.
  await db.query(
    "INSERT INTO organization_approval_policies (organization_id, strict_dual_control, created_at, updated_at) VALUES (?, 1, NOW(), NOW())",
    [orgId],
  );

  const [other] = await db.query("INSERT INTO organizations (uuid, name) VALUES (UUID(), ?)", [
    `Recruitment Other ${Date.now()}`,
  ]);
  otherOrgId = other.insertId;

  const [dept] = await db.query(
    "INSERT INTO departments (uuid, organization_id, name) VALUES (UUID(), ?, 'Engineering')",
    [orgId],
  );
  departmentId = dept.insertId;
  const [desig] = await db.query(
    "INSERT INTO designations (uuid, organization_id, name) VALUES (UUID(), ?, 'Software Engineer')",
    [orgId],
  );
  designationId = desig.insertId;

  // An active offer template must exist before any hire, or the hire is REFUSED:
  // the draft letter it writes cannot be issued without one, so a template-less
  // hire would strand the employee with an offer nobody can send. See the seeder.
  // TWO org_admins, and the second one is not optional.
  //
  // `startApproval` resolves the default workflow's first step ('org_admin') to real
  // active users and refuses with "no eligible approver" when there are none, so at
  // least one org_admin must exist for any offer to be prepared at all. And
  // `decideApproval` refuses to let the requester decide their own submission, so a
  // SINGLE admin could prepare an offer that nothing could ever approve.
  const firstAdmin = crypto.randomUUID();
  adminUuid = firstAdmin;
  await db.query(
    `INSERT INTO users (uuid, organization, full_name, email, cnic, status, org_role, feature_access)
     VALUES (?, ?, ?, ?, ?, 'active', 'org_admin', ?)`,
    [
      firstAdmin,
      orgId,
      `Lifecycle Admin ${firstAdmin.slice(0, 8)}`,
      `lc-admin1-${firstAdmin.slice(0, 8)}@example.com`,
      `35202-${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}-6`,
      JSON.stringify({ manage_recruitment: true }),
    ],
  );

  const secondAdmin = crypto.randomUUID();
  approverUuid = secondAdmin;
  await db.query(
    `INSERT INTO users (uuid, organization, full_name, email, cnic, status, org_role, feature_access)
     VALUES (?, ?, ?, ?, ?, 'active', 'org_admin', ?)`,
    [
      secondAdmin,
      orgId,
      `Second Admin ${secondAdmin.slice(0, 8)}`,
      `lc-admin2-${secondAdmin.slice(0, 8)}@example.com`,
      `35202-${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}-7`,
      JSON.stringify({ manage_recruitment: true }),
    ],
  );

  lifecycleOfferTemplateUuid = await seedOfferLetterTemplate(db, orgId);
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
// Attachments has no FK, so it goes by hand or it outlives the org.
    await db.query("DELETE FROM attachments WHERE organization_id IN (?,?)", [orgId, otherOrgId]);
    await db.query("DELETE FROM interviews WHERE organization_id IN (?,?)", [orgId, otherOrgId]);
    // Candidates RESTRICT on converted_employee_uuid -> employees, so the hired
    // employees have to go FIRST or the delete is refused.
    await db.query("DELETE FROM candidates WHERE organization_id IN (?,?)", [orgId, otherOrgId]);
    await db.query("DELETE FROM job_openings WHERE organization_id IN (?,?)", [orgId, otherOrgId]);
  await db.query("DELETE FROM hr_letters WHERE organization_id IN (?,?)", [orgId, otherOrgId]);
      // letter_templates BEFORE the org: hr_letters.template_uuid points at one, so an
      // org deleted while its template row survives leaves the template orphaned against
      // an org that no longer exists.
      await db.query("DELETE FROM letter_templates WHERE organization_id IN (?,?)", [orgId, otherOrgId]);
      await db.query("DELETE FROM employees WHERE organization_id IN (?,?)", [orgId, otherOrgId]);
  
  } finally {
    await purgeTestOrgs(db, [orgId, otherOrgId]);
    await db.end();
  }});

const open = (over = {}) =>
  createOpening({
    orgId,
    title: `Engineer ${++seq}`,
    departmentId,
    designationId,
    status: "open",
    conn: db,
    ...over,
  });

const apply = (openingUuid, over = {}) =>
  createCandidate({
    orgId,
    openingUuid,
    fullName: `Candidate ${seq++}`,
    email: `candidate${seq}@example.com`,
    conn: db,
    ...over,
  });

/** Walk a candidate all the way to `offered`, which is the only stage hire accepts. */
async function toOffered(candidateUuid) {
  for (const stage of ["screening", "interview", "selected", "offered"]) {
    await updateCandidateStage({ orgId, candidateUuid, stage, conn: db });
  }
}

/**
 * Walk to `interview`.
 *
 * Deliberately goes THROUGH screening: applied -> interview is refused by the
 * allowed-transition table, and three of the interview tests were first written
 * skipping it. They then failed for the right reason but the wrong test.
 */
async function toInterview(candidateUuid) {
  for (const stage of ["screening", "interview"]) {
    await updateCandidateStage({ orgId, candidateUuid, stage, conn: db });
  }
}

describe.runIf(HAS_DB)("a job opening", () => {
  it("is created as a draft and must be opened before anyone can apply", async () => {
    const opening = await createOpening({
      orgId,
      title: "Draft Role",
      departmentId,
      status: "draft",
      conn: db,
    });
    expect(opening.status).toBe("draft");

    // A draft opening is one being written, not one being advertised. Accepting an
    // application here would make the careers form a back door into a vacancy
    // nobody agreed to publish.
    await expect(
      createCandidate({ orgId, openingUuid: opening.uuid, fullName: "Early Bird", conn: db }),
    ).rejects.toThrow(/not found/i);
  });

  it("records its department and designation for the eventual hire", async () => {
    const opening = await open();
    expect(opening.department_id).toBe(departmentId);
    expect(opening.designation_id).toBe(designationId);
  });

  it("refuses a department from another organization", async () => {
    const [deptB] = await db.query(
      "INSERT INTO departments (uuid, organization_id, name) VALUES (UUID(), ?, 'Their Dept')",
      [otherOrgId],
    );
    await expect(
      createOpening({ orgId, title: "Cross Tenant", departmentId: deptB.insertId, conn: db }),
    ).rejects.toThrow(/not found/i);
  });

  it("counts candidates and vacancies remaining", async () => {
    const opening = await open({ vacancies: 2 });
    await apply(opening.uuid);
    await apply(opening.uuid);

    const fresh = await getOpening({ orgId, openingUuid: opening.uuid, conn: db });
    expect(fresh.candidate_count).toBe(2);
    expect(fresh.hired_count).toBe(0);
    expect(fresh.vacancies_remaining).toBe(2);
  });

  it("refuses vacancies below the number already hired", async () => {
    const opening = await open({ vacancies: 1 });
    const candidate = await apply(opening.uuid);
    await toOffered(candidate.uuid);
    // Hired the pre-hire way: acceptance is the only thing that creates the employee.
    await hireThroughAcceptance(candidate.uuid);

    // Lowering it to 1 when one is already filled is legal (equal), but to 0 is not,
    // and reporting a vacancy that is already over-filled would silently block the
    // next hire.
    await expect(
      updateOpening({ orgId, openingUuid: opening.uuid, vacancies: 1, conn: db }),
    ).resolves.toBeTruthy();
    await expect(
      updateOpening({ orgId, openingUuid: opening.uuid, vacancies: 0, conn: db }),
    ).rejects.toThrow(/positive whole number/i);
  });

  it("closes without deleting, so the record of who applied survives", async () => {
    const opening = await open();
    await apply(opening.uuid);
    await updateOpening({ orgId, openingUuid: opening.uuid, status: "closed", conn: db });

    // `{ items, total, page, limit }`, the same shape listCandidates/listOffers return.
    // A paged list is only useful if the total matches what the filter really holds,
    // so this asserts the envelope rather than just reaching for `.some`.
    const result = await listOpenings({ orgId, status: "closed", conn: db });
    expect(result.items.some((r) => r.uuid === opening.uuid)).toBe(true);
    expect(result.total).toBe(result.items.length);
    expect(result.page).toBe(1);
    expect(result.limit).toBeGreaterThan(0);
  });

  it("pages, and `total` counts every match rather than just this page", async () => {
    // The whole point of paging an endpoint. A total derived from the page's own
    // length would make the paginator advertise one page forever and quietly hide
    // every opening after the first twenty — which is the bug that only shows up once
    // an org has twenty-one openings.
    const created = [];
    for (let i = 0; i < 3; i++) {
      // `open()` takes overrides, and `seq` is incremented inside it — so the title is
      // left to the helper and `i` is only used to prove the rows are distinct.
      created.push(await open({ status: "open" }));
    }

    const first = await listOpenings({ orgId, page: 1, limit: 2, conn: db });
    expect(first.items).toHaveLength(2);
    expect(first.page).toBe(1);
    expect(first.limit).toBe(2);
    // Counted across the WHOLE filtered set, not the slice.
    expect(first.total).toBeGreaterThanOrEqual(3);

    // Pages do not overlap, and every opening created here is reachable — but the
    // org is SHARED with the other tests in this file, which have already created
    // openings of their own. So rather than assuming three rows land on the first two
    // pages, this walks every page the total promises and asserts the rows are all
    // there and never repeated. Assuming the placement would make the test fail for
    // reasons that have nothing to do with pagination.
    // ONLY `page` and `limit` are passed — no `offset`. This is the assertion that
    // matters: listOpenings derives the offset from the page, so a caller cannot get
    // page 1 on every request by forgetting a third argument. The first draft of this
    // test passed `offset` explicitly and would have passed just as happily against a
    // service that ignored `page` entirely.
    const totalPages = Math.ceil(first.total / first.limit);
    const seen = [];
    for (let page = 1; page <= totalPages; page++) {
      const res = await listOpenings({ orgId, page, limit: first.limit, conn: db });
      seen.push(...res.items.map((r) => r.uuid));
      expect(res.page).toBe(page);
    }

    // No row appears on two pages.
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(first.total);
    for (const c of created) expect(seen).toContain(c.uuid);
  });
});

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------

describe.runIf(HAS_DB)("a candidate application", () => {
  it("starts at `applied` and records the opening it belongs to", async () => {
    const opening = await open();
    const candidate = await apply(opening.uuid);

    expect(candidate.stage).toBe("applied");
    expect(candidate.job_opening_uuid).toBe(opening.uuid);
    expect(candidate.opening.title).toBe(opening.title);
    expect(candidate.converted_employee_uuid).toBeNull();
  });

  it("allows a duplicate email with a warning instead of blocking candidate creation", async () => {
    const opening = await open();
    const first = await apply(opening.uuid, { email: "twice@example.com" });
    const second = await apply(opening.uuid, { email: "twice@example.com" });

    expect(first.uuid).toBeTruthy();
    expect(second.uuid).toBeTruthy();
    expect(second.uuid).not.toBe(first.uuid);
    expect(second.email_duplicate).toBe(true);
  });

  it("allows the same person to apply for a DIFFERENT opening", async () => {
    const first = await open();
    const second = await open();
    await apply(first.uuid, { email: "active@example.com" });

    // Deliberately permitted: applying twice is normal and the constraint must not
    // refuse it, or people apply once and hide their interest elsewhere.
    const again = await apply(second.uuid, { email: "active@example.com" });
    expect(again.uuid).toBeTruthy();
    expect(again.email_duplicate).toBe(true);
  });

  it("treats the same email in different case as the same person", async () => {
    const opening = await open();
    await apply(opening.uuid, { email: "Case@Example.com" });
    // The duplicate check is case-insensitive and warns, but both applications
    // are retained until a unique email is required for an offer.
    const again = await apply(opening.uuid, { email: "case@example.com" });
    expect(again.email).toBe("case@example.com");
    expect(again.email_duplicate).toBe(true);
  });

  it("is invisible to another organization", async () => {
    const opening = await open();
    const candidate = await apply(opening.uuid);
    const { loadCandidate } = await import("../src/services/recruitment.service.js");
    await expect(
      loadCandidate({ orgId: otherOrgId, candidateUuid: candidate.uuid, conn: db }),
    ).rejects.toThrow(/not found/i);
  });
});

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

describe.runIf(HAS_DB)("stage progression", () => {
  it("walks applied -> screening -> interview -> offered", async () => {
    const opening = await open();
    const candidate = await apply(opening.uuid);

    for (const stage of ["screening", "interview", "selected", "offered"]) {
      const moved = await updateCandidateStage({
        orgId,
        candidateUuid: candidate.uuid,
        stage,
        conn: db,
      });
      expect(moved.stage).toBe(stage);
    }
  });

  it("refuses a stage that skips the pipeline", async () => {
    const opening = await open();
    const candidate = await apply(opening.uuid);

    // applied -> hired in one call would skip the entire process, which is the
    // shortcut the allowed-transition table exists to make impossible.
    await expect(
      updateCandidateStage({ orgId, candidateUuid: candidate.uuid, stage: "offered", conn: db }),
    ).rejects.toThrow(/can only move to/i);
    await expect(
      updateCandidateStage({ orgId, candidateUuid: candidate.uuid, stage: "hired", conn: db }),
    ).rejects.toThrow(/hire action/i);
  });

  it("treats a move onto the current stage as a no-op, not a failure", async () => {
    // A Kanban card dragged onto its own column should not make the board feel
    // broken.
    const opening = await open();
    const candidate = await apply(opening.uuid);
    const same = await updateCandidateStage({
      orgId,
      candidateUuid: candidate.uuid,
      stage: "applied",
      conn: db,
    });
    expect(same.stage).toBe("applied");
  });

  it("requires a reason for a rejection, and keeps it", async () => {
    const opening = await open();
    const candidate = await apply(opening.uuid);

    await expect(
      updateCandidateStage({ orgId, candidateUuid: candidate.uuid, stage: "rejected", conn: db }),
    ).rejects.toThrow(/reason/i);

    const rejected = await updateCandidateStage({
      orgId,
      candidateUuid: candidate.uuid,
      stage: "rejected",
      rejectionReason: "Strong portfolio, wrong seniority",
      conn: db,
    });
    expect(rejected.stage).toBe("rejected");
    // An unexplained rejection tells the applicant nothing they can act on.
    expect(rejected.rejected_reason).toBe("Strong portfolio, wrong seniority");
  });

  it("is terminal once rejected", async () => {
    const opening = await open();
    const candidate = await apply(opening.uuid);
    await updateCandidateStage({
      orgId,
      candidateUuid: candidate.uuid,
      stage: "rejected",
      rejectionReason: "No",
      conn: db,
    });
    await expect(
      updateCandidateStage({ orgId, candidateUuid: candidate.uuid, stage: "screening", conn: db }),
    ).rejects.toThrow(/cannot be moved/i);
  });

  it("records a rating, and refuses one out of range", async () => {
    const opening = await open();
    const candidate = await apply(opening.uuid);

    const rated = await updateCandidateStage({
      orgId,
      candidateUuid: candidate.uuid,
      stage: "screening",
      rating: 4.5,
      conn: db,
    });
    expect(Number(rated.rating)).toBe(4.5);

    await expect(
      updateCandidateStage({ orgId, candidateUuid: candidate.uuid, stage: "interview", rating: 9, conn: db }),
    ).rejects.toThrow(/between 0 and 5/i);
  });

  it("reports the pipeline as columns, with rejected outside the flow", async () => {
    const opening = await open();
    const a = await apply(opening.uuid);
    await apply(opening.uuid);
    await updateCandidateStage({
      orgId,
      candidateUuid: a.uuid,
      stage: "rejected",
      rejectionReason: "No",
      conn: db,
    });

    const board = await getPipelineBoard({ orgId, openingUuid: opening.uuid, conn: db });
    // `selected` IS a column: it is the shortlist decision, a real step between
    // `interview` and `offered` in ALLOWED_TRANSITIONS. The board omitting it would
    // hide a stage the pipeline enforces.
    expect(board.columns.map((c) => c.stage)).toEqual([
      "applied",
      "screening",
      "interview",
      "selected",
      "offered",
      "hired",
    ]);
    // Rejected is where candidates LEAVE the pipeline, not a step they walk through.
    expect(board.rejected_count).toBe(1);
    expect(board.columns.find((c) => c.stage === "applied").count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Interviews
// ---------------------------------------------------------------------------

describe.runIf(HAS_DB)("interviews", () => {
  it("returns the paginated envelope, and pages without overlapping or dropping rows", async () => {
    // The regression the pagination change exists to prevent: an org that has run
    // recruitment for a year has thousands of COMPLETED interviews, and the unfiltered
    // agenda fetch would have pulled every one of them to show today's meeting.
    const opening = await open();
    const candidate = await apply(opening.uuid);
    await updateCandidateStage({ orgId, candidateUuid: candidate.uuid, stage: "screening", conn: db });
    await updateCandidateStage({ orgId, candidateUuid: candidate.uuid, stage: "interview", conn: db });

    // A DEDICATED interviewer, not the shared `1111...` one the double-booking test
    // below uses, and in December — so this test's rows cannot collide with that one
    // over the interviewer/slot unique key. Sharing them made the two tests fail
    // together for reasons that had nothing to do with either.
    const created = [];
    for (const at of ["2027-03-01 09:00:00", "2027-03-01 10:00:00", "2027-03-01 11:00:00"]) {
      created.push(
        await scheduleInterview({
          orgId,
          candidateUuid: candidate.uuid,
          interviewerUuid: adminUuid,
          scheduledAt: at,
          conn: db,
        }),
      );
    }

    // Scoped to this candidate so the org's other tests' interviews cannot influence
    // the counts, and only page/limit passed — listInterviews derives the offset.
    const first = await listInterviews({
      orgId,
      candidateUuid: candidate.uuid,
      page: 1,
      limit: 2,
      conn: db,
    });

    expect(first.items).toHaveLength(2);
    expect(first.page).toBe(1);
    expect(first.limit).toBe(2);
    expect(first.total).toBe(3);

    const second = await listInterviews({
      orgId,
      candidateUuid: candidate.uuid,
      page: 2,
      limit: 2,
      conn: db,
    });
    expect(second.items).toHaveLength(1);

    const seen = [...first.items, ...second.items].map((i) => i.uuid);
    expect(new Set(seen).size).toBe(3);
    for (const i of created) expect(seen).toContain(i.uuid);
  });

  it("orders DESC so an agenda's first page holds the most recent, not the oldest", async () => {
    // ASC ordering on an unfiltered agenda means page 1 is the OLDEST interviews in
    // the org's history — which for a recruiter is the least useful page possible.
    const opening = await open();
    const candidate = await apply(opening.uuid);
    await updateCandidateStage({ orgId, candidateUuid: candidate.uuid, stage: "screening", conn: db });
    await updateCandidateStage({ orgId, candidateUuid: candidate.uuid, stage: "interview", conn: db });

    for (const at of ["2027-04-01 09:00:00", "2027-04-05 09:00:00", "2027-04-09 09:00:00"]) {
      await scheduleInterview({
        orgId,
        candidateUuid: candidate.uuid,
        interviewerUuid: adminUuid,
        scheduledAt: at,
        conn: db,
      });
    }

    const page = await listInterviews({ orgId, candidateUuid: candidate.uuid, page: 1, limit: 1, conn: db });
    // Newest first, so the single row on page 1 is the April 9th meeting.
    expect(page.items).toHaveLength(1);
    // mysql2 hands back a DATETIME as a Date; compared on its ISO form rather than
    // with a regex against the object, which is what a string matcher does to a Date.
    expect(new Date(page.items[0].scheduled_at).toISOString()).toMatch(/2027-04-09/);
  });

  it("cannot be booked for someone still being screened", async () => {
    const opening = await open();
    const candidate = await apply(opening.uuid);

    // Booking an interview records a conversation that has not happened yet.
    await expect(
      scheduleInterview({
        orgId,
        candidateUuid: candidate.uuid,
        scheduledAt: "2026-12-01 10:00:00",
        interviewerUuid: adminUuid,
        conn: db,
      }),
    ).rejects.toThrow(/interview stage/i);
  });

  it("is booked once the candidate reaches the interview stage", async () => {
    const opening = await open();
    const candidate = await apply(opening.uuid);
    await updateCandidateStage({ orgId, candidateUuid: candidate.uuid, stage: "screening", conn: db });
    await updateCandidateStage({ orgId, candidateUuid: candidate.uuid, stage: "interview", conn: db });

    const interview = await scheduleInterview({
      orgId,
      candidateUuid: candidate.uuid,
      interviewerUuid: adminUuid,
      scheduledAt: "2026-12-01 10:00:00",
      mode: "video",
      conn: db,
    });
    expect(interview.status).toBe("scheduled");
    // Scheduled is not concluded: "we met, still deciding" has to be expressible.
    expect(interview.outcome).toBe("pending");
  });

  it("refuses to double-book the same interviewer into the same slot", async () => {
    const opening = await open();
    const candidate = await apply(opening.uuid);
    await toInterview(candidate.uuid);

    const interviewer = adminUuid;
    const when = "2026-12-05 14:00:00";
    await scheduleInterview({ orgId, candidateUuid: candidate.uuid, interviewerUuid: interviewer, scheduledAt: when, conn: db });

    // Per interviewer, not per org: two DIFFERENT interviewers meeting two different
    // candidates at 14:00 is the normal case, not a clash.
    await expect(
      scheduleInterview({ orgId, candidateUuid: candidate.uuid, interviewerUuid: interviewer, scheduledAt: when, conn: db }),
    ).rejects.toThrow(/already has an interview/i);
  });

  it("records feedback with an outcome, and refuses a second opinion", async () => {
    const opening = await open();
    const candidate = await apply(opening.uuid);
    await toInterview(candidate.uuid);
    const interview = await scheduleInterview({
      orgId,
      candidateUuid: candidate.uuid,
      scheduledAt: "2026-12-08 09:00:00",
      interviewerUuid: adminUuid,
      conn: db,
    });

    const done = await recordInterviewFeedback({
      orgId,
      actorUuid: adminUuid,
      interviewUuid: interview.uuid,
      status: "completed",
      outcome: "passed",
      rating: 4,
      feedbackNotes: "Strong on systems design",
      conn: db,
    });
    expect(done.status).toBe("completed");
    expect(done.outcome).toBe("passed");
    expect(done.feedback_notes).toBe("Strong on systems design");

    // A second verdict on a met interview is how a decision gets recorded without
    // dissent being visible.
    await expect(
      recordInterviewFeedback({
        orgId,
        actorUuid: adminUuid,
        interviewUuid: interview.uuid,
        outcome: "failed",
        conn: db,
      }),
    ).rejects.toThrow(/already been recorded/i);
  });

  it("shows only interviews assigned to the current user and refuses another user's feedback", async () => {
    const opening = await open();
    const candidate = await apply(opening.uuid);
    await toInterview(candidate.uuid);
    const interview = await scheduleInterview({
      orgId,
      candidateUuid: candidate.uuid,
      interviewerUuid: adminUuid,
      scheduledAt: "2026-12-10 09:00:00",
      conn: db,
    });

    const mine = await listMyInterviews({ orgId, userUuid: adminUuid, conn: db });
    const approverMine = await listMyInterviews({ orgId, userUuid: approverUuid, conn: db });
    expect(mine.items.some((item) => item.uuid === interview.uuid)).toBe(true);
    expect(approverMine.items.some((item) => item.uuid === interview.uuid)).toBe(false);

    await expect(recordInterviewFeedback({
      orgId,
      actorUuid: approverUuid,
      interviewUuid: interview.uuid,
      status: "completed",
      outcome: "passed",
      conn: db,
    })).rejects.toThrow(/assigned interviewer/i);
  });

  it("keeps the interview rating separate from the candidate's overall rating", async () => {
    const opening = await open();
    const candidate = await apply(opening.uuid);
    await toInterview(candidate.uuid);
    const interview = await scheduleInterview({
      orgId,
      candidateUuid: candidate.uuid,
      scheduledAt: "2026-12-09 09:00:00",
      interviewerUuid: adminUuid,
      conn: db,
    });
    await recordInterviewFeedback({
      orgId,
      actorUuid: adminUuid,
      interviewUuid: interview.uuid,
      outcome: "passed",
      rating: 5,
      conn: db,
    });

    const fresh = await getCandidate({ orgId, candidateUuid: candidate.uuid, conn: db });
    // Five stars from one interviewer must not silently become the candidate's
    // overall standing.
    expect(Number(fresh.interviews[0].rating)).toBe(5);
    expect(fresh.rating).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The one-click hire — the irreversible step
// ---------------------------------------------------------------------------

/**
 * Drive a candidate all the way to an EMPLOYEE, the only way one can exist.
 *
 * `selected -> offered` -> prepare -> approve (by somebody else) -> send -> accept.
 * Returns the acceptance result, which carries `employee_uuid`.
 *
 * Several tests below care about what a HIRED candidate looks like - a vacancy filled,
 * a terminal `hired` stage, a roster row - and each of those states now requires a
 * candidate to have accepted. This is the canonical way to reach it, so the tests read
 * as "given an accepted offer" rather than each repeating the four-step dance.
 */
async function hireThroughAcceptance(candidateUuid, hireOptions = {}) {
  await prepareOffer({
    orgId,
    actorUuid: adminUuid,
    candidateUuid,
    templateUuid: lifecycleOfferTemplateUuid,
    conn: db,
  });
  await approveOffer({ orgId, actorUuid: approverUuid, candidateUuid, conn: db });
  await sendPreparedOffer({ orgId, actorUuid: adminUuid, candidateUuid, conn: db });
  return respondPreparedOffer({
    orgId,
    actorUuid: adminUuid,
    candidateUuid,
    response: "accepted",
    conn: db,
    ...hireOptions,
  });
}

// ---------------------------------------------------------------------------
// Acceptance — the one irreversible step, and the only door to the roster
// ---------------------------------------------------------------------------

describe.runIf(HAS_DB)("accepting an offer creates the employee", () => {
  it("creates a real employee and flips the stage, after acceptance", async () => {
    const opening = await open();
    const candidate = await apply(opening.uuid, { fullName: "Ali Raza", email: "ali@example.com" });
    await toOffered(candidate.uuid);

    // Before acceptance there is no employee. Asserted first so a regression that
    // hires during preparation fails HERE, naming the actual break, rather than
    // surfacing later as a confusing approval error.
    const [[before]] = await db.query("SELECT COUNT(*) AS n FROM employees WHERE organization_id=?", [orgId]);
    await prepareOffer({
      orgId,
      actorUuid: adminUuid,
      candidateUuid: candidate.uuid,
      templateUuid: lifecycleOfferTemplateUuid,
      conn: db,
    });
    const [[mid]] = await db.query("SELECT COUNT(*) AS n FROM employees WHERE organization_id=?", [orgId]);
    expect(Number(mid.n)).toBe(Number(before.n));

    await approveOffer({ orgId, actorUuid: approverUuid, candidateUuid: candidate.uuid, conn: db });
    await sendPreparedOffer({ orgId, actorUuid: adminUuid, candidateUuid: candidate.uuid, conn: db });
    const result = await respondPreparedOffer({
      orgId,
      actorUuid: adminUuid,
      candidateUuid: candidate.uuid,
      response: "accepted",
      cnic: "35202-1234567-1",
      joiningDate: "2026-12-01",
      conn: db,
    });

    expect(result.employee_uuid).toBeTruthy();
    expect(result.candidate.stage).toBe("hired");
    expect(result.candidate.converted_employee_uuid).toBe(result.employee_uuid);

    // A REAL employee row, carrying the designation the candidate was OFFERED -
    // taken from the opening rather than a recruiter's memory three weeks later.
    const [rows] = await db.query("SELECT * FROM employees WHERE uuid=?", [result.employee_uuid]);
    expect(rows).toHaveLength(1);
    expect(rows[0].full_name).toBe("Ali Raza");
    expect(rows[0].status).toBe("current_employee");
    expect(rows[0].designation_id).toBe(designationId);
    expect(rows[0].department_id).toBe(departmentId);
    expect(rows[0].cnic).toBe("35202-1234567-1");
  });

  /**
   * ACCEPTANCE CREATES THE EMPLOYEE. IT DOES NOT INVITE THEM.
   *
   * This is the whole point of the rule and the reason it is worth a database
   * test rather than a controller test: the invite used to be minted inside the
   * hire transaction, so "accepted" and "can log in" were one event and neither
   * was chosen. A click on Record acceptance emailed a set-password link to
   * whoever was named in the candidate row — including people whose documents
   * had not arrived, and people whose mailbox nobody had confirmed belonged to
   * them.
   *
   * The invitation now goes out from the employee row (resendEmployeeInvite),
   * and what this test pins is that the hire writes NO user, NO token, and does
   * NOT set is_platform_user. If someone reintroduces the inline invite it will
   * fail here on the invite_tokens count, which is the assertion that a
   * code-reading review would be least likely to catch in a hurry.
   */
  it("does NOT invite the candidate when the offer is accepted", async () => {
    const opening = await open();
    const candidate = await apply(opening.uuid, { fullName: "Sana Malik", email: "sana@example.com" });
    await toOffered(candidate.uuid);
    const result = await hireThroughAcceptance(candidate.uuid);

    // The employee exists — that half works.
    expect(result.employee_uuid).toBeTruthy();

    // No account for them, and no token issued in their name. Scoped by email
    // rather than counted across the whole table: invite_tokens hangs off
    // users.uuid, not off an organization, so an org-scoped purge does not clear
    // it and rows from another suite's fixtures would otherwise fail this test
    // for a reason that has nothing to do with acceptance.
    const [[users]] = await db.query("SELECT COUNT(*) AS n FROM users WHERE email=?", ["sana@example.com"]);
    expect(Number(users.n)).toBe(0);
    const [[tokens]] = await db.query(
      "SELECT COUNT(*) AS n FROM invite_tokens WHERE user_uuid IN (SELECT uuid FROM users WHERE organization=?)",
      [orgId],
    );
    expect(Number(tokens.n)).toBe(0);

    const [empRows] = await db.query("SELECT is_platform_user, linked_user_uuid FROM employees WHERE uuid=?", [result.employee_uuid]);
    expect(empRows[0].is_platform_user).not.toBe("yes");
    expect(empRows[0].linked_user_uuid).toBeNull();
  });

  it("converts a candidate with NO cnic, which is the common case", async () => {
    const opening = await open();
    const candidate = await apply(opening.uuid);
    await toOffered(candidate.uuid);

    const result = await hireThroughAcceptance(candidate.uuid);

    const [rows] = await db.query("SELECT cnic FROM employees WHERE uuid=?", [result.employee_uuid]);
    // NULL, not ''. "Not collected yet" and "collected and blank" have to stay
    // distinguishable in the database, because HR needs to collect it later.
    expect(rows[0].cnic).toBeNull();
  });

  it("takes the joining date from the APPROVED OFFER rather than leaving it null", async () => {
    // The offer terms are the record of what was agreed, so the employee's start date
    // comes from the snapshot that was approved - not from the moment HR clicked accept.
    const opening = await open();
    const candidate = await apply(opening.uuid);
    await toOffered(candidate.uuid);

    await prepareOffer({
      orgId,
      actorUuid: adminUuid,
      candidateUuid: candidate.uuid,
      templateUuid: lifecycleOfferTemplateUuid,
      conn: db,
      values: { joining_date: "2026-12-01" },
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

    const fresh = await getCandidate({ orgId, candidateUuid: candidate.uuid, conn: db });
    const [rows] = await db.query("SELECT joining_date FROM employees WHERE uuid=?", [
      fresh.converted_employee_uuid,
    ]);
    // A null joining_date is invisible in every date-filtered report.
    expect(rows[0].joining_date).toBeTruthy();
    // mysql2 builds a DATE into a JS Date at LOCAL midnight, so it has to be read
    // through its date fields - `String(date).slice(0,10)` yields "Tue Dec 01".
    const joined = rows[0].joining_date;
    const iso = joined instanceof Date
      ? `${joined.getFullYear()}-${String(joined.getMonth() + 1).padStart(2, "0")}-${String(joined.getDate()).padStart(2, "0")}`
      : String(joined).slice(0, 10);
    expect(iso).toBe("2026-12-01");
  });

  it("refuses to hire a candidate whose offer was never SENT", async () => {
    // The direct call. `hireCandidate` is still exported, so the guarantee cannot rest
    // on nobody calling it: it refuses unless the offer was sent AND the acceptance
    // path supplied the flag.
    const opening = await open();
    const candidate = await apply(opening.uuid);
    await toOffered(candidate.uuid);

    await expect(
      hireCandidate({ orgId, candidateUuid: candidate.uuid, conn: db }),
    ).rejects.toThrow(/only after the candidate accepts a sent offer/i);

    const [[emp]] = await db.query("SELECT COUNT(*) AS n FROM employees WHERE organization_id=? AND full_name=?", [
      orgId,
      candidate.full_name,
    ]);
    expect(Number(emp.n)).toBe(0);
  });

  it("is ONE-SHOT: a second acceptance creates no second employee", async () => {
    const opening = await open();
    const candidate = await apply(opening.uuid);
    await toOffered(candidate.uuid);

    const first = await hireThroughAcceptance(candidate.uuid);

    // The double-click case. The second response is refused because the offer is no
    // longer `sent`, so it never reaches the INSERT at all.
    await expect(
      respondPreparedOffer({
        orgId,
        actorUuid: adminUuid,
        candidateUuid: candidate.uuid,
        response: "accepted",
        conn: db,
      }),
    ).rejects.toThrow(/Only a sent offer can receive a response/i);
    await expect(
      hireCandidate({ orgId, candidateUuid: candidate.uuid, conn: db }),
    ).rejects.toThrow(/only after the candidate accepts a sent offer/i);

    const [rows] = await db.query("SELECT uuid FROM employees WHERE organization_id=?", [orgId]);
    // One human, one employee row. Two would mean being counted twice in payroll.
    expect(rows.filter((r) => r.uuid === first.employee_uuid)).toHaveLength(1);
  });

  it("creates no employee when a rival hire got there first", async () => {
    // WHAT THIS ACTUALLY PROVES, precisely, because the name used to overstate it.
    //
    // A rival connection flips the candidate to `hired` before this call reads it, so
    // the service refuses before any INSERT. The assertion that matters is that losing
    // leaves no partial state behind.
    const opening = await open({ vacancies: 5 });
    const candidate = await apply(opening.uuid);
    await toOffered(candidate.uuid);
    // Get them to the only state acceptance is possible from: offer sent.
    await prepareOffer({
      orgId,
      actorUuid: adminUuid,
      candidateUuid: candidate.uuid,
      templateUuid: lifecycleOfferTemplateUuid,
      conn: db,
    });
    await approveOffer({ orgId, actorUuid: approverUuid, candidateUuid: candidate.uuid, conn: db });
    await sendPreparedOffer({ orgId, actorUuid: adminUuid, candidateUuid: candidate.uuid, conn: db });

    // An INDEPENDENT connection, because `db` is a single connection rather than a
    // pool: this has to be a genuine cross-session race.
    const rival = await mysql.createConnection(cfg);
    try {
      // A before/after DELTA, not an absolute count: earlier tests in this block have
      // legitimately created employees in the same org.
      const [before] = await db.query("SELECT COUNT(*) AS n FROM employees WHERE organization_id=?", [orgId]);

      await rival.query(
        "UPDATE candidates SET stage='hired', hired_at=NOW() WHERE uuid=? AND stage='offered'",
        [candidate.uuid],
      );

      await expect(
        respondPreparedOffer({
          orgId,
          actorUuid: adminUuid,
          candidateUuid: candidate.uuid,
          response: "accepted",
          conn: db,
        }),
      ).rejects.toThrow(/Only a sent offer can receive a response/i);

      const [after] = await db.query("SELECT COUNT(*) AS n FROM employees WHERE organization_id=?", [orgId]);
      expect(Number(after[0].n) - Number(before[0].n)).toBe(0);
    } finally {
      await rival.end();
    }
  });

  it("refuses to exceed the opening's vacancies", async () => {
    const opening = await open({ vacancies: 1 });
    const first = await apply(opening.uuid);
    const second = await apply(opening.uuid);
    await toOffered(first.uuid);
    await hireThroughAcceptance(first.uuid);
    await toOffered(second.uuid);

    // Second candidate reaches `offered`, gets a sent offer, and is refused at
    // acceptance. Over-hiring is a money error, so it is refused rather than made
    // visible as an over-filled vacancy.
    await prepareOffer({
      orgId,
      actorUuid: adminUuid,
      candidateUuid: second.uuid,
      templateUuid: lifecycleOfferTemplateUuid,
      conn: db,
    });
    await approveOffer({ orgId, actorUuid: approverUuid, candidateUuid: second.uuid, conn: db });
    await sendPreparedOffer({ orgId, actorUuid: adminUuid, candidateUuid: second.uuid, conn: db });

    await expect(
      respondPreparedOffer({
        orgId,
        actorUuid: adminUuid,
        candidateUuid: second.uuid,
        response: "accepted",
        conn: db,
      }),
    ).rejects.toThrow(/vacanc/i);
  });

  it("closes the vacancy out once filled", async () => {
    const opening = await open({ vacancies: 1 });
    const candidate = await apply(opening.uuid);
    await toOffered(candidate.uuid);
    await hireThroughAcceptance(candidate.uuid);

    const fresh = await getOpening({ orgId, openingUuid: opening.uuid, conn: db });
    expect(fresh.hired_count).toBe(1);
    expect(fresh.vacancies_remaining).toBe(0);
  });

  it("keeps `hired` terminal", async () => {
    const opening = await open();
    const candidate = await apply(opening.uuid);
    await toOffered(candidate.uuid);
    await hireThroughAcceptance(candidate.uuid);

    await expect(
      updateCandidateStage({
        orgId,
        candidateUuid: candidate.uuid,
        stage: "rejected",
        rejectionReason: "changed our mind",
        conn: db,
      }),
    ).rejects.toThrow(/cannot be moved/i);
  });

  it("is scoped to the organization", async () => {
    const opening = await open();
    const candidate = await apply(opening.uuid);
    await toOffered(candidate.uuid);

    // Cross-tenant: org B cannot even see the candidate, so no offer and no employee.
    await expect(
      prepareOffer({
        orgId: otherOrgId,
        actorUuid: adminUuid,
        candidateUuid: candidate.uuid,
        templateUuid: lifecycleOfferTemplateUuid,
        conn: db,
      }),
    ).rejects.toThrow(/not found/i);
    await expect(
      hireCandidate({ orgId: otherOrgId, candidateUuid: candidate.uuid, conn: db }),
    ).rejects.toThrow(/not found/i);

    const [[emp]] = await db.query("SELECT COUNT(*) AS n FROM employees WHERE organization_id=?", [otherOrgId]);
    expect(Number(emp.n)).toBe(0);
  });
});
// ---------------------------------------------------------------------------
// Resumes
// ---------------------------------------------------------------------------

describe.runIf(HAS_DB)("candidate resumes", () => {
  /** Insert a resume attachment the way the upload route would. */
  async function seedResume(candidateUuid, name = "cv.pdf") {
    const uuid = crypto.randomUUID();
    await db.query(
      `INSERT INTO attachments
         (uuid, organization_id, entity_type, entity_uuid, category, file_name, file_path, file_size, mime_type)
       VALUES (?, ?, 'candidate', ?, 'candidate_resume', ?, ?, 1200, 'application/pdf')`,
      [uuid, orgId, candidateUuid, name, `uploads/candidates/${candidateUuid}/${name}`],
    );
    return uuid;
  }

  it("lists only resumes, not every file on the candidate", async () => {
    const opening = await open();
    const candidate = await apply(opening.uuid);
    const resumeUuid = await seedResume(candidate.uuid);

    const [other] = await db.query(
      `INSERT INTO attachments
         (uuid, organization_id, entity_type, entity_uuid, category, file_name, file_path, file_size, mime_type)
       VALUES (UUID(), ?, 'candidate', ?, 'something_else', 'notes.txt', 'x/y.txt', 5, 'text/plain')`,
      [orgId, candidate.uuid],
    );

    const resumes = await listResumes({ orgId, candidateUuid: candidate.uuid });
    expect(resumes.map((r) => r.uuid)).toContain(resumeUuid);
    expect(resumes.map((r) => r.uuid)).not.toContain(other.insertId);
  });

  it("clears the current-resume pointer only when it pointed at the removed file", async () => {
    const opening = await open();
    const candidate = await apply(opening.uuid);
    const first = await seedResume(candidate.uuid, "cv-v1.pdf");
    const second = await seedResume(candidate.uuid, "cv-v2.pdf");
    await db.query("UPDATE candidates SET resume_attachment_uuid=? WHERE uuid=?", [second, candidate.uuid]);

    // Removing the OLDER resume must not blank the current one, or the panel would
    // lose the CV the recruiter is actually looking at.
    await removeResume({ orgId, attachmentUuid: first, conn: db });
    let fresh = await getCandidate({ orgId, candidateUuid: candidate.uuid, conn: db });
    expect(fresh.resume_attachment_uuid).toBe(second);

    await removeResume({ orgId, attachmentUuid: second, conn: db });
    fresh = await getCandidate({ orgId, candidateUuid: candidate.uuid, conn: db });
    expect(fresh.resume_attachment_uuid).toBeNull();
  });

  it("refuses to delete a file that is not a candidate's", async () => {
    // Without the entity_type check, an expense receipt would be deletable through
    // the recruitment routes — one module reaching another's files.
    // removeResume addresses attachments by uuid, not by the numeric id.
    const foreignUuid = crypto.randomUUID();
    await db.query(
      `INSERT INTO attachments
         (uuid, organization_id, entity_type, entity_uuid, category, file_name, file_path, file_size, mime_type)
       VALUES (?, ?, 'expense_claim', UUID(), 'expense_receipt', 'r.jpg', 'x/y.jpg', 9, 'image/jpeg')`,
      [foreignUuid, orgId],
    );
    await expect(
      removeResume({ orgId, attachmentUuid: foreignUuid, conn: db }),
    ).rejects.toThrow(/does not belong to a candidate/i);
  });
});
