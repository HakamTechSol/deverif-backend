import ApiError from "../utils/ApiError.js";
import { pool } from "../config/db.js";
import { encryptCnic, hashCnic } from "../utils/personCrypto.js";
import { recordPersonDocument } from "../utils/personDocuments.js";
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
import { sendVerificationResultEmailToOrg } from "../utils/mailer.js";
import { firstFrontendUrl } from "../utils/frontendUrl.js";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { DOCS_DIR } from "../config/uploadPaths.js";
import { requirePermission } from "../utils/permissions.js";

function docFormatFromMime(m) {
  if (m === "application/pdf") return "pdf";
  if (m === "image/jpeg") return "jpeg";
  return "jpeg";
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

  const documentOwnerName = document_owner_name ? String(document_owner_name).trim() : null;
  if (documentOwnerName && documentOwnerName.length > 200) {
    throw new ApiError(400, "document_owner_name must be 200 characters or fewer");
  }

  const rawOwnerCnic = document_owner_cnic ? String(document_owner_cnic).trim() : null;
  let documentOwnerCnic = null;
  let documentOwnerCnicHash = null;
  if (rawOwnerCnic) {
    const normalized = rawOwnerCnic.replace(/\D/g, "");
    if (!/^\d{13}$/.test(normalized)) {
      throw new ApiError(400, "document_owner_cnic must be a valid CNIC (XXXXX-XXXXXXX-X)");
    }
    documentOwnerCnic = encryptCnic(normalized);
    documentOwnerCnicHash = hashCnic(normalized);
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

  const docPath = `/uploads/documents/${req.file.filename}`;
  const fullPath = path.join(DOCS_DIR, req.file.filename);
  const docFormat = docFormatFromMime(req.file.mimetype);
  const documentHash = generateFileHash(fullPath);

  // Resolve unmatched organization if "Other" was selected
  let unmatchedOrgId = null;
  if (!orgId && otherOrgName) {
    unmatchedOrgId = await resolveUnmatchedOrg(otherOrgName, otherEmail, otherPhone, otherWebsite);
  }

  let autoVerify = false;
  if (orgId) {
    const [previousVerified] = await pool.query(
      `SELECT id
       FROM verification_requests
       WHERE document_hash=?
         AND issuing_organization_id=?
         AND status='verified'
         AND organization_conserned_for_future='yes'
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
     VALUES (?, ?, ?, ?, ?, NOW(), ?, ?, ?, 'no', ?, ?, ?, ?, NOW())`,
    [
      req.user.id,
      document_type,
      orgId,
      unmatchedOrgId,
      autoVerify ? "verified" : "under_review",
      docPath,
      docFormat,
      documentHash,
      remarks,
      autoVerify ? "auto" : "manual",
      autoVerify ? new Date() : null,
      documentOwnerName
    ]
  );

  // Link the request to a persons row when a document owner CNIC was given.
  // Case A: no matching person yet -> create one (full_name taken from the
  // unverified claim; never trusted over an existing record).
  // Case B: person already exists -> reuse it, keep the original name.
  if (documentOwnerCnicHash) {
    const [personRows] = await pool.query(
      `SELECT id FROM persons WHERE cnic_hash=? LIMIT 1`,
      [documentOwnerCnicHash]
    );

    let linkedPersonId;
    if (personRows.length) {
      linkedPersonId = personRows[0].id;
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
            uo.uuid AS unmatched_org_uuid, uo.name AS unmatched_org_name
     FROM verification_requests vr
     LEFT JOIN organizations o ON o.id = vr.issuing_organization_id
     LEFT JOIN unmatched_organizations uo ON uo.id = vr.unmatched_org_id
     WHERE vr.id=?`,
    [result.insertId]
  );

  // Auto-verified requests also get a public QR certificate
  if (autoVerify) {
    await generateQrForRequest(rows[0]);
  }

  if (orgId && !autoVerify) {
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
            uo.uuid AS unmatched_org_uuid, uo.name AS unmatched_org_name,
            requester.full_name AS requester_name,
            requester_org.uuid AS requester_organization_uuid,
            requester_org.name AS requester_organization,
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
    `SELECT id, status, user_id, document_path, document_format, document_hash
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

  const documentOwnerName = document_owner_name ? String(document_owner_name).trim() : null;
  if (documentOwnerName && documentOwnerName.length > 200) {
    throw new ApiError(400, "document_owner_name must be 200 characters or fewer");
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
    docFormat = docFormatFromMime(req.file.mimetype);
    documentHash = generateFileHash(path.join(DOCS_DIR, req.file.filename));
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
            issuing_org.uuid AS issuing_organization_uuid,
            issuing_org.name AS issuing_org_name,
            uo.uuid AS unmatched_org_uuid, uo.name AS unmatched_org_name,
            verifier.uuid AS verified_by_uuid,
            verifier.full_name AS verified_by_name,
            verifier.email AS verified_by_email
     FROM verification_requests vr
     JOIN users requester ON requester.id = vr.user_id
     LEFT JOIN organizations requester_org ON requester_org.id = requester.organization
     LEFT JOIN organizations issuing_org ON issuing_org.id = vr.issuing_organization_id
     LEFT JOIN unmatched_organizations uo ON uo.id = vr.unmatched_org_id
     LEFT JOIN users verifier ON verifier.id = vr.verified_by
     ${whereClause}
     ORDER BY vr.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  return ok(res, paginatedResponse(rows, total, page, limit), "Inbox requests");
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
            issuing_org.uuid AS issuing_organization_uuid,
            issuing_org.name AS issuing_org_name,
            uo.uuid AS unmatched_org_uuid, uo.name AS unmatched_org_name,
            verifier.uuid AS verified_by_uuid,
            verifier.full_name AS verified_by_name,
            verifier.email AS verified_by_email
     FROM verification_requests vr
     JOIN users requester ON requester.id = vr.user_id
     LEFT JOIN organizations requester_org ON requester_org.id = requester.organization
     LEFT JOIN organizations issuing_org ON issuing_org.id = vr.issuing_organization_id
     LEFT JOIN unmatched_organizations uo ON uo.id = vr.unmatched_org_id
     LEFT JOIN users verifier ON verifier.id = vr.verified_by
     WHERE vr.uuid=?`,
    [req.params.uuid]
  );

  if (!rows.length) throw new ApiError(404, "Request not found");
  const vr = rows[0];
  if (vr.issuing_organization_id !== req.user.organization) {
    throw new ApiError(403, "You are not allowed to view this request");
  }

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
    await recordPersonDocument(updated[0], req.user.organization);
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