import path from "path";
import fs from "fs";

import { pool } from "../config/db.js";
import { DOCS_DIR } from "../config/uploadPaths.js";
import { match as matchDocuments, DocumentServiceError } from "../services/documentService.js";
import { generateQrForRequest } from "./qrCertificate.js";
import { recordPersonDocument } from "./personDocuments.js";
import { buildDocumentCrossCheck } from "./documentConsistency.js";
import { parseExtractedData } from "./referenceExtraction.js";
import { hashCnic } from "./personCrypto.js";
import { createNotificationForUsers } from "../controllers/notification.controller.js";
import { sendVerificationResultEmailToOrg } from "./mailer.js";
import { firstFrontendUrl } from "./frontendUrl.js";
import { logAudit } from "./auditLog.js";

const AUTO_APPROVE_THRESHOLD = 90;
const MISMATCH_RISK_THRESHOLD = 60;

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

/**
 * The CNIC a cached extraction recorded for a reference document, normalized to
 * bare digits, or null when the reference names no CNIC at all.
 *
 * `extracted_data.fields` is always a map of `{ value, confidence }` where a
 * value that was not visible on the document comes back as `{ value: null }` —
 * which is NOT the same as "this document names no CNIC" for our purposes: an
 * unreadable CNIC cannot be used to confirm identity, and equally must not be
 * read as contradicting it, so both collapse to null here.
 */
function cachedCnicValue(cached) {
  const raw = cached?.fields?.cnic?.value;
  if (typeof raw !== "string") return null;
  const digits = raw.replace(/\D/g, "");
  return /^\d{13}$/.test(digits) ? digits : null;
}

/**
 * The cnic_hash of the person a request is filed for, or null when the request
 * has no linked person (or the read fails). Used only to decide whether the
 * exact-hash fast path is entitled to assert identity.
 */
async function readLinkedPersonCnicHash(linkedPersonId) {
  if (!linkedPersonId) return null;
  const [rows] = await pool.query("SELECT cnic_hash FROM persons WHERE id=?", [linkedPersonId]);
  return rows.length ? rows[0].cnic_hash || null : null;
}

/**
 * Whether a byte-identical submission may short-circuit to confidence 100.
 *
 * Identical bytes prove the organization already holds this exact artifact.
 * They say NOTHING about who is presenting it: a file is not a person. Honoring
 * the shortcut unconditionally let any requester re-file a document somebody
 * else had had approved and be auto-approved on the spot, skipping the very CNIC
 * comparison the canonical path would have made — so the engine would silently
 * discard its strongest piece of counter-evidence.
 *
 * The shortcut is therefore kept for its performance value but is only allowed
 * to stand when the reference's OWN cached CNIC agrees with the person this
 * request is filed for:
 *   - no CNIC cached on the reference -> nothing to contradict; byte equality
 *     plus the org-scoped CNIC staging is what we have, so honor it;
 *   - cached CNIC matches the request's person -> identity confirmed, honor it;
 *   - cached CNIC differs, or the request has no linked person to compare
 *     against -> NOT proven; fall through to the canonical comparison, which
 *     will hard-fail the CNIC field and route the request to a human.
 */
async function exactHashIsIdentitySafe(vr, ref) {
  const cached = parseExtractedData(ref.extracted_data);
  const refCnic = cachedCnicValue(cached);
  if (!refCnic) return true;

  const personCnicHash = await readLinkedPersonCnicHash(vr.linked_person_id);
  if (!personCnicHash) return false;

  return hashCnic(refCnic) === personCnicHash;
}

/**
 * Lazy reference-match engine (same pattern as runSlaChecks): processes requests
 * that were staged with match_status='not_attempted' and a matched reference
 * document. Fast path skips comparison when the submitted hash equals the
 * reference hash AND the reference's cached identity does not contradict this
 * request's person (confidence=100). Otherwise the two documents are compared on
 * their CANONICAL extracted fields — the reference's cached field map when it
 * has one, its live file otherwise — and the decision tree is applied:
 *   >=90  -> auto_matched + auto-approve (verified, QR, person doc, notifications)
 *   60-89 -> manual_review (badge in inbox, normal human flow)
 *   <60   -> manual_review (mismatch-risk hint via match_confidence)
 * Never throws — service outages/timeouts leave match_status='not_attempted' and
 * the request stays reviewable. Conditional UPDATEs make concurrent runs safe.
 *
 * TENANT BOUNDARY: a reference document is private to the organization that
 * uploaded it, so every read of one here is filtered on the request's own
 * issuing_organization_id. An organization is only ever compared against ITS
 * OWN reference pool. A document another organization uploaded or verified
 * must never be able to produce an automatic outcome here: that organization
 * holds no prior reference for this person, so a match would be a decision made
 * with someone else's private data, and it is exactly the cross-tenant leak
 * that org-scoping the staging lookup is meant to prevent.
 */
