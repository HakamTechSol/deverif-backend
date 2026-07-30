import ApiError from "../../utils/ApiError.js";
import { pool } from "../../config/db.js";
import { ok } from "../../utils/response.js";
import { assertUuid } from "../../utils/publicResponse.js";
import { parsePagination, paginatedResponse } from "../../utils/pagination.js";
import { createNotificationForUsers } from "../notification.controller.js";

const REQUEST_SELECT = `SELECT vr.*,
        requester.uuid AS requester_uuid,
        requester.full_name AS requester_name,
        requester.email AS requester_email,
        issuing_org.uuid AS issuing_organization_uuid,
        issuing_org.name AS issuing_org_name,
        uo.uuid AS unmatched_org_uuid, uo.name AS unmatched_org_name,
        locker.uuid AS locked_by_uuid, locker.full_name AS locked_by_name
 FROM verification_requests vr
 JOIN users requester ON requester.id = vr.user_id
 LEFT JOIN organizations issuing_org ON issuing_org.id = vr.issuing_organization_id
 LEFT JOIN unmatched_organizations uo ON uo.id = vr.unmatched_org_id
 LEFT JOIN users locker ON locker.id = vr.locked_by`;

export async function listAllRequests(req, res) {
  const { page, limit, offset } = parsePagination(req.query);
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const statusFilter = typeof req.query.status === "string" ? req.query.status.trim() : "";
  const dateFrom = typeof req.query.dateFrom === "string" ? req.query.dateFrom.trim() : "";
  const dateTo = typeof req.query.dateTo === "string" ? req.query.dateTo.trim() : "";

  let whereClause = "";
  const params = [];

  const conditions = [];
  if (search) {
    conditions.push(`(requester.full_name LIKE ? OR requester.email LIKE ? OR vr.document_type LIKE ? OR issuing_org.name LIKE ? OR vr.document_format LIKE ? OR vr.uuid LIKE ?)`);
    const like = `%${search}%`;
    params.push(like, like, like, like, like, like);
  }
  if (statusFilter && ["under_review", "verified", "unverified"].includes(statusFilter)) {
    conditions.push(`vr.status = ?`);
    params.push(statusFilter);
  }
  if (dateFrom) {
    conditions.push(`vr.created_at >= ?`);
    params.push(dateFrom);
  }
  if (dateTo) {
    conditions.push(`vr.created_at <= ?`);
    params.push(`${dateTo} 23:59:59`);
  }
  whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM verification_requests vr
     JOIN users requester ON requester.id = vr.user_id
     LEFT JOIN organizations issuing_org ON issuing_org.id = vr.issuing_organization_id
     ${whereClause}`,
    params
  );
  const [rows] = await pool.query(
    `${REQUEST_SELECT} ${whereClause} ORDER BY vr.created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return ok(res, paginatedResponse(rows, total, page, limit), "All verification requests");
}

export async function deleteRequest(req, res) {
  const { uuid } = req.params;
  assertUuid(uuid, "Request UUID");

  const [exists] = await pool.query("SELECT id, status, locked_by FROM verification_requests WHERE uuid=?", [uuid]);
  if (!exists.length) throw new ApiError(404, "Request not found");

  if (exists[0].status === "verified") {
    throw new ApiError(403, "Verified requests cannot be deleted — they are a permanent record.");
  }
  if (exists[0].locked_by) {
    throw new ApiError(403, "This request is locked and cannot be deleted.");
  }

  await pool.query("DELETE FROM verification_requests WHERE uuid=?", [uuid]);
  return ok(res, {}, "Verification request deleted");
}

