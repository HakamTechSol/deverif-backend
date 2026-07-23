import ApiError from "../../utils/ApiError.js";
import { pool } from "../../config/db.js";
import { ok } from "../../utils/response.js";
import { assertUuid } from "../../utils/publicResponse.js";
import { parsePagination, paginatedResponse } from "../../utils/pagination.js";

const REQUEST_SELECT = `SELECT vr.*,
        requester.uuid AS requester_uuid,
        requester.full_name AS requester_name,
        requester.email AS requester_email,
        issuing_org.uuid AS issuing_organization_uuid,
        issuing_org.name AS issuing_org_name
 FROM verification_requests vr
 JOIN users requester ON requester.id = vr.user_id
 LEFT JOIN organizations issuing_org ON issuing_org.id = vr.issuing_organization_id`;

export async function listAllRequests(req, res) {
  const { page, limit, offset } = parsePagination(req.query);
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const statusFilter = typeof req.query.status === "string" ? req.query.status.trim() : "";

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
  if (conditions.length) {
    whereClause = `WHERE ${conditions.join(" AND ")}`;
  }

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

  const [exists] = await pool.query("SELECT id FROM verification_requests WHERE uuid=?", [uuid]);
  if (!exists.length) throw new ApiError(404, "Request not found");

  await pool.query("DELETE FROM verification_requests WHERE uuid=?", [uuid]);
  return ok(res, {}, "Verification request deleted");
}

export async function listNullOrganizationRequests(req, res) {
  const { page, limit, offset } = parsePagination(req.query);

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM verification_requests vr
     WHERE vr.issuing_organization_id IS NULL`
  );
  const [rows] = await pool.query(
    `SELECT vr.*,
            requester.uuid AS requester_uuid,
            requester.full_name AS requester_name,
            requester.email AS requester_email
     FROM verification_requests vr
     JOIN users requester ON requester.id = vr.user_id
     WHERE vr.issuing_organization_id IS NULL
     ORDER BY vr.created_at DESC
     LIMIT ? OFFSET ?`,
    [limit, offset]
  );

  return ok(res, paginatedResponse(rows, total, page, limit), "Requests without organization");
}

export async function acceptNullOrganizationRequest(req, res) {
  const { uuid } = req.params;
  const { verification_remarks } = req.body || {};
  assertUuid(uuid, "Request UUID");

  const [rows] = await pool.query(
    `SELECT id, status, issuing_organization_id
     FROM verification_requests
     WHERE uuid=?`,
    [uuid]
  );

  if (!rows.length) throw new ApiError(404, "Request not found");
  const request = rows[0];

  if (request.issuing_organization_id !== null) {
    throw new ApiError(403, "Only requests without organization can be accepted by admin");
  }
  if (["verified", "unverified"].includes(request.status)) throw new ApiError(409, "Request already finalized");

  await pool.query(
    `UPDATE verification_requests
     SET status='verified', verified_at=NOW(), verified_by=NULL,
         verification_remarks=?, verification_method='admin'
     WHERE uuid=?`,
    [verification_remarks || null, uuid]
  );

  const [updated] = await pool.query(`${REQUEST_SELECT} WHERE vr.uuid=?`, [uuid]);
  return ok(res, { request: updated[0] }, "Request accepted by admin");
}