/**
 * The PRE-HIRE offer lifecycle, as the service actually implements it.
 *
 * ============================ WHY THIS EXISTS ============================
 *
 * Four recruitment suites were written against a POST-hire contract: they expected
 * `startCandidateOffer` to create the employee record, draft an HR letter and open an
 * approval chain in one call, leaving the candidate at `stage='hired'`. That contract
 * was replaced. The lifecycle is now PRE-hire, and the sequence is:
 *
 *     selected / offered
 *       -> startCandidateOffer   PREPARES: resolves merge tags, snapshots the
 *                                rendered body, opens the approval chain.
 *                                *** NO EMPLOYEE ROW IS CREATED HERE ***
 *       -> decideOfferApproval   approved
 *       -> sendOffer             emails the approved snapshot, marks it sent
 *       -> respondToOffer        'accepted' -> hireCandidate -> employee row
 *
 * `hireCandidate` is unreachable from the pipeline for exactly this reason: it
 * refuses unless `offer_status='sent'` AND `offerAcceptance` is true, which only
 * `respondToOffer` supplies. So "an employee exists" is not a fact about stage and
 * offer status - it is a consequence of a candidate having accepted.
 *
 * Every acceptance point these suites were built to prove still holds. It simply has
 * to be asserted AFTER acceptance, which is where the employee actually appears:
 *
 *   exactly-once employee creation   -> after respondToOffer('accepted'), twice
 *   idempotency                      -> a second acceptance is refused
 *   no-approver blocks               -> startCandidateOffer throws before anything
 *   failed-interview block/override  -> at startCandidateOffer, still pre-employee
 *   approved-before-sent             -> sendOffer refuses a pending offer
 *
 * ============================ MERGE TAG SYNTAX ============================
 *
 * Tags are `$name`, NOT `{{name}}`. The shared `seedOfferTemplate` helper writes
 * `{{candidate_name}}`, which `extractTags` cannot see, so `previewOffer` finds no
 * tags at all and then refuses the template with "Offer Letter templates must
 * include $new_salary". A template for the pre-hire flow therefore has to be built
 * from `$`-prefixed tags.
 */

import {
  startCandidateOffer,
  decideOfferApproval,
  sendOffer,
  respondToOffer,
} from "../../src/services/recruitment.service.js";

/**
 * Values that resolve on their own (from `offerDefaults`) versus values that MUST be
 * supplied. `$joining_date` and `$new_salary` default to the empty string, so a
 * template containing them leaves the offer UNRESOLVED and `startCandidateOffer`
 * refuses with "Complete these offer fields before approval". Supplying them here is
 * what makes a fixture offer actually approvable.
 */
export const DEFAULT_OFFER_VALUES = {
  new_salary: "65000",
  joining_date: "2026-11-01",
};

/**
 * Seed an ACTIVE `offer` letter template whose merge tags all resolve.
 *
 * `$employee_name` comes from the candidate, and `$reference_no` / `$issue_date` are
 * derived by the service, so those need no input. `$new_salary` and `$joining_date`
 * come from the offer terms the caller supplies.
 */
export async function seedOfferLetterTemplate(conn, orgId, { name = "Pre-hire Offer", seq = 0 } = {}) {
  const body = [
    "Dear $employee_name,",
    "",
    "We are pleased to offer you the position described below.",
    "Your annual salary will be $new_salary, and you will join us on $joining_date.",
    "",
    "Warm regards,",
    "Human Resources",
  ].join("\n");

  const [row] = await conn.query(
    `INSERT INTO letter_templates (uuid, organization_id, letter_type, name, body, merge_fields, is_active)
     VALUES (UUID(), ?, 'offer', ?, ?, ?, 1)`,
    [
      orgId,
      `${name}${seq ? ` ${seq}` : ""}`,
      body,
      JSON.stringify(["employee_name", "new_salary", "joining_date"]),
    ],
  );
  const [[tpl]] = await conn.query("SELECT uuid FROM letter_templates WHERE id=?", [row.insertId]);
  return tpl.uuid;
}

/**
 * Prepare an offer: the pre-hire equivalent of the old "start-offer creates
 * everything". Returns the service's `{ candidate, approval }`.
 */
export async function prepareOffer({ orgId, actorUuid, candidateUuid, templateUuid, conn, values, ...rest }) {
  return startCandidateOffer({
    orgId,
    actorUuid,
    candidateUuid,
    offerTemplateUuid: templateUuid,
    offerValues: { ...DEFAULT_OFFER_VALUES, ...(values ?? {}) },
    conn,
    ...rest,
  });
}

/** Approve a prepared offer. `actorUuid` MUST differ from who requested it. */
export async function approveOffer({ orgId, actorUuid, candidateUuid, conn, comments = "Approved" }) {
  return decideOfferApproval({ orgId, actorUuid, candidateUuid, decision: "approve", comments, conn });
}

/** Email the approved snapshot. The candidate's offer_status becomes 'sent'. */
export async function sendPreparedOffer({ orgId, actorUuid, candidateUuid, conn }) {
  return sendOffer({ orgId, actorUuid, candidateUuid, conn });
}

/**
 * Record the candidate's response. 'accepted' is the ONLY thing that creates an
 * employee; 'declined' never does.
 *
 * `hireOptions` (cnic, joiningDate, portalAccess, ...) is forwarded verbatim:
 * `respondToOffer` passes it to `hireCandidate`, which is where the CNIC and start
 * date actually land on the employee row.
 */
export async function respondPreparedOffer({ orgId, actorUuid, candidateUuid, response, conn, comments, ...hireOptions }) {
  return respondToOffer({ orgId, actorUuid, candidateUuid, response, comments, conn, ...hireOptions });
}

/**
 * Drive the whole pre-hire flow and return the acceptance result, which carries the
 * employee uuid.
 *
 * Use this for fixtures that need a HIRED candidate. Use the individual steps when
 * the test is about one of the gates between them.
 *
 * @param approverUuid the approver. Must not equal `requesterUuid`:
 *   `decideApproval` refuses to let the requester approve their own submission.
 */
export async function driveToHired({
  orgId,
  requesterUuid,
  approverUuid,
  candidateUuid,
  templateUuid,
  conn,
  values,
  hireOptions = {},
  ...startOptions
}) {
  await prepareOffer({ orgId, actorUuid: requesterUuid, candidateUuid, templateUuid, conn, values, ...startOptions });
  await approveOffer({ orgId, actorUuid: approverUuid, candidateUuid, conn });
  await sendPreparedOffer({ orgId, actorUuid: requesterUuid, candidateUuid, conn });
  return respondPreparedOffer({
    orgId,
    actorUuid: requesterUuid,
    candidateUuid,
    response: "accepted",
    conn,
    ...hireOptions,
  });
}