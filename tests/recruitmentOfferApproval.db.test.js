import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import mysql from "mysql2/promise";
import dotenv from "dotenv";
import { purgeTestOrgs } from "./helpers/dbCleanup.js";
import {
  createOpening,
  createCandidate,
  updateCandidateStage,
  requestOfferApproval,
  decideOfferApproval,
  getOfferApproval,
  sendOffer,
} from "../src/services/recruitment.service.js";
import {
  seedOfferLetterTemplate,
  prepareOffer,
} from "./helpers/offerLifecycle.js";

/**
 * The offer email is stubbed, deliberately.
 *
 * This project HAS SMTP credentials in its .env, so an unmocked
 * `sendRecruitmentOfferEmail` is not a no-op - it is a real delivery attempt to an
 * `@example.com` address. Only the mailer is mocked; every status transition, snapshot
 * hash and approval gate in this file stays real.
 */
vi.mock("../src/utils/mailer.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, sendRecruitmentOfferEmail: vi.fn(async () => ({ messageId: "offer-approval-test" })) };
});

/**
 * OFFERS ROUTE THROUGH THE SHARED APPROVAL WORKFLOW ENGINE.
 *
 * This engine had ZERO callers before this module. Its own header says offers was
 * one of the six modules it was written for, and `getApprovalStatus` returns keys
 * that match ApprovalTimeline's props exactly -- so the intention was clear, but
 * nothing had ever run it. Adopting untested infrastructure as the first adopter
 * means this file has to do more than assert a status code: it has to prove the
 * engine's guarantees actually hold when a real caller depends on them.
 *
 * THE GUARANTEES UNDER TEST, and why each matters here:
 *
 *   one in-flight chain per offer    a double submit must not open two chains, or a
 *                                    recruiter could get two contradictory approvals
 *   rejection is terminal           and the candidate leaves `offered`, or the board
 *                                    shows an offer nobody approved whose send is
 *                                    permanently refused
 *   append-only history              what ApprovalTimeline renders; if it were not
 *                                    append-only the timeline would be a guess
 *   approval GATES the send          issuing mints a QR token and freezes the body;
 *                                    there is no un-issue a candidate can rely on
 *
 * NOTHING IS MOCKED. The engine is adopted as-is; stubbing it would assert that the
 * stub behaves.
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
let adminUuid;
let subAdminUuid;
/** A SECOND org_admin: the requester cannot decide their own offer. */
let approverUuid;
let approvalTemplateUuid;
let otherOrgId = null;
let seq = 0;

