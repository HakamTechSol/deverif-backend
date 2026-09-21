import path from "path";
import fs from "fs";

import { pool } from "../config/db.js";
import { DOCS_DIR } from "../config/uploadPaths.js";
import { match as matchDocuments, DocumentServiceError } from "../services/documentService.js";
import { generateQrForRequest } from "./qrCertificate.js";
import { recordPersonDocument } from "./personDocuments.js";
import { buildDocumentCrossCheck } from "./documentConsistency.js";
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
 * Lazy reference-match engine (same pattern as runSlaChecks): processes requests
 * that were staged with match_status='not_attempted' and a matched reference
 * document. Fast path skips OCR when the submitted hash equals the reference
 * hash (confidence=100). Otherwise it runs the Python document service's fuzzy
 * match (OCR extraction + scoring) and applies the decision tree:
 *   >=90  -> auto_matched + auto-approve (verified, QR, person doc, notifications)
 *   60-89 -> manual_review (badge in inbox, normal human flow)
 *   <60   -> manual_review (mismatch-risk hint via match_confidence)
 * Never throws — service outages/timouts leave match_status='not_attempted' and
 * the request stays reviewable. Conditional UPDATEs make concurrent runs safe.
 */
export async function runAutoMatchChecks({ orgId = null, requestId = null } = {}) {
  try {
    const where = ["vr.status='under_review'", "vr.match_status='not_attempted'", "vr.matched_employee_document_id IS NOT NULL"];
    const params = [];
    if (orgId) {
      where.push("vr.issuing_organization_id = ?");
      params.push(orgId);
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
  const submittedPath = path.join(DOCS_DIR, path.basename(vr.document_path || ""));
  if (!fs.existsSync(submittedPath)) {
    console.warn(`Auto-match skipped: submitted file missing for request ${vr.uuid}`);
    return;
  }

  const [refRows] = await pool.query(
    "SELECT document_hash, file_path FROM employee_documents WHERE id=?",
    [vr.matched_employee_document_id]
  );
  if (!refRows.length) {
    console.warn(`Auto-match skipped: reference document ${vr.matched_employee_document_id} no longer exists`);
    return;
  }
  const ref = refRows[0];
  const refPath = path.join(DOCS_DIR, path.basename(ref.file_path || ""));
  if (!fs.existsSync(refPath)) {
    console.warn(`Auto-match skipped: reference file missing for document ${vr.matched_employee_document_id}`);
    return;
  }

  // 1. Exact-hash fast path — identical file, skip OCR entirely.
  let confidence;
  if (vr.document_hash && ref.document_hash && vr.document_hash === ref.document_hash) {
    confidence = 100;
  } else {
    // 2. Fuzzy match via the document service (OCR extraction + scoring).
    try {
      const { data } = await matchDocuments(submittedPath, refPath);
      confidence = round2(data?.confidence);
    } catch (e) {
      // 4. Service down/timeout/bad payload: leave match_status='not_attempted'
      // so the request falls through to normal manual review, never blocked.
      if (e instanceof DocumentServiceError) {
        console.warn(`Auto-match deferred for request ${vr.uuid} (${e.kind || "service"}): ${e.message}`);
      } else {
        console.error(`Auto-match unexpected error for request ${vr.uuid}:`, e.message);
      }
      return;
    }
  }

  if (!Number.isFinite(confidence)) {
    console.warn(`Auto-match: invalid confidence for request ${vr.uuid}, deferring`);
    return;
  }

  // 3. Decision tree.
  if (confidence >= AUTO_APPROVE_THRESHOLD) {
    await autoApprove(vr, confidence);
  } else {
    const [u] = await pool.query(
      `UPDATE verification_requests
         SET match_status='manual_review', match_confidence=?
       WHERE id=? AND match_status='not_attempted' AND status='under_review'`,
      [confidence, vr.id]
    );
    if (u.affectedRows === 0) {
      console.warn(`Auto-match skipped: request ${vr.uuid} already processed elsewhere`);
    }
  }
}

async function autoApprove(vr, confidence) {
  const [u] = await pool.query(
    `UPDATE verification_requests
       SET match_status='auto_matched', match_confidence=?,
           status='verified', verified_at=NOW(), verification_method='automatic_match'
     WHERE id=? AND match_status='not_attempted' AND status='under_review'`,
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