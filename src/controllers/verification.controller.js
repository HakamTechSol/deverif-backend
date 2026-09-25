import ApiError from "../utils/ApiError.js";
import { pool } from "../config/db.js";
import { encryptCnic, hashCnic } from "../utils/personCrypto.js";
import { recordPersonDocument } from "../utils/personDocuments.js";
import { assertDocumentValid } from "../utils/documentValidate.js";
import { created, ok } from "../utils/response.js";
import { assertUuid } from "../utils/publicResponse.js";
import { parsePagination, paginatedResponse } from "../utils/pagination.js";
import { createNotificationForOrgUsers, createNotificationForUsers } from "./notification.controller.js";
import { assertOrganizationActive } from "./admin/organizations.controller.js";
import { enforceRequestQuota } from "../utils/requestQuota.js";
import { resolveUnmatchedOrg } from "../utils/unmatchedOrg.js";
import { logAudit, getActorFromReq } from "../utils/auditLog.js";
import { generateQrForRequest } from "../utils/qrCertificate.js";
import { runSlaChecks } from "../utils/slaChecks.js";
import { runAutoMatchChecks, hasMatchMismatchRisk, computeMatchConfidence, autoApprove } from "../utils/autoMatch.js";
import { buildDocumentCrossCheck } from "../utils/documentConsistency.js";
import { sendVerificationResultEmailToOrg } from "../utils/mailer.js";
import { firstFrontendUrl } from "../utils/frontendUrl.js";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { DOCS_DIR } from "../config/uploadPaths.js";
import { requirePermission } from "../utils/permissions.js";

// Map an upload's mime onto the short format label stored in
// verification_requests.document_format and shown in the Format column. Kept in
// step with the upload allow-list in middleware/uploadDocs.js; previously every
// non-PDF was labelled "jpeg", so a PNG or DOCX request displayed a wrong type.
function docFormatFromMime(m, originalname = "") {
  const map = {
    "application/pdf": "pdf",
    "image/jpeg": "jpeg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/bmp": "bmp",
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.ms-excel": "xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "text/plain": "txt",
    "text/csv": "csv",
    "application/zip": "zip",
  };
  if (map[m]) return map[m];
  // Browsers and older clients send a generic blob marker for some types. The
  // allow-list tolerates it for known extensions, so derive the label from the
  // declared extension rather than degrading every such file to "file".
  if (m === "application/octet-stream" || !m) {
    const ext = String(originalname || "").toLowerCase().match(/\.[a-z0-9]+$/);
    if (ext && map[`application/${ext[0].slice(1)}`]) return ext[0].slice(1);
  }
  return "file";
}

function generateFileHash(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new ApiError(400, "Uploaded document file is missing — please upload the document again");
  }
  const buffer = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function resolveOrganizationUuid(uuid, required = false) {
  if (!uuid) {
    if (required) throw new ApiError(400, "Organization UUID is required");
    return null;
  }
  assertUuid(uuid, "Organization UUID");
  const [rows] = await pool.query("SELECT id FROM organizations WHERE uuid=?", [uuid]);
  if (!rows.length) throw new ApiError(404, "Organization not found");
  return rows[0].id;
}