export async function runAutoMatchChecks({ orgId = null, requestId = null } = {}) {
  try {
    // A request addressed to an unmatched organization has no target org, so
    // it can never legitimately hold a reference. Excluding those rows means
    // the sweep can never treat one as matchable even if a stale
    // matched_employee_document_id were somehow attached to it.
    const where = [
      "vr.status='under_review'",
      "vr.match_status='not_attempted'",
      "vr.matched_employee_document_id IS NOT NULL",
      "vr.issuing_organization_id IS NOT NULL",
    ];
    const params = [];
    if (orgId) {
      where.push("vr.issuing_organization_id = ?");
      params.push(orgId);
    }
    if (requestId) {
      where.push("vr.id = ?");
      params.push(requestId);
    }

    if (requestId) {
      where.push("vr.id = ?");
      params.push(requestId);
    }

    const [rows] = await pool.query(
      `SELECT vr.*, requester.uuid AS requester_uuid,
              requester.organization AS requester_organization
       FROM verification_requests vr
       JOIN users requester ON requester.id = vr.user_id
       WHERE ${where.join(" AND ")}`,
      params
    );

    for (const vr of rows) {
      try {
        await processOne(vr);
      } catch (e) {
        console.error(`Auto-match failed for request ${vr.uuid}:`, e.message);
      }
    }
  } catch (e) {
    console.error("Auto-match checks failed:", e.message);
  }
}

async function processOne(vr) {
  const outcome = await evaluateMatch(vr);

  if (outcome.noReference) {
    // The staged reference is not available to this request's target
    // organization — it was deleted, or it belongs to a different org. Either
    // way this organization holds no reference for the person, which is exactly
    // what 'no_reference_found' means, and it is a permanent condition worth
    // recording (unlike a service outage). Clearing the pointer also stops the
    // request being reconsidered against a reference it may not use.
    const [u] = await pool.query(
      `UPDATE verification_requests
         SET match_status='no_reference_found', matched_employee_document_id=NULL, match_confidence=NULL
       WHERE id=? AND match_status='not_attempted' AND status='under_review'`,
      [vr.id]
    );
    if (u.affectedRows === 0) {
      console.warn(`Auto-match skipped: request ${vr.uuid} already processed elsewhere`);
    }
    return;
  }

  if (outcome.confidence === null) {
    // File missing, or the service is down/timeout: leave match_status
    // 'not_attempted' so the request stays reviewable and a later run can still
    // decide it. Never resolved to a final state on a transient failure.
    return;
  }

  // The document service can score a pair highly and still refuse to have it
  // approved — an identity-poor document type (a photograph, an NDA), or a CNIC
  // comparison that did not establish one person. That verdict is authoritative
  // and is checked BEFORE the threshold, because the score cannot be trusted to
  // carry it: a letter whose name, designation and joining date all agree
  // averages exactly to the service's own match threshold with the CNIC scoring
  // zero. The score is still recorded, so a reviewer can see how close it came.
  if (outcome.autoMatchBlocked) {
    const [u] = await pool.query(
      `UPDATE verification_requests
         SET match_status='manual_review', match_confidence=?
       WHERE id=? AND match_status='not_attempted' AND status='under_review'`,
      [outcome.confidence, vr.id]
    );
    if (u.affectedRows === 0) {
      console.warn(`Auto-match skipped: request ${vr.uuid} already processed elsewhere`);
    } else {
      console.warn(
        `Auto-match refused to auto-approve request ${vr.uuid} on the service's verdict ` +
          `(confidence=${outcome.confidence}, reason=${outcome.blockReason || "unspecified"}) — routed to manual review`
      );
    }
    return;
  }

  // Decision tree.
  if (outcome.confidence >= AUTO_APPROVE_THRESHOLD) {
    await autoApprove(vr, outcome.confidence);
  } else {
    const [u] = await pool.query(
      `UPDATE verification_requests
         SET match_status='manual_review', match_confidence=?
       WHERE id=? AND match_status='not_attempted' AND status='under_review'`,
      [outcome.confidence, vr.id]
    );
    if (u.affectedRows === 0) {
      console.warn(`Auto-match skipped: request ${vr.uuid} already processed elsewhere`);
    }
  }
}

