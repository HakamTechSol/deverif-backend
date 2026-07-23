import ApiError from "../utils/ApiError.js";
import { pool } from "../config/db.js";
import { created, ok } from "../utils/response.js";
import { assertUuid } from "../utils/publicResponse.js";
import { parsePagination, paginatedResponse } from "../utils/pagination.js";
import { createNotificationForOrgUsers } from "./notification.controller.js";
import { assertOrganizationActive } from "./admin/organizations.controller.js";
import crypto from "crypto";
import fs from "fs";

function docFormatFromMime(m) {
  if (m === "application/pdf") return "pdf";
  if (m === "image/jpeg") return "jpeg";
  return "jpeg";
}

function generateFileHash(filePath) {
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
  const { document_type, issuing_organization_uuid, priority,
          other_organization_name, submission_remarks } = req.body;

  if ("issuing_organization_id" in req.body) {
    throw new ApiError(400, "issuing_organization_uuid is required; integer IDs are not accepted");
  }
  if (!document_type) throw new ApiError(400, "document_type is required");
  if (!req.file) throw new ApiError(400, "document file is required");

  if (req.user.organization) {
    await assertOrganizationActive(req.user.organization);
  }

  const orgId = await resolveOrganizationUuid(issuing_organization_uuid || null);

  const otherOrgName = other_organization_name ? String(other_organization_name).trim() : null;
  const remarks = submission_remarks ? String(submission_remarks).trim() : null;

  if (!orgId && !otherOrgName) {
    throw new ApiError(400, "other_organization_name is required when no organization is selected");
  }
  if (otherOrgName && otherOrgName.length > 200) {
    throw new ApiError(400, "other_organization_name must be 200 characters or fewer");
  }
  if (remarks && remarks.length > 500) {
    throw new ApiError(400, "submission_remarks must be 500 characters or fewer");
  }

  const pri = priority === "urgent" ? "urgent" : "normal";
  const docPath = `/uploads/documents/${req.file.filename}`;
  const fullPath = `./uploads/documents/${req.file.filename}`;
  const docFormat = docFormatFromMime(req.file.mimetype);
  const documentHash = generateFileHash(fullPath);

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
     (user_id, document_type, issuing_organization_id, status, priority, submitted_at,
      document_path, document_format, document_hash,
      organization_conserned_for_future, other_organization_name, submission_remarks,
      verification_method, verified_at, created_at)
     VALUES (?, ?, ?, ?, ?, NOW(), ?, ?, ?, 'no', ?, ?, ?, ?, NOW())`,
    [
      req.user.id,
      document_type,
      orgId,
      autoVerify ? "verified" : "under_review",
      pri,
      docPath,
      docFormat,
      documentHash,
      otherOrgName,
      remarks,
      autoVerify ? "auto" : "manual",
      autoVerify ? new Date() : null
    ]
  );

  const [rows] = await pool.query(
    `SELECT vr.*, o.uuid AS issuing_organization_uuid, o.name AS issuing_org_name
     FROM verification_requests vr
     LEFT JOIN organizations o ON o.id = vr.issuing_organization_id
     WHERE vr.id=?`,
    [result.insertId]
  );

  if (orgId && !autoVerify) {
    const senderName = req.user.full_name || "Someone";
    createNotificationForOrgUsers({
      orgId,
      type: "verification_request",
      title: "New verification request",
      message: `${senderName} sent a "${document_type}" document for your verification.`,
      link: "/inbox",
      referenceId: rows[0].uuid,
    }).catch((e) => console.error("Failed to create notification:", e.message));
  }

  return created(res, { request: rows[0] }, "Request created");
}

export async function mySentRequests(req, res) {
  const { page, limit, offset } = parsePagination(req.query);
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";

  let whereClause = "WHERE vr.user_id = ?";
  const params = [req.user.id];

  if (search) {
    whereClause += ` AND (vr.document_type LIKE ? OR o.name LIKE ? OR vr.document_format LIKE ? OR vr.status LIKE ?)`;
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM verification_requests vr LEFT JOIN organizations o ON o.id = vr.issuing_organization_id ${whereClause}`,
    params
  );
  const [rows] = await pool.query(
    `SELECT vr.*, o.uuid AS issuing_organization_uuid, o.name AS issuing_org_name
     FROM verification_requests vr
     LEFT JOIN organizations o ON o.id = vr.issuing_organization_id
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

  const [allRows] = await pool.query(
    `SELECT id, status, user_id
     FROM verification_requests
     WHERE uuid=?`,
    [uuid]
  );

  if (!allRows.length) throw new ApiError(404, "Request not found");
  if (allRows[0].user_id !== req.user.id) throw new ApiError(403, "Forbidden");

  if (["verified", "unverified"].includes(allRows[0].status)) {
    throw new ApiError(409, "Finalized request cannot be deleted");
  }

  await pool.query("DELETE FROM verification_requests WHERE uuid=?", [uuid]);
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

  const { document_type, issuing_organization_uuid, priority,
          other_organization_name, submission_remarks } = req.body;

  if (!document_type) throw new ApiError(400, "document_type is required");

  const orgId = await resolveOrganizationUuid(issuing_organization_uuid || null);
  const otherOrgName = other_organization_name ? String(other_organization_name).trim() : null;
  const remarks = submission_remarks ? String(submission_remarks).trim() : null;

  if (!orgId && !otherOrgName) {
    throw new ApiError(400, "other_organization_name is required when no organization is selected");
  }
  if (otherOrgName && otherOrgName.length > 200) {
    throw new ApiError(400, "other_organization_name must be 200 characters or fewer");
  }
  if (remarks && remarks.length > 500) {
    throw new ApiError(400, "submission_remarks must be 500 characters or fewer");
  }

  const pri = priority === "urgent" ? "urgent" : "normal";
  let docPath = allRows[0].document_path;
  let docFormat = allRows[0].document_format;
  let documentHash = allRows[0].document_hash;

  if (req.file) {
    docPath = `/uploads/documents/${req.file.filename}`;
    docFormat = docFormatFromMime(req.file.mimetype);
    documentHash = generateFileHash(`./uploads/documents/${req.file.filename}`);
  }

  await pool.query(
    `UPDATE verification_requests
     SET document_type=?, issuing_organization_id=?, priority=?,
         other_organization_name=?, submission_remarks=?,
         document_path=?, document_format=?, document_hash=?
     WHERE uuid=?`,
    [document_type, orgId, pri, otherOrgName, remarks, docPath, docFormat, documentHash, uuid]
  );

  const [rows] = await pool.query(
    `SELECT vr.*, o.uuid AS issuing_organization_uuid, o.name AS issuing_org_name
     FROM verification_requests vr
     LEFT JOIN organizations o ON o.id = vr.issuing_organization_id
     WHERE vr.uuid=?`,
    [uuid]
  );

  return ok(res, { request: rows[0] }, "Request updated");
}

export async function myInboxRequests(req, res) {
  if (!req.user.organization) throw new ApiError(400, "User has no organization");

  const { page, limit, offset } = parsePagination(req.query);
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";

  let whereClause = "WHERE vr.issuing_organization_id = ?";
  const params = [req.user.organization];

  if (search) {
    whereClause += ` AND (requester.full_name LIKE ? OR requester.email LIKE ? OR vr.document_type LIKE ? OR vr.status LIKE ? OR requester_org.name LIKE ?)`;
    const like = `%${search}%`;
    params.push(like, like, like, like, like);
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
            issuing_org.uuid AS issuing_organization_uuid
     FROM verification_requests vr
     JOIN users requester ON requester.id = vr.user_id
     LEFT JOIN organizations requester_org ON requester_org.id = requester.organization
     LEFT JOIN organizations issuing_org ON issuing_org.id = vr.issuing_organization_id
     ${whereClause}
     ORDER BY vr.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  return ok(res, paginatedResponse(rows, total, page, limit), "Inbox requests");
}

export async function myInboxCount(req, res) {
  if (!req.user.organization) return ok(res, { count: 0 }, "Inbox count");

  const [[{ count }]] = await pool.query(
    `SELECT COUNT(*) AS count FROM verification_requests
     WHERE issuing_organization_id = ? AND status = 'under_review'`,
    [req.user.organization]
  );

  return ok(res, { count }, "Inbox count");
}

export async function verifyRequest(req, res) {
  const { uuid } = req.params;
  const { status, verification_remarks, organization_conserned_for_future } = req.body;

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

  const futureConcerned = status === "verified" && organization_conserned_for_future === "yes" ? "yes" : "no";

  await pool.query(
    `UPDATE verification_requests
     SET status=?, verified_at=NOW(), verified_by=?, verification_remarks=?,
         organization_conserned_for_future=?, verification_method='portal'
     WHERE uuid=?`,
    [status, req.user.id, verification_remarks || null, futureConcerned, uuid]
  );

  const [updated] = await pool.query(
    `SELECT vr.*, o.uuid AS issuing_organization_uuid, o.name AS issuing_org_name
     FROM verification_requests vr
     LEFT JOIN organizations o ON o.id = vr.issuing_organization_id
     WHERE vr.uuid=?`,
    [uuid]
  );

  return ok(res, { request: updated[0] }, "Request updated");
}

export async function listOrganizations(req, res) {
  const [rows] = await pool.query(
    `SELECT uuid, name, verified, logo, organization_type, created_at
     FROM organizations
     WHERE verified='yes'
       AND (id <> ? OR ? IS NULL)
     ORDER BY created_at DESC`,
    [req.user.organization || null, req.user.organization || null]
  );

  return ok(res, { items: rows }, "Organizations list");
}