export async function createRequest(req, res) {
  requirePermission(req.user, "generate_request");
  const { document_type, issuing_organization_uuid,
          other_organization_name, submission_remarks,
          other_organization_email, other_organization_phone, other_organization_website,
          document_owner_cnic, document_owner_name } = req.body;

  if ("issuing_organization_id" in req.body) {
    throw new ApiError(400, "issuing_organization_uuid is required; integer IDs are not accepted");
  }
  if (!document_type) throw new ApiError(400, "document_type is required");
  if (!req.file) throw new ApiError(400, "document file is required");

  if (req.user.organization) {
    await enforceRequestQuota(req.user.organization);
  }

  const orgId = await resolveOrganizationUuid(issuing_organization_uuid || null);

  const otherOrgName = other_organization_name ? String(other_organization_name).trim() : null;
  const remarks = submission_remarks ? String(submission_remarks).trim() : null;

  const documentOwnerName = document_owner_name ? String(document_owner_name).trim() : "";
  if (!documentOwnerName) {
    throw new ApiError(400, "document_owner_name is required");
  }
  if (documentOwnerName.length > 200) {
    throw new ApiError(400, "document_owner_name must be 200 characters or fewer");
  }

  const rawOwnerCnic = document_owner_cnic ? String(document_owner_cnic).trim() : "";
  if (!rawOwnerCnic) {
    throw new ApiError(400, "document_owner_cnic is required");
  }
  const normalized = rawOwnerCnic.replace(/\D/g, "");
  if (!/^\d{13}$/.test(normalized)) {
    throw new ApiError(400, "document_owner_cnic must be a valid CNIC (XXXXX-XXXXXXX-X)");
  }
  const documentOwnerCnic = encryptCnic(normalized);
  const documentOwnerCnicHash = hashCnic(normalized);

  if (!orgId && !otherOrgName) {
    throw new ApiError(400, "other_organization_name is required when no organization is selected");
  }
  if (otherOrgName && otherOrgName.length > 200) {
    throw new ApiError(400, "other_organization_name must be 200 characters or fewer");
  }
  if (remarks && remarks.length > 500) {
    throw new ApiError(400, "submission_remarks must be 500 characters or fewer");
  }

  const otherEmail = other_organization_email ? String(other_organization_email).trim() : null;
  const otherPhone = other_organization_phone ? String(other_organization_phone).trim() : null;
  const otherWebsite = other_organization_website ? String(other_organization_website).trim() : null;

  if (otherEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(otherEmail)) {
    throw new ApiError(400, "other_organization_email must be a valid email address");
  }
  if (otherWebsite && otherWebsite.length > 500) {
    throw new ApiError(400, "other_organization_website must be 500 characters or fewer");
  }

  const docPath = `/uploads/documents/${req.file.filename}`;
  const fullPath = path.join(DOCS_DIR, req.file.filename);
  const docFormat = docFormatFromMime(req.file.mimetype, req.file.originalname);
  const documentHash = generateFileHash(fullPath);

  // Corrupt-file guard: reject definitively corrupt uploads before they reach
  // the DB. Fails open (warn-only) only when the service is unreachable
  // (timeout / connection refused); any other service failure rejects with 400.
  await assertDocumentValid(fullPath);

  // Resolve unmatched organization if "Other" was selected
  let unmatchedOrgId = null;
  if (!orgId && otherOrgName) {
    unmatchedOrgId = await resolveUnmatchedOrg(otherOrgName, otherEmail, otherPhone, otherWebsite);
  }

  // Repeat submission of a document this organization has already verified.
  //
  // Keyed purely on the SHA-256 of the uploaded file plus the same issuing org
  // and a prior 'verified' outcome. Identical hash means byte-for-byte the same
  // file the org already signed off on, so there is nothing left to re-check and
  // the re-verification is safe: the document is the exact artifact previously
  // approved. A different scan of the same document has a different hash and
  // falls through to the normal reference-match flow instead.
  //
  // This used to additionally require organization_conserned_for_future='yes',
  // but that column was only ever written on an auto-verified insert — never on
  // the ordinary approve paths — so the condition could never become true and
  // the whole path was dead. Matching on the verified outcome itself is both
  // simpler and what the behavior was always meant to be.
  let autoVerify = false;
  if (orgId) {
    const [previousVerified] = await pool.query(
      `SELECT id
       FROM verification_requests
       WHERE document_hash=?
         AND issuing_organization_id=?
         AND status='verified'
       ORDER BY verified_at DESC, id DESC
       LIMIT 1`,
      [documentHash, orgId]
    );
    autoVerify = previousVerified.length > 0;
  }

  const [result] = await pool.query(
    `INSERT INTO verification_requests
     (user_id, document_type, issuing_organization_id, unmatched_org_id, status, submitted_at,
      document_path, document_format, document_hash,
      organization_conserned_for_future, submission_remarks,
      verification_method, verified_at, document_owner_name, created_at)
     VALUES (?, ?, ?, ?, ?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      req.user.id,
      document_type,
      orgId,
      unmatchedOrgId,
      autoVerify ? "verified" : "under_review",
      docPath,
      docFormat,
      documentHash,
      // No longer the auto-verify gate (see the lookup above). It now simply
      // records that this particular row was itself created by a repeat
      // auto-verification rather than by a fresh submission.
      autoVerify ? "yes" : "no",
      remarks,
      autoVerify ? "auto" : "manual",
      autoVerify ? new Date() : null,
      documentOwnerName
    ]
  );

  // Reference-match setup: after the request is saved, locate a roster (or, as a
  // fallback, learned_reference) employee in the target org whose CNIC matches
  // the document owner, and stage the document match. The actual document match
  // (auto-approve/manual-review decision) happens lazily, not here.
  let matchStatus;
  let matchedEmployeeDocumentId = null;
  if (orgId) {
    const [refRows] = await pool.query(
      `SELECT e.uuid AS employee_uuid, ed.id AS doc_id, ed.document_hash
       FROM employees e
       JOIN employee_documents ed ON ed.employee_uuid = e.uuid
       WHERE e.organization_id = ?
         AND REPLACE(REPLACE(e.cnic, '-', ''), ' ', '') = ?
       ORDER BY (e.record_type = 'roster') DESC
       LIMIT 1`,
      [orgId, normalized]
    );
    if (refRows.length) {
      matchStatus = "not_attempted";
      matchedEmployeeDocumentId = refRows[0].doc_id;
    } else {
      const [empRows] = await pool.query(
        `SELECT emp.uuid FROM employees emp
         WHERE emp.organization_id = ?
           AND REPLACE(REPLACE(emp.cnic, '-', ''), ' ', '') = ?
         ORDER BY (emp.record_type = 'roster') DESC
         LIMIT 1`,
        [orgId, normalized]
      );
      matchStatus = empRows.length ? "manual_review" : "no_reference_found";
    }
  } else {
    matchStatus = "no_reference_found";
  }

  await pool.query(
    `UPDATE verification_requests
     SET match_status=?, matched_employee_document_id=?
     WHERE id=?`,
    [matchStatus, matchedEmployeeDocumentId, result.insertId]
  );

  // Link the request to a persons row when a document owner CNIC was given.
  // Case A: no matching person yet -> create one (full_name taken from the
  // unverified claim; never trusted over an existing record).
  // Case B: person already exists -> reuse it, keep the original name.
  let linkedPersonId = null;
  let personExists = false;
  if (documentOwnerCnicHash) {
    const [personRows] = await pool.query(
      `SELECT id FROM persons WHERE cnic_hash=? LIMIT 1`,
      [documentOwnerCnicHash]
    );

    if (personRows.length) {
      linkedPersonId = personRows[0].id;
      personExists = true;
    } else {
      const [personInsert] = await pool.query(
        `INSERT INTO persons (cnic_encrypted, cnic_hash, full_name, is_nadra_verified, created_at)
         VALUES (?, ?, ?, 'no', NOW())`,
        [documentOwnerCnic, documentOwnerCnicHash, documentOwnerName]
      );
      linkedPersonId = personInsert.insertId;
    }

    await pool.query(
      `UPDATE verification_requests SET linked_person_id=? WHERE id=?`,
      [linkedPersonId, result.insertId]
    );
  }

  const [rows] = await pool.query(
    `SELECT vr.*, o.uuid AS issuing_organization_uuid, o.name AS issuing_org_name,
            uo.uuid AS unmatched_org_uuid, uo.name AS unmatched_org_name,
            requester.uuid AS requester_uuid,
            requester.organization AS requester_organization
     FROM verification_requests vr
     LEFT JOIN organizations o ON o.id = vr.issuing_organization_id
     LEFT JOIN unmatched_organizations uo ON uo.id = vr.unmatched_org_id
     JOIN users requester ON requester.id = vr.user_id
     WHERE vr.id=?`,
    [result.insertId]
  );

  // Person identity context for the submitter side. A CNIC hash that already
  // existed before this submission means a "known" identity; any verified
  // person_documents row (from any organization) means the person has been
  // verified before. Both are informational context only and never drive the
  // verification status or auto-verify eligibility.
  rows[0].person_known = Boolean(personExists);
  rows[0].person_has_prior_verification = false;
  rows[0].person_prior_verified_at = null;

  if (linkedPersonId) {
    const [priorPersonDocs] = await pool.query(
      `SELECT verified_at
       FROM person_documents
       WHERE person_id=? AND status='verified'
       ORDER BY verified_at DESC
       LIMIT 1`,
      [linkedPersonId]
    );
    if (priorPersonDocs.length) {
      rows[0].person_has_prior_verification = true;
      rows[0].person_prior_verified_at = priorPersonDocs[0].verified_at;
    }
  }

  // Ledger completeness: a creation-time auto-verification is a successful
  // verification and must leave a person_documents row exactly like every
  // portal / auto-match / admin approval does. The anchoring issuing org is
  // the verifying organization; no identity cross-check runs at this point,
  // so match_status keeps its 'not_checked' DEFAULT.
  if (autoVerify && linkedPersonId) {
    await recordPersonDocument(rows[0], orgId, null);
  }

  // Auto-verified requests also get a public QR certificate. Capture the
  // generated token/signature so the response exposes the QR link to the
  // submitter instead of leaving them null in the payload.
  if (autoVerify) {
    const qr = await generateQrForRequest(rows[0]);
    if (qr && qr.qr_token) {
      rows[0].qr_token = qr.qr_token;
      rows[0].qr_signature = qr.qr_signature;
    }
  }

  // Inline reference match: when a reference employee document was staged for
  // the target org, run the actual document match right now at submission. A
  // 100% match auto-verifies immediately — the request never lands in the
  // target org's inbox — and the submitter is shown an "Auto Verified" modal.
  let autoMatched = false;
  if (orgId && !autoVerify && matchStatus === "not_attempted" && matchedEmployeeDocumentId) {
    let confidence = null;
    try {
      confidence = await computeMatchConfidence(rows[0]);
    } catch (e) {
      console.error(`Inline auto-match failed for request ${rows[0].uuid}:`, e.message);
    }
    if (confidence === 100) {
      const personContext = {
        person_known: rows[0].person_known,
        person_has_prior_verification: rows[0].person_has_prior_verification,
        person_prior_verified_at: rows[0].person_prior_verified_at,
      };
      await autoApprove(rows[0], confidence);
      const [freshRows] = await pool.query(
        `SELECT vr.*, o.uuid AS issuing_organization_uuid, o.name AS issuing_org_name,
                uo.uuid AS unmatched_org_uuid, uo.name AS unmatched_org_name
         FROM verification_requests vr
         LEFT JOIN organizations o ON o.id = vr.issuing_organization_id
         LEFT JOIN unmatched_organizations uo ON uo.id = vr.unmatched_org_id
         WHERE vr.id=?`,
        [result.insertId]
      );
      if (freshRows.length) {
        rows[0] = freshRows[0];
        Object.assign(rows[0], personContext);
      }
      rows[0].auto_verified = true;
      autoMatched = true;
    }
  }

  // A repeat submission of an already-verified file is also auto-verified from
  // the submitter's point of view: it is born 'verified' and never reaches the
  // target org's inbox. Flag it so the client shows the same "Auto Verified"
  // confirmation instead of a generic "request submitted" toast.
  if (autoVerify) {
    rows[0].auto_verified = true;
  }

  if (orgId && !autoVerify && !autoMatched) {
    const senderName = req.user.full_name || "Someone";
    createNotificationForOrgUsers({
      orgId,
      type: "verification_request",
      title: "New verification request",
      message: `${senderName} sent a "${document_type}" document for your verification.`,
      link: "/inbox",
      referenceId: rows[0].uuid,
      excludeUserId: req.user.id,
      requirePermission: "approve_request",
    }).catch((e) => console.error("Failed to create notification:", e.message));
  }

  logAudit({
    ...getActorFromReq(req),
    action: "request.create",
    entityType: "verification_request",
    entityId: rows[0].uuid,
    details: { document_type, status: rows[0].status },
    req,
  });

  return created(res, { request: rows[0] }, "Request created");
}

export async function mySentRequests(req, res) {
  const { page, limit, offset } = parsePagination(req.query);
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const dateFrom = typeof req.query.dateFrom === "string" ? req.query.dateFrom.trim() : "";
  const dateTo = typeof req.query.dateTo === "string" ? req.query.dateTo.trim() : "";

  let whereClause = "WHERE vr.user_id = ?";
  const params = [req.user.id];

  if (search) {
    whereClause += ` AND (vr.document_type LIKE ? OR o.name LIKE ? OR vr.document_format LIKE ? OR vr.status LIKE ?)`;
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }
  if (dateFrom) {
    whereClause += ` AND vr.created_at >= ?`;
    params.push(dateFrom);
  }
  if (dateTo) {
    whereClause += ` AND vr.created_at <= ?`;
    params.push(`${dateTo} 23:59:59`);
  }

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM verification_requests vr LEFT JOIN organizations o ON o.id = vr.issuing_organization_id ${whereClause}`,
    params
  );
  const [rows] = await pool.query(
    `SELECT vr.*, o.uuid AS issuing_organization_uuid, o.name AS issuing_org_name,
            o.logo AS issuing_org_logo,
            uo.uuid AS unmatched_org_uuid, uo.name AS unmatched_org_name,
            requester.full_name AS requester_name,
            requester_org.uuid AS requester_organization_uuid,
            requester_org.name AS requester_organization,
            requester_org.logo AS requester_org_logo,
            admin_locker.full_name AS locked_by_name
     FROM verification_requests vr
     JOIN users requester ON requester.id = vr.user_id
     LEFT JOIN organizations requester_org ON requester_org.id = requester.organization
     LEFT JOIN organizations o ON o.id = vr.issuing_organization_id
     LEFT JOIN unmatched_organizations uo ON uo.id = vr.unmatched_org_id
     LEFT JOIN admin_profiles admin_locker ON admin_locker.id = vr.locked_by
     ${whereClause}
     ORDER BY vr.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  return ok(res, paginatedResponse(rows, total, page, limit), "Sent requests");
}

export async function deleteMySentRequest(req, res) {
  const { uuid } = req.params;
  assertUuid(uuid, "Request UUID");

  // TODO: re-enable when org admins are allowed to delete requests.
  // if (req.user.org_role === "org_admin" || req.user.org_role === "sub_admin") {
  //   throw new ApiError(403, "Organization admins cannot delete verification requests.");
  // }

  const [allRows] = await pool.query(
    `SELECT id, status, user_id, locked_by
     FROM verification_requests
     WHERE uuid=?`,
    [uuid]
  );

  if (!allRows.length) throw new ApiError(404, "Request not found");
  if (allRows[0].user_id !== req.user.id) throw new ApiError(403, "Forbidden");

  if (allRows[0].status === "verified") {
    throw new ApiError(403, "Verified requests cannot be deleted — they are a permanent record.");
  }
  if (allRows[0].status === "unverified") {
    throw new ApiError(409, "Finalized request cannot be deleted");
  }
  if (allRows[0].locked_by) {
    throw new ApiError(403, "This request is locked and cannot be deleted.");
  }

  await pool.query("DELETE FROM verification_requests WHERE uuid=?", [uuid]);

  logAudit({
    ...getActorFromReq(req),
    action: "request.delete",
    entityType: "verification_request",
    entityId: uuid,
    details: { status: allRows[0].status },
    req,
  });

  return ok(res, {}, "Sent request deleted");
}

export async function updateMySentRequest(req, res) {
  const { uuid } = req.params;
  assertUuid(uuid, "Request UUID");

  const [allRows] = await pool.query(
    `SELECT id, status, user_id, document_path, document_format, document_hash, document_owner_name
     FROM verification_requests WHERE uuid=?`,
    [uuid]
  );

  if (!allRows.length) throw new ApiError(404, "Request not found");
  if (allRows[0].user_id !== req.user.id) throw new ApiError(403, "Forbidden");
  if (allRows[0].status !== "under_review") {
    throw new ApiError(409, "Only under_review requests can be edited");
  }

  const { document_type, issuing_organization_uuid,
          other_organization_name, submission_remarks,
          other_organization_email, other_organization_phone, other_organization_website,
          document_owner_name } = req.body;

  if (!document_type) throw new ApiError(400, "document_type is required");

  const orgId = await resolveOrganizationUuid(issuing_organization_uuid || null);
  const otherOrgName = other_organization_name ? String(other_organization_name).trim() : null;
  const remarks = submission_remarks ? String(submission_remarks).trim() : null;

  // Owner-field enforcement on the edit path, backward compatible: validate
  // ONLY what the caller provides. Old records whose fields were null before
  // this change stay editable — an omitted field (or an explicitly empty one
  // on an already-null record) is left untouched, never rejected.
  let documentOwnerName = allRows[0].document_owner_name ?? null;
  if ("document_owner_name" in req.body) {
    const submitted = String(req.body.document_owner_name ?? "").trim();
    if (submitted) {
      if (submitted.length > 200) {
        throw new ApiError(400, "document_owner_name must be 200 characters or fewer");
      }
      documentOwnerName = submitted;
    } else if (documentOwnerName) {
      // The owner name is required once set — it cannot be cleared to empty.
      throw new ApiError(400, "document_owner_name is required");
    }
    // submitted empty + previously null -> keep null, no error
  }

  if ("document_owner_cnic" in req.body) {
    const submittedCnic = String(req.body.document_owner_cnic ?? "").trim();
    if (submittedCnic) {
      const normalized = submittedCnic.replace(/\D/g, "");
      if (!/^\d{13}$/.test(normalized)) {
        throw new ApiError(400, "document_owner_cnic must be a valid CNIC (XXXXX-XXXXXXX-X)");
      }
    }
    // empty submitted cnic -> ignored (validation only; the request row has no
    // cnic column — a person link, if any, is managed at the create/verify side)
  }

  if (!orgId && !otherOrgName) {
    throw new ApiError(400, "other_organization_name is required when no organization is selected");
  }
  if (otherOrgName && otherOrgName.length > 200) {
    throw new ApiError(400, "other_organization_name must be 200 characters or fewer");
  }
  if (remarks && remarks.length > 500) {
    throw new ApiError(400, "submission_remarks must be 500 characters or fewer");
  }

  const otherEmail = other_organization_email ? String(other_organization_email).trim() : null;
  const otherPhone = other_organization_phone ? String(other_organization_phone).trim() : null;
  const otherWebsite = other_organization_website ? String(other_organization_website).trim() : null;

  if (otherEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(otherEmail)) {
    throw new ApiError(400, "other_organization_email must be a valid email address");
  }
  if (otherWebsite && otherWebsite.length > 500) {
    throw new ApiError(400, "other_organization_website must be 500 characters or fewer");
  }

  let docPath = allRows[0].document_path;
  let docFormat = allRows[0].document_format;
  let documentHash = allRows[0].document_hash;

  if (req.file) {
    docPath = `/uploads/documents/${req.file.filename}`;
    docFormat = docFormatFromMime(req.file.mimetype, req.file.originalname);
    const fullPath = path.join(DOCS_DIR, req.file.filename);
    documentHash = generateFileHash(fullPath);
    // Corrupt-file guard on the re-upload path (fails open only on
    // timeout / connection-refused; other service failures reject with 400).
    await assertDocumentValid(fullPath);
  }

  // Resolve unmatched organization if "Other" was selected
  let unmatchedOrgId = null;
  if (!orgId && otherOrgName) {
    unmatchedOrgId = await resolveUnmatchedOrg(otherOrgName, otherEmail, otherPhone, otherWebsite);
  }

  await pool.query(
    `UPDATE verification_requests
     SET document_type=?, issuing_organization_id=?, unmatched_org_id=?,
         submission_remarks=?, document_owner_name=?,
         document_path=?, document_format=?, document_hash=?
     WHERE uuid=?`,
    [document_type, orgId, unmatchedOrgId, remarks, documentOwnerName,
      docPath, docFormat, documentHash, uuid]
  );

  const [rows] = await pool.query(
    `SELECT vr.*, o.uuid AS issuing_organization_uuid, o.name AS issuing_org_name,
            uo.uuid AS unmatched_org_uuid, uo.name AS unmatched_org_name
     FROM verification_requests vr
     LEFT JOIN organizations o ON o.id = vr.issuing_organization_id
     LEFT JOIN unmatched_organizations uo ON uo.id = vr.unmatched_org_id
     WHERE vr.uuid=?`,
    [uuid]
  );

  logAudit({
    ...getActorFromReq(req),
    action: "request.update",
    entityType: "verification_request",
    entityId: uuid,
    req,
  });

  return ok(res, { request: rows[0] }, "Request updated");
}

export async function myInboxRequests(req, res) {
  requirePermission(req.user, "approve_request");
  if (!req.user.organization) throw new ApiError(400, "User has no organization");

  // Lazy SLA check on read (reminder + flag overdue requests)
  runSlaChecks().catch(() => {});

  // Lazy reference-match check on read (same fire-and-forget pattern)
  runAutoMatchChecks({ orgId: req.user.organization }).catch(() => {});

  const { page, limit, offset } = parsePagination(req.query);
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const dateFrom = typeof req.query.dateFrom === "string" ? req.query.dateFrom.trim() : "";
  const dateTo = typeof req.query.dateTo === "string" ? req.query.dateTo.trim() : "";

  let whereClause = "WHERE vr.issuing_organization_id = ?";
  const params = [req.user.organization];

  if (search) {
    whereClause += ` AND (requester.full_name LIKE ? OR requester.email LIKE ? OR vr.document_type LIKE ? OR vr.status LIKE ? OR requester_org.name LIKE ?)`;
    const like = `%${search}%`;
    params.push(like, like, like, like, like);
  }
  if (dateFrom) {
    whereClause += ` AND vr.created_at >= ?`;
    params.push(dateFrom);
  }
  if (dateTo) {
    whereClause += ` AND vr.created_at <= ?`;
    params.push(`${dateTo} 23:59:59`);
  }

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM verification_requests vr
     JOIN users requester ON requester.id = vr.user_id
     LEFT JOIN organizations requester_org ON requester_org.id = requester.organization
     ${whereClause}`,
    params
  );
  const [rows] = await pool.query(
    `SELECT vr.*,
            requester.uuid AS requester_uuid,
            requester.full_name AS requester_name,
            requester.email AS requester_email,
            requester_org.uuid AS requester_organization_uuid,
            requester_org.name AS requester_organization,
            requester_org.logo AS requester_org_logo,
            issuing_org.uuid AS issuing_organization_uuid,
            issuing_org.name AS issuing_org_name,
            issuing_org.logo AS issuing_org_logo,
            uo.uuid AS unmatched_org_uuid, uo.name AS unmatched_org_name,
            verifier.uuid AS verified_by_uuid,
            verifier.full_name AS verified_by_name,
            verifier.email AS verified_by_email,
            med.uuid AS matched_document_uuid,
            med.file_name AS matched_document_name,
            med.file_path AS matched_document_path,
            med.document_type AS matched_document_type,
            memp.full_name AS matched_employee_name,
            (SELECT MAX(pd.verified_at)
               FROM person_documents pd
              WHERE pd.person_id = vr.linked_person_id
                AND pd.status = 'verified'
                AND (pd.verified_by_verification_request_id IS NULL
                     OR pd.verified_by_verification_request_id <> vr.id)
            ) AS person_prior_verified_at
     FROM verification_requests vr
     JOIN users requester ON requester.id = vr.user_id
     LEFT JOIN organizations requester_org ON requester_org.id = requester.organization
     LEFT JOIN organizations issuing_org ON issuing_org.id = vr.issuing_organization_id
     LEFT JOIN unmatched_organizations uo ON uo.id = vr.unmatched_org_id
     LEFT JOIN users verifier ON verifier.id = vr.verified_by
     LEFT JOIN employee_documents med ON med.id = vr.matched_employee_document_id
     LEFT JOIN employees memp ON memp.uuid = med.employee_uuid
     ${whereClause}
     ORDER BY vr.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  const enriched = rows.map(r => ({
    ...r,
    person_known: Boolean(r.linked_person_id),
    person_has_prior_verification: r.person_prior_verified_at != null,
    match_mismatch_risk: hasMatchMismatchRisk(r),
  }));
  return ok(res, paginatedResponse(enriched, total, page, limit), "Inbox requests");
}

export async function getMyInboxRequestDetail(req, res) {
  requirePermission(req.user, "approve_request");
  assertUuid(req.params.uuid, "Request UUID");
  if (!req.user.organization) throw new ApiError(400, "User has no organization");

  const [rows] = await pool.query(
    `SELECT vr.*,
            requester.uuid AS requester_uuid,
            requester.full_name AS requester_name,
            requester.email AS requester_email,
            requester_org.uuid AS requester_organization_uuid,
            requester_org.name AS requester_organization,
            requester_org.logo AS requester_org_logo,
            issuing_org.uuid AS issuing_organization_uuid,
            issuing_org.name AS issuing_org_name,
            issuing_org.logo AS issuing_org_logo,
            uo.uuid AS unmatched_org_uuid, uo.name AS unmatched_org_name,
            verifier.uuid AS verified_by_uuid,
            verifier.full_name AS verified_by_name,
            verifier.email AS verified_by_email,
            med.uuid AS matched_document_uuid,
            med.file_name AS matched_document_name,
            med.file_path AS matched_document_path,
            med.document_type AS matched_document_type,
            memp.full_name AS matched_employee_name
     FROM verification_requests vr
     JOIN users requester ON requester.id = vr.user_id
     LEFT JOIN organizations requester_org ON requester_org.id = requester.organization
     LEFT JOIN organizations issuing_org ON issuing_org.id = vr.issuing_organization_id
     LEFT JOIN unmatched_organizations uo ON uo.id = vr.unmatched_org_id
     LEFT JOIN users verifier ON verifier.id = vr.verified_by
     LEFT JOIN employee_documents med ON med.id = vr.matched_employee_document_id
     LEFT JOIN employees memp ON memp.uuid = med.employee_uuid
     WHERE vr.uuid=?`,
    [req.params.uuid]
  );

  if (!rows.length) throw new ApiError(404, "Request not found");
  const vr = rows[0];
  if (vr.issuing_organization_id !== req.user.organization) {
    throw new ApiError(403, "You are not allowed to view this request");
  }

  // Lazy reference-match check on read (fire-and-forget; results appear on next fetch)
  runAutoMatchChecks({ requestId: vr.id }).catch(() => {});

  const detail = { ...vr, has_prior_verification: false, prior_verified_at: null };

  // Prior-verification hint: if the request was linked to a person at creation
  // time, check whether this exact document was already verified for that
  // person. Deliberately generic — the verifying organization is not exposed.
  if (vr.linked_person_id && vr.document_hash) {
    const [priorRows] = await pool.query(
      `SELECT verified_at
       FROM person_documents
       WHERE person_id=? AND document_hash=? AND status='verified'
       ORDER BY verified_at DESC
       LIMIT 1`,
      [vr.linked_person_id, vr.document_hash]
    );
    if (priorRows.length) {
      detail.has_prior_verification = true;
      detail.prior_verified_at = priorRows[0].verified_at;
    }
  }

  // Person-level prior-verification context: has this person (by CNIC) been
  // verified for ANY document before, at any organization? The current
  // request's own ledger row is excluded so this reads as a true prior-history
  // signal. Informational context only — never an approval signal.
  detail.person_known = Boolean(vr.linked_person_id);
  detail.person_has_prior_verification = false;
  detail.person_prior_verified_at = null;

  if (vr.linked_person_id) {
    const [personPriorRows] = await pool.query(
      `SELECT verified_at
       FROM person_documents
       WHERE person_id=? AND status='verified'
         AND (verified_by_verification_request_id IS NULL
              OR verified_by_verification_request_id <> ?)
       ORDER BY verified_at DESC
       LIMIT 1`,
      [vr.linked_person_id, vr.id]
    );
    if (personPriorRows.length) {
      detail.person_has_prior_verification = true;
      detail.person_prior_verified_at = personPriorRows[0].verified_at;
    }
  }

  detail.match_mismatch_risk = hasMatchMismatchRisk(vr);

  return ok(res, { request: detail }, "Request detail");
}

export async function myInboxCount(req, res) {
  requirePermission(req.user, "approve_request");
  if (!req.user.organization) return ok(res, { count: 0 }, "Inbox count");

  // Lazy SLA check on read
  runSlaChecks().catch(() => {});

  const [[{ count }]] = await pool.query(
    `SELECT COUNT(*) AS count FROM verification_requests
     WHERE issuing_organization_id = ? AND status = 'under_review'`,
    [req.user.organization]
  );

  return ok(res, { count }, "Inbox count");
}

/**
 * Auto-verified requests for the caller's own organization.
 *
 * These are the requests this organization auto-verified itself: the reference
 * match scored 100% against a stored employee document, so the request was
 * approved at submission time and never appeared in the inbox. This is the
 * read-only ledger of those outcomes.
 *
 * doc_verification_count is a cross-organization total: how many times this
 * same person's document of this type has been verified anywhere on the
 * platform (2 by one company + 3 by another = 5).
 *
 * Results are grouped by (person, document type) so a document verified ten
 * times occupies a single row showing "10", rather than ten near-identical rows.
 */
export async function myAutoVerifiedRequests(req, res) {
  requirePermission(req.user, "approve_request");
  if (!req.user.organization) throw new ApiError(400, "User has no organization");

  const { page, limit, offset } = parsePagination(req.query);
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const dateFrom = typeof req.query.dateFrom === "string" ? req.query.dateFrom.trim() : "";
  const dateTo = typeof req.query.dateTo === "string" ? req.query.dateTo.trim() : "";

  // Both automatic outcomes count as "auto verified" for this ledger: the
  // reference match ('automatic_match') and the repeat-of-an-already-verified
  // file ('auto'). Neither ever appears in the inbox, so both belong here —
  // otherwise they would be invisible in the product.
  let whereClause =
    "WHERE vr2.issuing_organization_id = ? AND vr2.status = 'verified' AND vr2.verification_method IN ('automatic_match', 'auto')";
  const params = [req.user.organization];

  if (search) {
    whereClause += ` AND (vr2.document_type LIKE ? OR vr2.document_owner_name LIKE ? OR requester.full_name LIKE ? OR requester_org.name LIKE ?)`;
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }
  if (dateFrom) {
    whereClause += ` AND vr2.verified_at >= ?`;
    params.push(dateFrom);
  }
  if (dateTo) {
    whereClause += ` AND vr2.verified_at <= ?`;
    params.push(`${dateTo} 23:59:59`);
  }

  // One row per (person, document type): repeated verifications of the same
  // document collapse into a single line whose doc_verification_count reports
  // the total. `latest_id` is the newest request in the group and supplies all
  // the row-level detail (requester, owner, QR, timestamps).
  const groupedSql = `
    SELECT MAX(vr2.id) AS latest_id, vr2.linked_person_id, vr2.document_type
    FROM verification_requests vr2
    JOIN users requester ON requester.id = vr2.user_id
    LEFT JOIN organizations requester_org ON requester_org.id = requester.organization
    ${whereClause}
    GROUP BY vr2.linked_person_id, vr2.document_type`;

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM (${groupedSql}) grouped`,
    params
  );

  const [rows] = await pool.query(
    `SELECT vr.*,
            requester.uuid AS requester_uuid,
            requester.full_name AS requester_name,
            requester.email AS requester_email,
            requester_org.uuid AS requester_organization_uuid,
            requester_org.name AS requester_organization,
            requester_org.logo AS requester_org_logo,
            issuing_org.uuid AS issuing_organization_uuid,
            issuing_org.name AS issuing_org_name,
            issuing_org.logo AS issuing_org_logo,
            (SELECT COUNT(*) FROM person_documents pd
              WHERE pd.person_id = vr.linked_person_id
                AND pd.document_type = vr.document_type
                AND pd.status = 'verified'
            ) AS doc_verification_count
     FROM verification_requests vr
     JOIN (${groupedSql}) g ON g.latest_id = vr.id
     JOIN users requester ON requester.id = vr.user_id
     LEFT JOIN organizations requester_org ON requester_org.id = requester.organization
     LEFT JOIN organizations issuing_org ON issuing_org.id = vr.issuing_organization_id
     ORDER BY vr.verified_at DESC, vr.id DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  return ok(res, paginatedResponse(rows, total, page, limit), "Auto-verified requests");
}

/**
 * Full verification history for one auto-verified request's document.
 *
 * Reads the person_documents ledger for the same person + document type across
 * EVERY organization, newest first, so the caller can see which companies have
 * verified this document and how many times. Read-only: no delete, no mutation.
 */
export async function getAutoVerifiedRequestHistory(req, res) {
  requirePermission(req.user, "approve_request");
  const { uuid } = req.params;
  assertUuid(uuid, "Request UUID");
  if (!req.user.organization) throw new ApiError(400, "User has no organization");

  const [rows] = await pool.query(
    `SELECT vr.id, vr.uuid, vr.issuing_organization_id, vr.linked_person_id,
            vr.document_type, vr.document_owner_name, p.uuid AS person_uuid
     FROM verification_requests vr
     LEFT JOIN persons p ON p.id = vr.linked_person_id
     WHERE vr.uuid = ?`,
    [uuid]
  );
  if (!rows.length) throw new ApiError(404, "Request not found");

  const vr = rows[0];
  if (vr.issuing_organization_id !== req.user.organization) {
    throw new ApiError(403, "You are not allowed to view this request");
  }
  if (!vr.linked_person_id) {
    return ok(res, { history: [], total_verifications: 0 }, "Verification history");
  }

  const [history] = await pool.query(
    `SELECT pd.id, pd.uuid, pd.document_type, pd.document_hash, pd.verified_at, pd.status,
            pd.match_status AS cross_check_status,
            org.uuid AS verified_by_organization_uuid,
            org.name AS verified_by_organization,
            org.logo AS verified_by_organization_logo,
            vr.uuid AS verification_request_uuid,
            vr.verification_method
     FROM person_documents pd
     LEFT JOIN organizations org ON org.id = pd.verified_by_organization_id
     LEFT JOIN verification_requests vr ON vr.id = pd.verified_by_verification_request_id
     WHERE pd.person_id = ? AND pd.document_type <=> ? AND pd.status = 'verified'
     ORDER BY pd.verified_at DESC, pd.id DESC`,
    [vr.linked_person_id, vr.document_type]
  );

  return ok(
    res,
    {
      person_uuid: vr.person_uuid,
      document_type: vr.document_type,
      document_owner_name: vr.document_owner_name,
      total_verifications: history.length,
      history,
    },
    "Verification history"
  );
}

export async function verifyRequest(req, res) {
  const { uuid } = req.params;
  const { status, verification_remarks } = req.body;

  requirePermission(req.user, "approve_request");
  assertUuid(uuid, "Request UUID");
  if (!["verified", "unverified"].includes(status)) throw new ApiError(400, "status must be verified or unverified");
  if (!req.user.organization) throw new ApiError(400, "User has no organization");

  await assertOrganizationActive(req.user.organization);

  const [rows] = await pool.query("SELECT * FROM verification_requests WHERE uuid=?", [uuid]);
  if (!rows.length) throw new ApiError(404, "Request not found");

  const vr = rows[0];
  if (vr.issuing_organization_id !== req.user.organization) {
    throw new ApiError(403, "You are not allowed to verify this request");
  }
  if (["verified", "unverified"].includes(vr.status)) throw new ApiError(409, "Request already finalized");

  await pool.query(
    `UPDATE verification_requests
     SET status=?, verified_at=NOW(), verified_by=?, verification_remarks=?,
         verification_method='portal'
     WHERE uuid=?`,
    [status, req.user.id, verification_remarks || null, uuid]
  );

  const [updated] = await pool.query(
    `SELECT vr.*, o.uuid AS issuing_organization_uuid, o.name AS issuing_org_name,
            uo.uuid AS unmatched_org_uuid, uo.name AS unmatched_org_name
     FROM verification_requests vr
     LEFT JOIN organizations o ON o.id = vr.issuing_organization_id
     LEFT JOIN unmatched_organizations uo ON uo.id = vr.unmatched_org_id
     WHERE vr.uuid=?`,
    [uuid]
  );

  // Verified requests get a tamper-evident public QR certificate
  if (status === "verified") {
    await generateQrForRequest(updated[0]);
  }

  // Append to the person's document history (accumulates across re-verifications)
  if (status === "verified") {
    // Data-quality signal (never a blocker): OCR the submitted document once
    // and cross-check the extracted identity fields against the form-entered
    // ones, caching the result on the person_documents row so a future NADRA
    // script can re-verify without OCR. Service outage -> 'not_checked', the
    // approval itself is unaffected.
    const crossCheck = await buildDocumentCrossCheck(updated[0]);
    await recordPersonDocument(updated[0], req.user.organization, crossCheck);
    updated[0].document_consistency = crossCheck;
  }

  // Notify the requester
  const [requester] = await pool.query(
    `SELECT u.uuid, u.organization FROM users u WHERE u.id=?`,
    [vr.user_id]
  );
  if (requester.length) {
    const requesterUuid = requester[0].uuid;
    const senderOrg = await pool.query("SELECT name FROM organizations WHERE id=?", [req.user.organization]);
    const orgName = senderOrg[0].length ? senderOrg[0][0].name : "An organization";
    const statusText = status === "verified" ? "Approved" : "Rejected";
    try {
      await createNotificationForUsers({
        userIds: [requesterUuid],
        type: "request_verified",
        title: `Request ${statusText.toLowerCase()}`,
        message: `Your "${vr.document_type}" request was ${statusText} by ${orgName}.`,
        link: "/requests",
        referenceId: uuid,
      });
    } catch (e) {
      console.error("Failed to create requester notification:", e.message);
    }
  } else {
    console.error(`Could not notify requester: user_id ${vr.user_id} not found`);
  }

  // Email the org the request came FROM once it is approved — to the org's
  // business email + its org admins (deduplicated).
  if (status === "verified") {
    const reqOrgId = requester.length ? requester[0].organization : null;
    if (reqOrgId) {
      try {
        await sendVerificationResultEmailToOrg({
          orgId: reqOrgId,
          documentType: vr.document_type,
          portalLink: `${firstFrontendUrl(process.env.FRONTEND_URL, "http://localhost:8080")}/requests`,
        });
      } catch (e) {
        console.error("Failed to send verification result email to org:", e.message);
      }
    }
  }

  logAudit({
    ...getActorFromReq(req),
    action: status === "verified" ? "request.verify" : "request.reject",
    entityType: "verification_request",
    entityId: uuid,
    details: { status, method: "portal" },
    req,
  });

  return ok(res, { request: updated[0] }, "Request updated");
}

export async function listOrganizations(req, res) {
  const [rows] = await pool.query(
    `SELECT DISTINCT o.uuid, o.name, o.verified, o.logo,
            COALESCE(ot.name, o.organization_type) AS organization_type, o.created_at
     FROM organizations o
     LEFT JOIN organization_types ot ON ot.id = o.organization_type
     WHERE o.verified='yes'
       AND o.deleted_at IS NULL
       AND o.id <> ?
     ORDER BY o.created_at DESC`,
    [req.user.organization]
  );

  return ok(res, { items: rows }, "Organizations list");
}