/**
 * Decide a request against its staged reference, distinguishing a PERMANENT
 * "there is no reference for this organization" from a TRANSIENT "could not
 * compare right now".
 *
 * Returns one of:
 *   { confidence: number }        a score to act on
 *   { confidence: number, autoMatchBlocked: true, blockReason }  the service
 *                                 measured the pair but refused to have it
 *                                 approved (identity-poor document type, or a
 *                                 CNIC comparison that did not establish one
 *                                 person). The score is returned for display,
 *                                 but it must not be used to auto-approve.
 *   { confidence: null }          defer — leave match_status untouched
 *   { noReference: true }         the reference is gone or belongs to another org
 *
 * The comparison is over CANONICAL EXTRACTED FIELDS only, never over file bytes
 * or format, with one exception: the exact-hash fast path, which short-circuits
 * to 100 when the two files are byte-identical AND the reference's cached
 * identity does not contradict this request's person. So a DOCX reference and a
 * PDF submission of the same document — whose hashes can never be equal, and
 * correctly so — still match on their name/CNIC fields, and a byte-identical
 * submission whose reference names a different CNIC is sent down the canonical
 * path instead of being waved through.
 */
async function evaluateMatch(vr) {
  const targetOrgId = vr?.issuing_organization_id ?? null;
  if (!targetOrgId) {
    // No target organization means no reference pool and no organization that
    // owes a decision. Nothing can legitimately match here.
    console.warn(`Auto-match skipped: request ${vr?.uuid} has no target organization`);
    return { noReference: true, confidence: null };
  }

  const submittedPath = path.join(DOCS_DIR, path.basename(vr.document_path || ""));
  if (!fs.existsSync(submittedPath)) {
    console.warn(`Auto-match skipped: submitted file missing for request ${vr.uuid}`);
    return { confidence: null };
  }

  // TENANT BOUNDARY. The reference is read through the employee it belongs to,
  // filtered on the SAME organization this request is addressed to. Looking the
  // document up by id alone would let any request match against a reference
  // belonging to a different organization, which is both a cross-tenant data
  // leak (another org's document content and employee name) and a
  // data-integrity failure (an organization auto-approving on a reference it
  // never held).
  const [refRows] = await pool.query(
    `SELECT ed.id, ed.document_hash, ed.file_path, ed.document_type,
            ed.extracted_data, ed.extraction_status
       FROM employee_documents ed
       JOIN employees e ON e.uuid = ed.employee_uuid
      WHERE ed.id = ?
        AND e.organization_id = ?
      LIMIT 1`,
    [vr.matched_employee_document_id, targetOrgId]
  );
  if (!refRows.length) {
    console.warn(
      `Auto-match skipped: reference document ${vr.matched_employee_document_id} is not available to organization ${targetOrgId} (request ${vr.uuid})`
    );
    return { noReference: true, confidence: null };
  }
  const ref = refRows[0];

  // 1. Exact-hash fast path — byte-identical file, no comparison needed. This
  //    is the ONLY place file bytes influence the outcome, and it is gated on
  //    the reference's cached identity not contradicting this request's person
  //    (see exactHashIsIdentitySafe): identical bytes prove the org holds the
  //    artifact, never who is presenting it.
  //
  //    A short-circuit means the service was never consulted, so
  //    autoMatchBlocked stays false — correct, because the gate above already
  //    established that the reference names this same person.
  let confidence;
  let autoMatchBlocked = false;
  let blockReason = null;
  const exactHash = Boolean(vr.document_hash && ref.document_hash && vr.document_hash === ref.document_hash);
  if (exactHash && (await exactHashIsIdentitySafe(vr, ref))) {
    confidence = 100;
  } else {
    // 2. Canonical-field match. Prefer the reference's cached field map (built
    //    at upload time), so the reference file is neither re-read nor
    //    re-OCR'd per match and a non-image reference (DOCX) compares exactly
    //    like an image one. Only a reference with no usable cache (a row that
    //    predates the column, or whose extraction failed) falls back to sending
    //    the file itself.
    const cached = parseExtractedData(ref.extracted_data);
    const refType = cached?.documentType || ref.document_type || null;

    let refPath = null;
    if (!cached) {
      refPath = path.join(DOCS_DIR, path.basename(ref.file_path || ""));
      if (!fs.existsSync(refPath)) {
        console.warn(
          `Auto-match skipped: reference file missing for document ${vr.matched_employee_document_id}`
        );
        return { confidence: null };
      }
    }

    try {
      const { data } = await matchDocuments(submittedPath, refPath, {
        documentTypeA: vr.document_type,
        documentTypeB: refType,
        fieldsB: cached ? cached.fields : undefined,
      });
      confidence = round2(data?.confidence);

      // The service's own verdict on whether this result may be approved at all.
      // Both flags are checked, and both are treated as "refuse" when present:
      //
      //   auto_match_eligible === false  the document type carries no identity
      //     (a photograph, an NDA, a policy acknowledgment, a handover form), so
      //     similarity between two of them proves nothing about who they are.
      //   identity_mismatch === true     the CNIC comparison did not establish
      //     one person: the two CNICs differ, or one document shows a CNIC and
      //     the other does not.
      //
      // A missing flag is NOT a refusal: both default to the permissive value in
      // the service's response model, so a Node backend pointed at a pre-flag
      // Python build keeps behaving as it did rather than refusing everything.
      autoMatchBlocked = data?.auto_match_eligible === false || data?.identity_mismatch === true;
      blockReason = data?.identity_mismatch === true ? "identity_mismatch" : "auto_match_eligible=false";
    } catch (e) {
      // Service down/timeout/bad payload: leave match_status='not_attempted'
      // so the request falls through to normal manual review, never blocked.
      if (e instanceof DocumentServiceError) {
        console.warn(`Auto-match deferred for request ${vr.uuid} (${e.kind || "service"}): ${e.message}`);
      } else {
        console.error(`Auto-match unexpected error for request ${vr.uuid}:`, e.message);
      }
      return { confidence: null };
    }
  }

  if (!Number.isFinite(confidence)) {
    console.warn(`Auto-match: invalid confidence for request ${vr.uuid}, deferring`);
    return { confidence: null };
  }

  return { confidence, autoMatchBlocked, blockReason };
}