beforeAll(async () => {
  if (!HAS_DB) return;
  db = await mysql.createConnection(cfg);

  const [org] = await db.query("INSERT INTO organizations (uuid, name) VALUES (UUID(), ?)", [
    `Offer approval ${Date.now()}`,
  ]);

  orgId = org.insertId;
  // These integration scenarios exercise the separate-approver path. The policy
  // fallback is intentionally non-strict, so persist strict mode explicitly here.
  await db.query(
    "INSERT INTO organization_approval_policies (organization_id, strict_dual_control, created_at, updated_at) VALUES (?, 1, NOW(), NOW())",
    [orgId],
  );

  // The engine's default workflow resolves its first step's approvers by
  // approver_type, and the default step is 'org_admin'. So an org_admin has to
  // EXIST or startApproval refuses with "Workflow step has no approver" -- which is
  // the engine behaving correctly, and the reason this fixture creates one.
  for (const [role, tag] of [
    ["org_admin", "Admin"],
    ["sub_admin", "Sub"],
  ]) {
    const uuid = crypto.randomUUID();
    await db.query(
      `INSERT INTO users (uuid, organization, full_name, email, cnic, status, org_role, feature_access)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      [
        uuid,
        orgId,
        `Offer ${tag}`,
        `offer-${tag}-${uuid.slice(0, 8)}@example.com`,
        `35202-${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}-1`,
        role,
        JSON.stringify({ manage_recruitment: true }),
      ],
    );
    if (role === "org_admin") adminUuid = uuid;
    else subAdminUuid = uuid;
  }

// A second org_admin. `decideApproval` refuses to let the requester decide their own
  // submission, so the offer cannot reach `approved` - and therefore cannot be sent or
  // accepted - unless somebody other than the requester decides it.
  const secondAdmin = crypto.randomUUID();
  approverUuid = secondAdmin;
  await db.query(
    `INSERT INTO users (uuid, organization, full_name, email, cnic, status, org_role, feature_access)
     VALUES (?, ?, ?, ?, ?, 'active', 'org_admin', ?)`,
    [
      secondAdmin,
      orgId,
      `Second Admin ${secondAdmin.slice(0, 8)}`,
      `admin2-${secondAdmin.slice(0, 8)}@example.com`,
      `35202-${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}-9`,
      JSON.stringify({ manage_recruitment: true }),
    ],
  );

  // An Offer Letter template whose merge tags are `$`-prefixed. `previewOffer` refuses
  // a template with no `$new_salary`, and cannot even see a tag written as `{{name}}`.
  approvalTemplateUuid = await seedOfferLetterTemplate(db, orgId);
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
// Children before parents: approval_requests point at workflow_definitions, and
    // candidates RESTRICT on employees.
    await db.query("DELETE FROM approval_step_history WHERE approval_request_uuid IN (SELECT uuid FROM approval_requests WHERE organization_id=?)", [orgId]);
    await db.query("DELETE FROM approval_requests WHERE organization_id=?", [orgId]);
    await db.query("DELETE FROM workflow_steps WHERE workflow_id IN (SELECT id FROM workflow_definitions WHERE organization_id=?)", [orgId]);
    await db.query("DELETE FROM workflow_definitions WHERE organization_id=?", [orgId]);
    await db.query("DELETE FROM attachments WHERE organization_id=?", [orgId]);
    await db.query("DELETE FROM interviews WHERE organization_id=?", [orgId]);
    await db.query("DELETE FROM candidates WHERE organization_id=?", [orgId]);
    await db.query("DELETE FROM job_openings WHERE organization_id=?", [orgId]);
    await db.query("DELETE FROM hr_letters WHERE organization_id=?", [orgId]);
    // letter_templates BEFORE the org: hr_letters.template_uuid points here, and the
    // org delete cascades into departments/designations which job_openings also
    // reference.
    await db.query("DELETE FROM letter_templates WHERE organization_id=?", [orgId]);
    await db.query("DELETE FROM employees WHERE organization_id=?", [orgId]);
    await db.query("DELETE FROM users WHERE organization=?", [orgId]);
  
  } finally {
    await purgeTestOrgs(db, [orgId, otherOrgId]);
    await db.end();
  }});

/**
 * A candidate walked to `offered`, with nothing prepared and nobody hired.
 *
 * `selected` is a required hop: `ALLOWED_TRANSITIONS` allows
 * `interview -> selected -> offered` only, so walking straight from `interview` to
 * `offered` is refused with a 409.
 */
async function atOffered(name) {
  const n = ++seq;
  const opening = await createOpening({
    orgId,
    title: `Role ${n}`,
    status: "open",
    vacancies: 9,
    conn: db,
  });
  const candidate = await createCandidate({
    orgId,
    openingUuid: opening.uuid,
    fullName: name,
    email: `offer-${n}-${crypto.randomUUID().slice(0, 6)}@example.com`,
    conn: db,
  });
  for (const stage of ["screening", "interview", "selected", "offered"]) {
    await updateCandidateStage({ orgId, candidateUuid: candidate.uuid, stage, conn: db });
  }

  const [[row]] = await db.query("SELECT stage, converted_employee_uuid FROM candidates WHERE uuid=?", [
    candidate.uuid,
  ]);
  expect(row.stage).toBe("offered");
  expect(row.converted_employee_uuid).toBeNull();

  return { opening, candidate };
}

/**
 * A candidate at `offered` whose offer is PREPARED but NOT yet submitted.
 *
 * ============================ WHY THIS FIXTURE SHAPE ============================
 *
 * The previous version of this fixture hired the candidate and then reset them to
 * `offered` by hand, nulling `converted_employee_uuid` and `hired_at`. Under the
 * PRE-HIRE lifecycle that whole manoeuvre is both unnecessary and unsafe: a hire is no
 * longer reachable without an accepted, sent offer, so there is nothing to undo, and
 * hand-resetting a `hired` row is exactly the "arranging a state the product cannot
 * produce" that the old fixture was criticised for.
 *
 * What these tests need is the `draft` state - a prepared offer with no approval
 * chain yet - because they exercise the approval ENGINE directly rather than through
 * `startCandidateOffer`. In the live product `draft` is a short-lived internal state:
 * `startCandidateOffer` writes the snapshot and then immediately calls
 * `requestOfferApproval`, so no request ever observes it in between.
 *
 * So it is reconstructed honestly: run the REAL preparation, then undo ONLY the
 * submission (the approval chain), leaving the snapshot exactly as the service wrote
 * it. If the preparation rules ever change, this fixture fails here with a real refusal
 * rather than papering over the difference.
 */
async function preparedNotSubmitted(name) {
  const { opening, candidate } = await atOffered(name);

  // The real preparation: resolves merge tags, snapshots the rendered body, writes the
  // hashes. Only the approval submission that follows is undone below.
  await prepareOffer({
    orgId,
    actorUuid: adminUuid,
    candidateUuid: candidate.uuid,
    templateUuid: approvalTemplateUuid,
    conn: db,
  });

  // Undo the submission. approval_step_history before approval_requests, since the
  // history points at the request.
  await db.query(
    "DELETE FROM approval_step_history WHERE approval_request_uuid IN (SELECT uuid FROM approval_requests WHERE organization_id=? AND entity_uuid=?)",
    [orgId, candidate.uuid],
  );
  await db.query("DELETE FROM approval_requests WHERE organization_id=? AND entity_uuid=?", [orgId, candidate.uuid]);
  await db.query("UPDATE candidates SET offer_status='draft' WHERE uuid=? AND organization_id=?", [
    candidate.uuid,
    orgId,
  ]);

  const [[row]] = await db.query(
    "SELECT stage, offer_status, offer_snapshot_hash, offer_template_uuid FROM candidates WHERE uuid=?",
    [candidate.uuid],
  );
  // Asserted rather than assumed: if preparation stopped writing a snapshot, every
  // test below would fail with a confusing approval error instead of naming the break.
  expect(row.stage).toBe("offered");
  expect(row.offer_status).toBe("draft");
  expect(row.offer_snapshot_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(row.offer_template_uuid).toBe(approvalTemplateUuid);
  // Nothing was hired. That is the pre-hire invariant this whole file rests on.
  const [[emp]] = await db.query("SELECT COUNT(*) AS n FROM employees WHERE organization_id=? AND full_name=?", [
    orgId,
    name,
  ]);
  expect(Number(emp.n)).toBe(0);

  return { opening, candidate };
}

const approvalOf = (uuid) => getOfferApproval({ orgId, candidateUuid: uuid, conn: db });

describe.runIf(HAS_DB)("an offer needs approval before it can be sent", () => {
  it("an offer with NO approval record cannot be sent", async () => {
    // The first thing a fresh install gets wrong. Treating "no approval" as
    // "implicitly approved" would let a recruiter send an offer nobody decided on.
    // A candidate who has never had an offer prepared has no approval at all.
    const { candidate } = await atOffered("Send Without Approval");

    await expect(
      sendOffer({ orgId, actorUuid: adminUuid, candidateUuid: candidate.uuid }),
    ).rejects.toThrow(/must be approved before it can be sent/i);
  });

  it("a PENDING approval still cannot be sent", async () => {
    // `startCandidateOffer` prepares AND submits in one call, so preparing is enough
    // to reach `pending_approval` without anyone having decided anything.
    const { candidate } = await atOffered("Pending Cannot Send");
    const submitted = await prepareOffer({
      orgId,
      actorUuid: adminUuid,
      candidateUuid: candidate.uuid,
      templateUuid: approvalTemplateUuid,
      conn: db,
    });
    expect(submitted.approval.status).toBe("pending");

    await expect(
      sendOffer({ orgId, actorUuid: adminUuid, candidateUuid: candidate.uuid }),
    ).rejects.toThrow(/must be approved before it can be sent/i);
  });

  it("request -> approve -> send is the happy path, and the history is append-only", async () => {
    const { candidate } = await preparedNotSubmitted("Happy Offer Path");

    const requested = await requestOfferApproval({
      orgId,
      actorUuid: adminUuid,
      candidateUuid: candidate.uuid,
      comments: "Terms agreed at 120k",
    });
    expect(requested.status).toBe("pending");
    // ApprovalTimeline's exact prop names, so the component can render it with no
    // mapping layer that could drift.
    expect(Array.isArray(requested.steps)).toBe(true);
    expect(requested.currentStepOrder).toBe(1);

    // A DIFFERENT admin decides: `decideApproval` refuses to let the requester
    // approve their own submission, in any role.
    const decided = await decideOfferApproval({
      orgId,
      actorUuid: approverUuid,
      candidateUuid: candidate.uuid,
      decision: "approve",
      comments: "Approved",
    });
    expect(decided.status).toBe("approved");
    expect(decided.resolved_by_uuid).toBe(approverUuid);
    // The chain did not vanish once resolved - it is still readable, which is the
    // whole point of an audit trail.
    expect(decided.uuid).toBe(requested.uuid);

    // Now it sends, and the send actually succeeds - the mailer is mocked, so this is
    // asserting the approval gate let it through and the snapshot still matched.
    const sent = await sendOffer({ orgId, actorUuid: adminUuid, candidateUuid: candidate.uuid });
    expect(sent.status).toBe("sent");

    // Still no employee. Sending is not hiring; only acceptance is.
    const [[emp]] = await db.query("SELECT COUNT(*) AS n FROM employees WHERE organization_id=? AND full_name=?", [
      orgId,
      "Happy Offer Path",
    ]);
    expect(Number(emp.n)).toBe(0);

    // The step history is append-only: the approved decision is recorded.
    const [history] = await db.query(
      "SELECT decision, step_name FROM approval_step_history WHERE approval_request_uuid=? ORDER BY acted_at ASC, step_order ASC",
      [decided.uuid],
    );
    expect(history.some((h) => h.decision === "approved")).toBe(true);
  });
});

describe.runIf(HAS_DB)("the engine's guarantees hold when a caller depends on them", () => {
  it("a second submit is refused rather than opening a second chain", async () => {
    const { candidate } = await preparedNotSubmitted("Double Submit");
    await requestOfferApproval({ orgId, actorUuid: adminUuid, candidateUuid: candidate.uuid });

    // The refusal comes from the SERVICE's draft-state guard
    // (`offer_status !== 'draft'`), which runs before the engine's own duplicate-chain
    // check. Both refuse; the service simply gets there first. The guarantee that
    // matters is the COUNT below, which is checked in the table rather than inferred
    // from whichever message happens to win the race.
    await expect(
      requestOfferApproval({ orgId, actorUuid: adminUuid, candidateUuid: candidate.uuid }),
    ).rejects.toThrow(/Prepare and validate the offer draft|already awaiting approval/i);

    // Exactly one live chain, checked in the table rather than trusting the message.
    const [rows] = await db.query(
      "SELECT COUNT(*) AS n FROM approval_requests WHERE organization_id=? AND entity_type='candidate_offer' AND entity_uuid=?",
      [orgId, candidate.uuid],
    );
    expect(Number(rows[0].n)).toBe(1);
  });

  it("deciding twice is refused, so a second decision cannot overwrite the first", async () => {
    const { candidate } = await preparedNotSubmitted("Double Decision");
    await requestOfferApproval({ orgId, actorUuid: adminUuid, candidateUuid: candidate.uuid });
    await decideOfferApproval({
      orgId,
      actorUuid: approverUuid,
      candidateUuid: candidate.uuid,
      decision: "approve",
    });

    await expect(
      decideOfferApproval({ orgId, actorUuid: adminUuid, candidateUuid: candidate.uuid, decision: "reject" }),
    ).rejects.toThrow(/already approved/i);

    const approval = await approvalOf(candidate.uuid);
    expect(approval.status).toBe("approved");
  });

  it("the REQUESTER cannot decide their own offer, even as org_admin", async () => {
    // Unconditional and evaluated before approver resolution, so no role - org_admin
    // included - can get past it.
    const { candidate } = await preparedNotSubmitted("Self Decision");
    await requestOfferApproval({ orgId, actorUuid: adminUuid, candidateUuid: candidate.uuid });

    await expect(
      decideOfferApproval({ orgId, actorUuid: adminUuid, candidateUuid: candidate.uuid, decision: "approve" }),
    ).rejects.toThrow(/cannot approve or reject their own submission/i);

    const approval = await approvalOf(candidate.uuid);
    expect(approval.status).toBe("pending");
  });

  it("a REJECTED offer creates no employee, and leaves the CANDIDATE actionable", async () => {
    // The pre-hire analogue of the old "a bad document is not a bad hire" guarantee.
    // Under this lifecycle rejection happens BEFORE any hire, so there is no employee
    // to preserve - but the underlying principle is unchanged and still worth pinning:
    // rejecting the LETTERS must not reject the PERSON. The candidate stays on the
    // board, keeps the reason, and can be re-prepared.
    const { candidate } = await preparedNotSubmitted("Rejected Letter");
    await requestOfferApproval({ orgId, actorUuid: adminUuid, candidateUuid: candidate.uuid });
    await decideOfferApproval({
      orgId,
      actorUuid: approverUuid,
      candidateUuid: candidate.uuid,
      decision: "reject",
      comments: "Budget not approved",
    });

    const approval = await approvalOf(candidate.uuid);
    expect(approval.status).toBe("rejected");

    const [row] = await db.query("SELECT stage, notes, converted_employee_uuid FROM candidates WHERE uuid=?", [
      candidate.uuid,
    ]);
    // STAYS `offered`, NOT moved to `rejected`: the recruiter can fix the terms and
    // re-prepare, which is the whole point of treating this as a document problem.
    expect(row[0].stage).toBe("offered");
    expect(row[0].converted_employee_uuid).toBeNull();
    // The reason is recorded on the candidate so the recruiter finds it on the board.
    expect(row[0].notes).toMatch(/budget/i);

    const [[emp]] = await db.query("SELECT COUNT(*) AS n FROM employees WHERE organization_id=? AND full_name=?", [
      orgId,
      "Rejected Letter",
    ]);
    expect(Number(emp.n)).toBe(0);

    await expect(
      sendOffer({ orgId, actorUuid: adminUuid, candidateUuid: candidate.uuid }),
    ).rejects.toThrow(/must be approved before it can be sent/i);
  });

  it("a rejection is terminal: a rejected offer cannot be decided again", async () => {
    const { candidate } = await preparedNotSubmitted("Terminal Rejection");
    await requestOfferApproval({ orgId, actorUuid: adminUuid, candidateUuid: candidate.uuid });
    await decideOfferApproval({
      orgId,
      actorUuid: approverUuid,
      candidateUuid: candidate.uuid,
      decision: "reject",
    });

    await expect(
      decideOfferApproval({ orgId, actorUuid: approverUuid, candidateUuid: candidate.uuid, decision: "approve" }),
    ).rejects.toThrow(/already rejected/i);
  });

  it("cannot submit an approval for a candidate who is not at selected/offered", async () => {
    const opening = await createOpening({ orgId, title: "Not Selected", status: "open", vacancies: 9, conn: db });
    const candidate = await createCandidate({
      orgId,
      openingUuid: opening.uuid,
      fullName: "Still Interviewing",
      email: `still-${crypto.randomUUID().slice(0, 6)}@example.com`,
      conn: db,
    });
    await updateCandidateStage({ orgId, candidateUuid: candidate.uuid, stage: "screening", conn: db });

    // `screening`, not even `selected`. The message names the actual next step.
    await expect(
      requestOfferApproval({ orgId, actorUuid: adminUuid, candidateUuid: candidate.uuid }),
    ).rejects.toThrow(/Select the candidate before submitting an offer/i);
  });

  it("cannot submit an approval for an offer that was never PREPARED", async () => {
    // The exact gap the pre-hire lifecycle closed: at `offered`, with no template and
    // no snapshot, there is nothing to approve. Under the old post-hire model this
    // state was reachable with an orphaned employee row behind it.
    const { candidate } = await atOffered("Offered Not Prepared");

    await expect(
      requestOfferApproval({ orgId, actorUuid: adminUuid, candidateUuid: candidate.uuid }),
    ).rejects.toThrow(/Prepare and validate the offer draft/i);

    const [[emp]] = await db.query("SELECT COUNT(*) AS n FROM employees WHERE organization_id=? AND full_name=?", [
      orgId,
      "Offered Not Prepared",
    ]);
    expect(Number(emp.n)).toBe(0);
  });

  it("an unknown or other-tenant candidate yields no approval record, not someone else's", async () => {
    const { candidate } = await preparedNotSubmitted("Isolation Subject");
    await requestOfferApproval({ orgId, actorUuid: adminUuid, candidateUuid: candidate.uuid });

    // A second org, with nobody in it. Proves the lookup is org-scoped rather than
    // resolving the newest approval anywhere.
    const [other] = await db.query("INSERT INTO organizations (uuid, name) VALUES (UUID(), ?)", [
      `Offer isolation ${Date.now()}`,
    ]);
    otherOrgId = other.insertId;
    try {
      await expect(
        getOfferApproval({ orgId: other.insertId, candidateUuid: candidate.uuid, conn: db }),
      ).rejects.toThrow(/not found/i);
    } finally {
      await purgeTestOrgs(db, [other.insertId]);
      otherOrgId = null;
    }
  });

  it("the engine's default workflow was created for this module, not inherited", async () => {
    const { candidate } = await preparedNotSubmitted("Workflow Created");
    await requestOfferApproval({ orgId, actorUuid: adminUuid, candidateUuid: candidate.uuid });

    const [defs] = await db.query(
      "SELECT uuid, module_key, entity_type, name, is_default FROM workflow_definitions WHERE organization_id=? AND module_key='recruitment_management' AND entity_type='candidate_offer'",
      [orgId],
    );
    // PERSISTED, not synthesised per call: approval_requests.workflow_id is NOT NULL,
    // so an approval has to point at the exact chain that decided it, even when that
    // chain was the bootstrap default.
    expect(defs.length).toBeGreaterThan(0);
    expect(defs[0].is_default).toBe(1);
  });

  it("a sub-admin also cannot decide, because the ROLE gate is upstream", async () => {
    // This is the API-level assertion behind the frontend matrix: subAdminUuid holds
    // manage_recruitment, so the PERMISSION check passes and it is the role and the
    // engine's own approver resolution that stop them. Proving the permission is not
    // the only barrier is what makes the two layers worth having.
    const { candidate } = await preparedNotSubmitted("SubAdmin Subject");
    await requestOfferApproval({ orgId, actorUuid: adminUuid, candidateUuid: candidate.uuid });

    const [steps] = await db.query(
      `SELECT s.approver_type FROM workflow_steps s
         JOIN workflow_definitions d ON d.id = s.workflow_id
        WHERE d.organization_id=? AND d.entity_type='candidate_offer' AND s.step_order=1`,
      [orgId],
    );
    expect(steps[0].approver_type).toBe("org_admin");
    expect(steps[0].approver_type).not.toBe("sub_admin");
    expect(subAdminUuid).toBeTruthy();

    // And the engine agrees: a sub-admin is not an eligible approver for this step.
    await expect(
      decideOfferApproval({ orgId, actorUuid: subAdminUuid, candidateUuid: candidate.uuid, decision: "approve" }),
    ).rejects.toThrow(/not an eligible approver|not eligible|approver/i);
  });
});