export async function listNullOrganizationRequests(req, res) {
  const { page, limit, offset } = parsePagination(req.query);
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const dateFrom = typeof req.query.dateFrom === "string" ? req.query.dateFrom.trim() : "";
  const dateTo = typeof req.query.dateTo === "string" ? req.query.dateTo.trim() : "";

  let whereClause = "";
  const params = [];
  const conditions = [];

  if (search) {
    conditions.push("(uo.name LIKE ? OR uo.email LIKE ? OR uo.phone LIKE ?)");
    const like = `%${search}%`;
    params.push(like, like, like);
  }
  if (dateFrom) {
    conditions.push("uo.created_at >= ?");
    params.push(dateFrom);
  }
  if (dateTo) {
    conditions.push("uo.created_at <= ?");
    params.push(`${dateTo} 23:59:59`);
  }
  if (conditions.length) {
    whereClause = `WHERE ${conditions.join(" AND ")}`;
  }

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM unmatched_organizations uo ${whereClause}`,
    params
  );

  const [orgs] = await pool.query(
    `SELECT uo.*,
            COUNT(vr.id) AS request_count
     FROM unmatched_organizations uo
     LEFT JOIN verification_requests vr ON vr.unmatched_org_id = uo.id
     ${whereClause}
     GROUP BY uo.id
     ORDER BY uo.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  return ok(res, paginatedResponse(orgs, total, page, limit), "Unmatched organizations");
}

export async function getUnmatchedOrgDetail(req, res) {
  const { uuid } = req.params;
  assertUuid(uuid, "Unmatched Organization UUID");

  const [[org]] = await pool.query(
    "SELECT * FROM unmatched_organizations WHERE uuid=?",
    [uuid]
  );
  if (!org) throw new ApiError(404, "Unmatched organization not found");

  const [requests] = await pool.query(
    `SELECT vr.uuid, vr.document_type, vr.document_format, vr.document_path, vr.status, vr.submitted_at,
            vr.verified_at, vr.submission_remarks, vr.verification_remarks, vr.verification_method,
            vr.locked_by, vr.locked_at,
            requester.full_name AS requester_name, requester.email AS requester_email,
            locker.full_name AS locked_by_name
     FROM verification_requests vr
     JOIN users requester ON requester.id = vr.user_id
     LEFT JOIN users locker ON locker.id = vr.locked_by
     WHERE vr.unmatched_org_id=?
     ORDER BY vr.submitted_at DESC`,
    [org.id]
  );

  return ok(res, { organization: org, requests }, "Unmatched organization detail");
}

export async function adminVerifyUnmatchedRequest(req, res) {
  const { uuid } = req.params;
  const { status, verification_remarks } = req.body;

  assertUuid(uuid, "Request UUID");
  if (!["verified", "unverified"].includes(status)) {
    throw new ApiError(400, "status must be verified or unverified");
  }

  const [rows] = await pool.query(
    "SELECT * FROM verification_requests WHERE uuid=?",
    [uuid]
  );
  if (!rows.length) throw new ApiError(404, "Request not found");

  const vr = rows[0];
  if (["verified", "unverified"].includes(vr.status)) {
    throw new ApiError(409, "Request already finalized");
  }
  if (vr.issuing_organization_id !== null) {
    throw new ApiError(400, "This request has a matched organization — use the normal verify flow");
  }

  await pool.query(
    `UPDATE verification_requests
     SET status=?, verified_at=NOW(), verified_by=NULL,
         verification_remarks=?, verification_method='admin'
     WHERE uuid=?`,
    [status, verification_remarks || null, uuid]
  );

  // Update unmatched org status to contacted since admin has reviewed it
  await pool.query(
    `UPDATE unmatched_organizations uo
     INNER JOIN verification_requests vr ON vr.unmatched_org_id = uo.id
     SET uo.status='contacted'
     WHERE vr.uuid=? AND uo.status='pending'`,
    [uuid]
  );

  // Notify the submitter
  const [requester] = await pool.query(
    "SELECT uuid FROM users WHERE id=?",
    [vr.user_id]
  );
  if (requester.length) {
    const statusText = status === "verified" ? "Approved" : "Rejected";
    try {
      await createNotificationForUsers({
        userIds: [requester[0].uuid],
        type: "request_verified",
        title: `Request ${statusText.toLowerCase()}`,
        message: `Your "${vr.document_type}" request was ${statusText} by Dvarif Admin.`,
        link: "/requests",
        referenceId: uuid,
      });
    } catch (e) {
      console.error("Failed to create requester notification:", e.message);
    }
  }

  const [updated] = await pool.query(
    `SELECT vr.*, uo.uuid AS unmatched_org_uuid, uo.name AS unmatched_org_name
     FROM verification_requests vr
     LEFT JOIN unmatched_organizations uo ON uo.id = vr.unmatched_org_id
     WHERE vr.uuid=?`,
    [uuid]
  );

  return ok(res, { request: updated[0] }, "Request updated");
}

