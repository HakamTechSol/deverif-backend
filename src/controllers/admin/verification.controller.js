import ApiError from "../../utils/ApiError.js";
import { pool } from "../../config/db.js";
import { ok } from "../../utils/response.js";
import { assertUuid } from "../../utils/publicResponse.js";
import { parsePagination, paginatedResponse } from "../../utils/pagination.js";
import { createNotificationForOrgUsers, createNotificationForUsers } from "../notification.controller.js";
import { logAudit, getActorFromReq } from "../../utils/auditLog.js";
import { generateQrForRequest } from "../../utils/qrCertificate.js";
import { runSlaChecks } from "../../utils/slaChecks.js";
import { sendVerificationResultEmailToOrg } from "../../utils/mailer.js";
import { firstFrontendUrl } from "../../utils/frontendUrl.js";
import { recordPersonDocument } from "../../utils/personDocuments.js";

const REQUEST_SELECT = `SELECT vr.*,
        requester.uuid AS requester_uuid,
        requester.full_name AS requester_name,
        requester.email AS requester_email,
        requester_org.uuid AS requester_organization_uuid,
        requester_org.name AS requester_organization,
        issuing_org.uuid AS issuing_organization_uuid,
        issuing_org.name AS issuing_org_name,
        uo.uuid AS unmatched_org_uuid, uo.name AS unmatched_org_name,
        admin_locker.uuid AS locked_by_uuid,
        admin_locker.full_name AS locked_by_name
 FROM verification_requests vr
 JOIN users requester ON requester.id = vr.user_id
 LEFT JOIN organizations requester_org ON requester_org.id = requester.organization
 LEFT JOIN organizations issuing_org ON issuing_org.id = vr.issuing_organization_id
 LEFT JOIN unmatched_organizations uo ON uo.id = vr.unmatched_org_id
 LEFT JOIN admin_profiles admin_locker ON admin_locker.id = vr.locked_by`;