/**
 * Public, score-only view of evaluateMatch: a number when a decision can be
 * taken, null when the request must be deferred for now. Used by the inline
 * creation-time match, which only acts on a definitive 100.
 *
 * A refused comparison is reported as 0 rather than its real score, because
 * that caller's guard is a literal `confidence === 100`. Returning the true
 * score would reintroduce the exact averaging hole the service's flag exists to
 * close: a document type with many matching non-identity fields can still score
 * 100-capable averages while the CNIC disagrees. Returning 0 makes the refusal
 * unconditional at this call site, matching what the lazy sweep does with
 * autoMatchBlocked.
 */
export async function computeMatchConfidence(vr) {
  const outcome = await evaluateMatch(vr);
  if (outcome.autoMatchBlocked) return 0;
  return outcome.confidence ?? null;
}

export async function autoApprove(vr, confidence) {
  // The tenant invariant is restated on the write as well as the read: an
  // automatic outcome may only ever be recorded for a request that is addressed
  // to a real organization. Costless belt-and-braces on the one statement that
  // flips a request to 'verified' without a human.
  const [u] = await pool.query(
    `UPDATE verification_requests
       SET match_status='auto_matched', match_confidence=?,
           status='verified', verified_at=NOW(), verification_method='automatic_match'
     WHERE id=? AND match_status='not_attempted' AND status='under_review'
       AND issuing_organization_id IS NOT NULL`,
    [confidence, vr.id]
  );
  if (u.affectedRows === 0) {
    console.warn(`Auto-approve skipped: request ${vr.uuid} already processed elsewhere`);
    return;
  }

  const [freshRows] = await pool.query("SELECT * FROM verification_requests WHERE id=?", [vr.id]);
  const fresh = freshRows[0];

  // Tamper-evident public QR certificate + person's document history (with the
  // form-vs-document cross-check, same as the manual approve path — OCR runs
  // only now, at approval, never at submission).
  await generateQrForRequest(fresh);
  const crossCheck = await buildDocumentCrossCheck(fresh);
  await recordPersonDocument(fresh, vr.issuing_organization_id, crossCheck);

  // Notify the requester.
  try {
    await createNotificationForUsers({
      userIds: [vr.requester_uuid],
      type: "request_verified",
      title: "Request approved",
      message: `Your "${vr.document_type}" request was approved automatically.`,
      link: "/requests",
      referenceId: vr.uuid,
    });
  } catch (e) {
    console.error("Failed to create auto-approve requester notification:", e.message);
  }

  // Email the organization the request came FROM (business email + admins).
  if (vr.requester_organization) {
    try {
      await sendVerificationResultEmailToOrg({
        orgId: vr.requester_organization,
        documentType: vr.document_type,
        portalLink: `${firstFrontendUrl(process.env.FRONTEND_URL, "http://localhost:8080")}/requests`,
      });
    } catch (e) {
      console.error("Failed to send auto-approve verification result email to org:", e.message);
    }
  }

  logAudit({
    actorType: "system",
    actorId: null,
    actorName: "Auto-Verify Matrix",
    action: "request.auto_verify",
    entityType: "verification_request",
    entityId: vr.uuid,
    details: { status: "verified", method: "automatic_match", confidence },
  });
}

/** True when a request carries a mismatch-risk hint (low-confidence manual review). */
export function hasMatchMismatchRisk(vr) {
  return (
    vr.match_status === "manual_review" &&
    vr.match_confidence !== null &&
    vr.match_confidence !== undefined &&
    Number(vr.match_confidence) < MISMATCH_RISK_THRESHOLD
  );
}