export async function acceptNullOrganizationRequest(req, res) {
  const { uuid } = req.params;
  const { verification_remarks, issuing_organization_uuid } = req.body || {};
  assertUuid(uuid, "Unmatched Organization UUID");

  const [uoRows] = await pool.query(
    "SELECT id, name, status FROM unmatched_organizations WHERE uuid=?",
    [uuid]
  );

  if (!uoRows.length) throw new ApiError(404, "Unmatched organization not found");
  const unmatchedOrg = uoRows[0];

  if (!issuing_organization_uuid) {
    throw new ApiError(400, "issuing_organization_uuid is required to assign a verified organization");
  }

  assertUuid(issuing_organization_uuid, "Organization UUID");
  const [orgRows] = await pool.query("SELECT id FROM organizations WHERE uuid=?", [issuing_organization_uuid]);
  if (!orgRows.length) throw new ApiError(404, "Organization not found");
  const assignedOrgId = orgRows[0].id;

  // Update all linked under_review requests to assign the verified org and auto-verify
  await pool.query(
    `UPDATE verification_requests
     SET status='verified', verified_at=NOW(), verified_by=NULL,
         issuing_organization_id=?, verification_remarks=?, verification_method='admin'
     WHERE unmatched_org_id=? AND status='under_review'`,
    [assignedOrgId, verification_remarks || null, unmatchedOrg.id]
  );

  // Mark the unmatched org as converted
  await pool.query(
    "UPDATE unmatched_organizations SET status='converted' WHERE id=?",
    [unmatchedOrg.id]
  );

  return ok(res, { unmatched_org: { uuid, name: unmatchedOrg.name, status: "converted" } }, "Unmatched organization assigned");
}

export async function lockRequest(req, res) {
  const { uuid } = req.params;
  assertUuid(uuid, "Request UUID");

  const [rows] = await pool.query(
    "SELECT id, status, locked_by FROM verification_requests WHERE uuid=?",
    [uuid]
  );
  if (!rows.length) throw new ApiError(404, "Request not found");

  const vr = rows[0];
  if (vr.status === "verified") {
    throw new ApiError(403, "Verified requests cannot be locked.");
  }
  if (vr.locked_by) {
    throw new ApiError(409, "Request is already locked.");
  }

  const lockerId = req.admin ? req.admin.id : req.user?.id;
  const lockerName = req.admin ? req.admin.full_name : req.user?.full_name;

  await pool.query(
    "UPDATE verification_requests SET locked_by=?, locked_at=NOW() WHERE uuid=?",
    [lockerId, uuid]
  );

  const [updated] = await pool.query(
    `${REQUEST_SELECT} WHERE vr.uuid=?`,
    [uuid]
  );

  return ok(res, { request: updated[0] }, `Request locked by ${lockerName || "team member"}`);
}

export async function unlockRequest(req, res) {
  const { uuid } = req.params;
  assertUuid(uuid, "Request UUID");

  const [rows] = await pool.query(
    "SELECT id, locked_by FROM verification_requests WHERE uuid=?",
    [uuid]
  );
  if (!rows.length) throw new ApiError(404, "Request not found");

  if (!rows[0].locked_by) {
    throw new ApiError(409, "Request is not locked.");
  }

  await pool.query(
    "UPDATE verification_requests SET locked_by=NULL, locked_at=NULL WHERE uuid=?",
    [uuid]
  );

  const [updated] = await pool.query(
    `${REQUEST_SELECT} WHERE vr.uuid=?`,
    [uuid]
  );

  return ok(res, { request: updated[0] }, "Request unlocked");
}