export async function listAllRequests(req, res) {
  const { page, limit, offset } = parsePagination(req.query);
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const statusFilter = typeof req.query.status === "string" ? req.query.status.trim() : "";
  const dateFrom = typeof req.query.dateFrom === "string" ? req.query.dateFrom.trim() : "";
  const dateTo = typeof req.query.dateTo === "string" ? req.query.dateTo.trim() : "";

  // Lazy SLA check on read (reminder + flag overdue requests)
  runSlaChecks().catch(() => {});

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

export async function listSlaFlaggedRequests(req, res) {
  // Ensure the lazy check has run so the flagged list is current
  await runSlaChecks();

  const { page, limit, offset } = parsePagination(req.query);
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";

  let whereClause =
    "WHERE vr.status='under_review' AND vr.sla_flagged_at IS NOT NULL AND vr.issuing_organization_id IS NOT NULL";
  const params = [];

  if (search) {
    whereClause += ` AND (requester.full_name LIKE ? OR requester.email LIKE ? OR vr.document_type LIKE ? OR issuing_org.name LIKE ? OR vr.uuid LIKE ?)`;
    const like = `%${search}%`;
    params.push(like, like, like, like, like);
  }

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM verification_requests vr
     JOIN users requester ON requester.id = vr.user_id
     LEFT JOIN organizations issuing_org ON issuing_org.id = vr.issuing_organization_id
     ${whereClause}`,
    params
  );
  const [rows] = await pool.query(
    `${REQUEST_SELECT} ${whereClause} ORDER BY vr.sla_flagged_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  return ok(res, paginatedResponse(rows, total, page, limit), "Unresponsive requests");
}

export async function adminActOnSlaRequest(req, res) {
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
  if (vr.issuing_organization_id === null) {
    throw new ApiError(400, "This request has no registered organization — use the Unmatched Orgs flow");
  }

  await pool.query(
    `UPDATE verification_requests
     SET status=?, verified_at=NOW(), verified_by=?,
         verification_remarks=?, verification_method='admin_sla'
     WHERE uuid=?`,
    [status, req.admin.id, verification_remarks || null, uuid]
  );

  const [updated] = await pool.query(
    `${REQUEST_SELECT} WHERE vr.uuid=?`,
    [uuid]
  );

  if (status === "verified") {
    await generateQrForRequest(updated[0]);
  }

  // Append to the person's document history
  if (status === "verified") {
    await recordPersonDocument(updated[0], vr.issuing_organization_id);
  }

  // Notify the original submitter
  const [requester] = await pool.query(
    "SELECT uuid FROM users WHERE id=?",
    [vr.user_id]
  );
  const statusText = status === "verified" ? "Approved" : "Rejected";
  if (requester.length) {
    try {
      await createNotificationForUsers({
        userIds: [requester[0].uuid],
        type: "request_verified",
        title: `Request ${statusText.toLowerCase()}`,
        message: `Your "${vr.document_type}" request was ${statusText} by Dverif Admin (unresponsive organization).`,
        link: "/requests",
        referenceId: uuid,
      });
    } catch (e) {
      console.error("Failed to create requester notification:", e.message);
    }
  }

  logAudit({
    ...getActorFromReq(req),
    action: status === "verified" ? "request.verify" : "request.reject",
    entityType: "verification_request",
    entityId: uuid,
    details: { status, method: "admin_sla" },
    req,
  });

  return ok(res, { request: updated[0] }, "Request updated");
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

  logAudit({
    ...getActorFromReq(req),
    action: "request.delete",
    entityType: "verification_request",
    entityId: uuid,
    details: { status: exists[0].status },
    req,
  });

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
    `SELECT uo.*,
            o.uuid AS assigned_org_uuid,
            o.name AS assigned_org_name
     FROM unmatched_organizations uo
     LEFT JOIN organizations o ON o.id = uo.assigned_organization_id
     WHERE uo.uuid=?`,
    [uuid]
  );
  if (!org) throw new ApiError(404, "Unmatched organization not found");

const [requests] = await pool.query(
    `SELECT vr.uuid, vr.document_type, vr.document_format, vr.document_path, vr.status, vr.submitted_at,
            vr.verified_at, vr.submission_remarks, vr.verification_remarks, vr.verification_method,
            vr.locked_by, vr.locked_at,
            requester.full_name AS requester_name, requester.email AS requester_email,
            requester_org.uuid AS requester_org_uuid,
            admin_locker.full_name AS locked_by_name
     FROM verification_requests vr
     JOIN users requester ON requester.id = vr.user_id
     LEFT JOIN organizations requester_org ON requester_org.id = requester.organization
     LEFT JOIN admin_profiles admin_locker ON admin_locker.id = vr.locked_by
     WHERE vr.unmatched_org_id=?
     ORDER BY vr.submitted_at DESC`,
    [org.id]
  );

  const assigned = org.assigned_org_uuid
    ? { uuid: org.assigned_org_uuid, name: org.assigned_org_name }
    : null;

  return ok(res, { organization: { ...org, assigned_organization: assigned }, requests }, "Unmatched organization detail");
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
    "SELECT uuid, email, preferred_language, organization FROM users WHERE id=?",
    [vr.user_id]
  );
  if (requester.length) {
    const statusText = status === "verified" ? "Approved" : "Rejected";
    try {
      await createNotificationForUsers({
        userIds: [requester[0].uuid],
        type: "request_verified",
        title: `Request ${statusText.toLowerCase()}`,
        message: `Your "${vr.document_type}" request was ${statusText} by Dverif Admin.`,
        link: "/requests",
        referenceId: uuid,
      });
    } catch (e) {
      console.error("Failed to create requester notification:", e.message);
    }
  }

  // Email the org the document was verified for once it is approved — the
  // org's business email + its org admins (deduplicated, same address only once).
  if (status === "verified" && requester.length && requester[0].organization) {
    try {
      await sendVerificationResultEmailToOrg({
        orgId: requester[0].organization,
        documentType: vr.document_type,
        portalLink: `${firstFrontendUrl(process.env.FRONTEND_URL, "http://localhost:8080")}/requests`,
      });
    } catch (e) {
      console.error("Failed to send verification result email to org:", e.message);
    }
  }

  const [updated] = await pool.query(
    `SELECT vr.*, uo.uuid AS unmatched_org_uuid, uo.name AS unmatched_org_name
     FROM verification_requests vr
     LEFT JOIN unmatched_organizations uo ON uo.id = vr.unmatched_org_id
     WHERE vr.uuid=?`,
    [uuid]
  );

  if (status === "verified") {
    await generateQrForRequest(updated[0]);
  }

  // Append to the person's document history
  if (status === "verified") {
    await recordPersonDocument(updated[0], vr.issuing_organization_id);
  }

  logAudit({
    ...getActorFromReq(req),
    action: status === "verified" ? "request.verify" : "request.reject",
    entityType: "verification_request",
    entityId: uuid,
    details: { status, method: "admin" },
    req,
  });

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

  // Route all pending requests to the assigned org (stay under_review for them to verify)
  await pool.query(
    `UPDATE verification_requests
     SET issuing_organization_id=?, verification_remarks=?, verification_method='admin'
     WHERE unmatched_org_id=? AND status='under_review'`,
    [assignedOrgId, verification_remarks || null, unmatchedOrg.id]
  );

  // Notify the assigned org's users with approve_request permission about each routed request
  const [routedRequests] = await pool.query(
    `SELECT id, uuid, user_id, document_type
     FROM verification_requests
     WHERE unmatched_org_id=? AND issuing_organization_id=? AND status='under_review'`,
    [unmatchedOrg.id, assignedOrgId]
  );

  const routedCount = routedRequests.length;
  for (const requestRow of routedRequests) {
    try {
      await createNotificationForOrgUsers({
        orgId: assignedOrgId,
        type: "verification_request",
        title: "New verification request",
        message: `A document request was assigned to your organization for review: ${requestRow.document_type}.`,
        link: "/inbox",
        referenceId: requestRow.uuid,
        requirePermission: "approve_request",
      });
    } catch (e) {
      console.error("Failed to create notification for assigned org:", e.message);
    }
  }

  // Mark the unmatched org as converted and remember which org it was assigned to
  await pool.query(
    "UPDATE unmatched_organizations SET status='converted', assigned_organization_id=? WHERE id=?",
    [assignedOrgId, unmatchedOrg.id]
  );

  // Detach the routed requests from the unmatched org so they leave the
  // unmatched queue and live only under the assigned (verified) org.
  if (routedCount > 0) {
    await pool.query(
      "UPDATE verification_requests SET unmatched_org_id=NULL WHERE id IN (?)",
      [routedRequests.map((r) => r.id)]
    );
  }

  logAudit({
    ...getActorFromReq(req),
    action: "unmatched_org.assign",
    entityType: "unmatched_organization",
    entityId: uuid,
    details: { organization_uuid: issuing_organization_uuid, routed_requests: routedCount },
    req,
  });

  return ok(res, { unmatched_org: { uuid, name: unmatchedOrg.name, status: "converted" }, routed_requests: routedCount }, "Unmatched organization assigned");
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

  const lockerName = req.admin.full_name;

  await pool.query(
    "UPDATE verification_requests SET locked_by=?, locked_at=NOW() WHERE uuid=?",
    [req.admin.id, uuid]
  );

  const [updated] = await pool.query(
    `${REQUEST_SELECT} WHERE vr.uuid=?`,
    [uuid]
  );

  logAudit({
    ...getActorFromReq(req),
    action: "request.lock",
    entityType: "verification_request",
    entityId: uuid,
    req,
  });

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

  logAudit({
    ...getActorFromReq(req),
    action: "request.unlock",
    entityType: "verification_request",
    entityId: uuid,
    req,
  });

  return ok(res, { request: updated[0] }, "Request unlocked");
}