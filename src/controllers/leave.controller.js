import ApiError from "../utils/ApiError.js";
import { pool } from "../config/db.js";
import { ok, created } from "../utils/response.js";
import { assertUuid } from "../utils/publicResponse.js";
import { parsePagination, paginatedResponse } from "../utils/pagination.js";
import { createNotificationForUsers } from "./notification.controller.js";
import { logAudit, getActorFromReq } from "../utils/auditLog.js";
import { countLeaveDays, isoDate, yearOfDate } from "../utils/leaveBalance.js";

/**
 * Fetch (or default) the employee's allocation row for a leave type/year.
 * Returns null when no allocation is recorded for that type/year.
 */
async function getAllocation(conn, employeeUuid, leaveTypeId, year) {
  const [rows] = await conn.query(
    "SELECT * FROM employee_leave_allocations WHERE employee_uuid=? AND leave_type_id=? AND year=?",
    [employeeUuid, leaveTypeId, year]
  );
  return rows[0] || null;
}

/** Resolve the organization id for leave-type management (org-admin vs platform admin). */
async function resolveScopeOrgId(req) {
  if (req.scopeOrgId) return req.scopeOrgId;
  const orgUuid = req.body.organization_uuid || req.query.organization_uuid;
  if (!orgUuid) throw new ApiError(400, "organization_uuid is required");
  assertUuid(orgUuid, "Organization UUID");
  const [rows] = await pool.query("SELECT id FROM organizations WHERE uuid=?", [orgUuid]);
  if (!rows.length) throw new ApiError(404, "Organization not found");
  return rows[0].id;
}

// ---------------------------------------------------------------------------
// Leave types (org-admin scopes to own org; platform admin passes organization_uuid)
// ---------------------------------------------------------------------------

export async function listLeaveTypes(req, res) {
  const orgId = await resolveScopeOrgId(req);
  const [rows] = await pool.query(
    `SELECT lt.id, lt.name, lt.days_allowed_per_year, lt.created_at,
            o.uuid AS organization_uuid, o.name AS organization_name
     FROM leave_types lt
     JOIN organizations o ON o.id = lt.organization_id
     WHERE lt.organization_id = ?
     ORDER BY lt.name`,
    [orgId]
  );
  return ok(res, { leaveTypes: rows }, "Leave types");
}

export async function createLeaveType(req, res) {
  const orgId = await resolveScopeOrgId(req);
  const { name, days_allowed_per_year } = req.body;
  if (!name || !String(name).trim()) throw new ApiError(400, "name is required");
  // Leave types are now name-only definitions (allocations are assigned
  // individually per employee). The legacy days column is kept but no longer
  // drives employee balances — it defaults to 0.
  const days = days_allowed_per_year === undefined ? 0 : parseInt(days_allowed_per_year, 10);
  if (isNaN(days) || days < 0) throw new ApiError(400, "days_allowed_per_year must be a non-negative integer");

  let result;
  try {
    [result] = await pool.query(
      "INSERT INTO leave_types (organization_id, name, days_allowed_per_year) VALUES (?, ?, ?)",
      [orgId, String(name).trim(), days]
    );
  } catch (e) {
    if (String(e.message).includes("Duplicate")) {
      throw new ApiError(409, "A leave type with this name already exists for the organization");
    }
    throw e;
  }

  const [rows] = await pool.query(
    "SELECT id, name, days_allowed_per_year FROM leave_types WHERE id=?",
    [result.insertId]
  );
  logAudit({
    ...getActorFromReq(req),
    action: "leave_type.create",
    entityType: "leave_type",
    entityId: String(result.insertId),
    details: { organization_id: orgId, name, days },
    req,
  });
  return created(res, { leaveType: rows[0] }, "Leave type created");
}

export async function updateLeaveType(req, res) {
  const orgId = await resolveScopeOrgId(req);
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) throw new ApiError(400, "Invalid leave type id");

  const [exists] = await pool.query(
    "SELECT id FROM leave_types WHERE id=? AND organization_id=?",
    [id, orgId]
  );
  if (!exists.length) throw new ApiError(404, "Leave type not found");

  const { name, days_allowed_per_year } = req.body;
  const updates = {};
  if (name !== undefined) {
    if (!String(name).trim()) throw new ApiError(400, "name cannot be empty");
    updates.name = String(name).trim();
  }
  if (days_allowed_per_year !== undefined) {
    const days = parseInt(days_allowed_per_year, 10);
    if (isNaN(days) || days < 0) throw new ApiError(400, "days_allowed_per_year must be a non-negative integer");
    updates.days_allowed_per_year = days;
  }
  if (!Object.keys(updates).length) throw new ApiError(400, "Nothing to update");

  try {
    await pool.query("UPDATE leave_types SET ? WHERE id=?", [updates, id]);
  } catch (e) {
    if (String(e.message).includes("Duplicate")) {
      throw new ApiError(409, "A leave type with this name already exists for the organization");
    }
    throw e;
  }

  const [rows] = await pool.query(
    "SELECT id, name, days_allowed_per_year FROM leave_types WHERE id=?",
    [id]
  );
  logAudit({
    ...getActorFromReq(req),
    action: "leave_type.update",
    entityType: "leave_type",
    entityId: String(id),
    details: { organization_id: orgId, ...updates },
    req,
  });
  return ok(res, { leaveType: rows[0] }, "Leave type updated");
}

export async function deleteLeaveType(req, res) {
  const orgId = await resolveScopeOrgId(req);
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) throw new ApiError(400, "Invalid leave type id");

  const [exists] = await pool.query(
    "SELECT id FROM leave_types WHERE id=? AND organization_id=?",
    [id, orgId]
  );
  if (!exists.length) throw new ApiError(404, "Leave type not found");

  try {
    await pool.query("DELETE FROM leave_types WHERE id=?", [id]);
  } catch (e) {
    if (String(e.message).includes("fk_leave_requests_type")) {
      throw new ApiError(409, "Cannot delete — leave requests already exist for this type");
    }
    throw e;
  }
  logAudit({
    ...getActorFromReq(req),
    action: "leave_type.delete",
    entityType: "leave_type",
    entityId: String(id),
    details: { organization_id: orgId },
    req,
  });
  return ok(res, {}, "Leave type deleted");
}

// ---------------------------------------------------------------------------
// Platform user endpoints
// ---------------------------------------------------------------------------

export async function orgLeaveTypes(req, res) {
  if (!req.user.organization) throw new ApiError(400, "User has no organization");

  // Only surface leave types this employee has actually been allocated days for
  // in the current year. Leave types with no per-employee allocation (or an
  // allocation of 0 days) must not appear as selectable options.
  const [empRows] = await pool.query(
    "SELECT uuid FROM employees WHERE linked_user_uuid=? AND organization_id=?",
    [req.user.uuid, req.user.organization]
  );
  if (!empRows.length) return ok(res, { leaveTypes: [] }, "Leave types");

  const year = new Date().getFullYear();
  const [rows] = await pool.query(
    `SELECT lt.id, lt.name, lt.days_allowed_per_year
     FROM leave_types lt
     JOIN employee_leave_allocations ela ON ela.leave_type_id = lt.id
     WHERE lt.organization_id=? AND ela.employee_uuid=? AND ela.year=? AND ela.allocated_days > 0
     GROUP BY lt.id, lt.name, lt.days_allowed_per_year
     ORDER BY lt.name`,
    [req.user.organization, empRows[0].uuid, year]
  );
  return ok(res, { leaveTypes: rows }, "Leave types");
}

export async function myLeaveBalances(req, res) {
  if (!req.user.organization) throw new ApiError(400, "User has no organization");
  const [empRows] = await pool.query(
    "SELECT uuid FROM employees WHERE linked_user_uuid=?",
    [req.user.uuid]
  );
  if (!empRows.length) return ok(res, { balances: [] }, "Leave balances");

  const year = new Date().getFullYear();
  const [rows] = await pool.query(
    `SELECT ela.id, ela.year, ela.allocated_days AS total_allocated, ela.used_days AS used,
            ela.remaining_days AS remaining,
            lt.id AS leave_type_id, lt.name AS leave_type_name
     FROM employee_leave_allocations ela
     JOIN leave_types lt ON lt.id = ela.leave_type_id
     WHERE ela.employee_uuid=? AND ela.year=?
     ORDER BY lt.name`,
    [empRows[0].uuid, year]
  );
  return ok(res, { balances: rows }, "Leave balances");
}

export async function myLeaves(req, res) {
  const { page, limit, offset } = parsePagination(req.query);
  const [empRows] = await pool.query(
    "SELECT uuid FROM employees WHERE linked_user_uuid=?",
    [req.user.uuid]
  );
  if (!empRows.length) return ok(res, paginatedResponse([], 0, page, limit), "My leaves");

  const [[{ total }]] = await pool.query(
    "SELECT COUNT(*) AS total FROM leave_requests WHERE employee_uuid=?",
    [empRows[0].uuid]
  );
  const [rows] = await pool.query(
    `SELECT lr.uuid,
            DATE_FORMAT(lr.start_date, '%Y-%m-%d') AS start_date,
            DATE_FORMAT(lr.end_date, '%Y-%m-%d') AS end_date,
            lr.reason, lr.status, lr.approved_by, lr.approved_at,
            lr.created_at, lr.employee_uuid, lr.leave_type_id,
            lr.organization_id,
            lt.name AS leave_type_name
     FROM leave_requests lr
     JOIN leave_types lt ON lt.id = lr.leave_type_id
     WHERE lr.employee_uuid=?
     ORDER BY lr.created_at DESC
     LIMIT ? OFFSET ?`,
    [empRows[0].uuid, limit, offset]
  );
  return ok(res, paginatedResponse(rows, total, page, limit), "My leaves");
}

export async function createLeave(req, res) {
  if (!req.user.organization) throw new ApiError(400, "User has no organization");
  if (req.user.org_role === "org_admin" || req.user.org_role === "sub_admin") {
    throw new ApiError(
      403,
      "Org admins and sub-admins review leave requests but cannot submit them for themselves"
    );
  }
  const { leave_type_id, start_date, end_date, reason } = req.body;
  if (!leave_type_id) throw new ApiError(400, "leave_type_id is required");
  if (!start_date || !end_date) throw new ApiError(400, "start_date and end_date are required");
  if (String(start_date) > String(end_date)) throw new ApiError(400, "start_date must be before or equal to end_date");

  const [empRows] = await pool.query(
    "SELECT uuid, organization_id, is_platform_user FROM employees WHERE linked_user_uuid=?",
    [req.user.uuid]
  );
  if (!empRows.length) throw new ApiError(403, "No employee record is linked to your account");
  const emp = empRows[0];
  if (emp.is_platform_user !== "yes") throw new ApiError(403, "Your account is not a platform user");
  if (emp.organization_id !== req.user.organization) throw new ApiError(403, "Organization mismatch");

  const typeId = Number(leave_type_id);
  const [ltRows] = await pool.query(
    "SELECT id, name FROM leave_types WHERE id=? AND organization_id=?",
    [typeId, req.user.organization]
  );
  if (!ltRows.length) throw new ApiError(404, "Leave type not found");

  const days = countLeaveDays(start_date, end_date);
  const year = yearOfDate(start_date);

  // Requirement 3: block submission when the employee has no remaining balance
  // allocated for this leave type in the leave's year.
  const alloc = await getAllocation(pool, emp.uuid, typeId, year);
  if (!alloc || alloc.remaining_days <= 0) {
    const available = alloc ? alloc.remaining_days : 0;
    throw new ApiError(
      409,
      `No ${ltRows[0].name} leave balance remaining for ${year} (${available} day(s) available)`
    );
  }
  const [result] = await pool.query(
    `INSERT INTO leave_requests
       (uuid, employee_uuid, leave_type_id, start_date, end_date, reason, status)
     VALUES (UUID(), ?, ?, ?, ?, ?, 'pending')`,
    [emp.uuid, typeId, start_date, end_date, reason || null]
  );

  const [rows] = await pool.query("SELECT * FROM leave_requests WHERE id=?", [result.insertId]);

  // Notify the org's admins so the request gets reviewed.
  try {
    const [admins] = await pool.query(
      "SELECT uuid FROM users WHERE organization=? AND org_role='org_admin' AND status='active'",
      [req.user.organization]
    );
    if (admins.length) {
      await createNotificationForUsers({
        userIds: admins.map((a) => a.uuid),
        type: "leave_request",
        title: "New leave request",
        message: `${req.user.full_name} requested ${days} day(s) of ${ltRows[0].name} leave.`,
        link: "/org/leaves",
        referenceId: rows[0].uuid,
      });
    }
  } catch (e) {
    console.error("Leave request notification failed:", e.message);
  }

  logAudit({
    ...getActorFromReq(req),
    action: "leave.create",
    entityType: "leave_request",
    entityId: rows[0].uuid,
    details: { leave_type: ltRows[0].name, days, start_date, end_date },
    req,
  });

  return created(res, { leaveRequest: rows[0] }, "Leave request submitted");
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

export async function listOrgLeaves(req, res) {
  const orgId = req.scopeOrgId;
  const { page, limit, offset } = parsePagination(req.query);
  const status = typeof req.query.status === "string" && req.query.status.trim()
    ? req.query.status.trim() : "";
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";

  let whereClause = "WHERE e.organization_id = ?";
  const params = [orgId];
  if (["pending", "approved", "rejected"].includes(status)) {
    whereClause += " AND lr.status = ?";
    params.push(status);
  }
  if (search) {
    whereClause += " AND (e.full_name LIKE ? OR e.email LIKE ? OR lt.name LIKE ?)";
    const like = `%${search}%`;
    params.push(like, like, like);
  }

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total
     FROM leave_requests lr
     JOIN employees e ON e.uuid = lr.employee_uuid
     JOIN leave_types lt ON lt.id = lr.leave_type_id
     ${whereClause}`,
    params
  );
  const [rows] = await pool.query(
    `SELECT lr.uuid,
            DATE_FORMAT(lr.start_date, '%Y-%m-%d') AS start_date,
            DATE_FORMAT(lr.end_date, '%Y-%m-%d') AS end_date,
            lr.reason, lr.status,
            lr.approved_by, lr.approved_at, lr.created_at,
            e.uuid AS employee_uuid, e.full_name AS employee_name,
            e.email AS employee_email, dg.name AS designation,
            lt.id AS leave_type_id, lt.name AS leave_type_name
     FROM leave_requests lr
     JOIN employees e ON e.uuid = lr.employee_uuid
     LEFT JOIN designations dg ON dg.id = e.designation_id
     JOIN leave_types lt ON lt.id = lr.leave_type_id
     ${whereClause}
     ORDER BY lr.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return ok(res, paginatedResponse(rows, total, page, limit), "Org leave requests");
}

export async function listAllLeaves(req, res) {
  const { page, limit, offset } = parsePagination(req.query);
  const status = typeof req.query.status === "string" && req.query.status.trim()
    ? req.query.status.trim() : "";
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const orgUuid = typeof req.query.organization_uuid === "string" && req.query.organization_uuid.trim()
    ? req.query.organization_uuid.trim() : "";

  let whereClause = "WHERE 1=1";
  const params = [];
  if (["pending", "approved", "rejected"].includes(status)) {
    whereClause += " AND lr.status = ?";
    params.push(status);
  }
  if (orgUuid) {
    assertUuid(orgUuid, "Organization UUID");
    whereClause += " AND o.uuid = ?";
    params.push(orgUuid);
  }
  if (search) {
    whereClause += " AND (e.full_name LIKE ? OR e.email LIKE ? OR lt.name LIKE ?)";
    const like = `%${search}%`;
    params.push(like, like, like);
  }

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total
     FROM leave_requests lr
     JOIN employees e ON e.uuid = lr.employee_uuid
     JOIN leave_types lt ON lt.id = lr.leave_type_id
     JOIN organizations o ON o.id = e.organization_id
     ${whereClause}`,
    params
  );
  const [rows] = await pool.query(
    `SELECT lr.uuid,
            DATE_FORMAT(lr.start_date, '%Y-%m-%d') AS start_date,
            DATE_FORMAT(lr.end_date, '%Y-%m-%d') AS end_date,
            lr.reason, lr.status,
            lr.approved_by, lr.approved_at, lr.created_at,
            e.uuid AS employee_uuid, e.full_name AS employee_name,
            e.email AS employee_email, dg.name AS designation,
            o.uuid AS organization_uuid, o.name AS organization_name,
            lt.id AS leave_type_id, lt.name AS leave_type_name
     FROM leave_requests lr
     JOIN employees e ON e.uuid = lr.employee_uuid
     LEFT JOIN designations dg ON dg.id = e.designation_id
     JOIN leave_types lt ON lt.id = lr.leave_type_id
     JOIN organizations o ON o.id = e.organization_id
     ${whereClause}
     ORDER BY lr.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return ok(res, paginatedResponse(rows, total, page, limit), "Leave requests");
}

export async function decideLeave(req, res) {
  const { uuid } = req.params;
  const { status } = req.body;
  assertUuid(uuid, "Leave request UUID");
  if (!["approved", "rejected"].includes(status)) {
    throw new ApiError(400, "status must be approved or rejected");
  }

  const actorUuid = req.admin?.uuid || req.user?.uuid || null;

  const [rows] = await pool.query(
    `SELECT lr.*, lt.name AS leave_type_name, lt.days_allowed_per_year,
            e.organization_id, e.linked_user_uuid, e.full_name AS employee_name
     FROM leave_requests lr
     JOIN leave_types lt ON lt.id = lr.leave_type_id
     JOIN employees e ON e.uuid = lr.employee_uuid
     WHERE lr.uuid=?`,
    [uuid]
  );
  if (!rows.length) throw new ApiError(404, "Leave request not found");
  const lr = rows[0];
  if (lr.status !== "pending") throw new ApiError(409, "Leave request has already been decided");

  // Permission scoping (route restricts this to org_admin / sub_admin)
  if (!req.admin) {
    if (req.user?.org_role !== "org_admin" && req.user?.org_role !== "sub_admin") {
      throw new ApiError(403, "Only org admins, sub-admins or platform admins can decide leave requests");
    }
    if (lr.organization_id !== req.user.organization) {
      throw new ApiError(403, "This leave request is not part of your organization");
    }
  }

  if (status === "approved") {
    const days = countLeaveDays(lr.start_date, lr.end_date);
    const year = yearOfDate(lr.start_date);

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const alloc = await getAllocation(conn, lr.employee_uuid, lr.leave_type_id, year);
      if (!alloc) {
        throw new ApiError(409, "No leave balance is allocated for this leave type this year");
      }
      const [[bal]] = await conn.query(
        "SELECT * FROM employee_leave_allocations WHERE id=? FOR UPDATE",
        [alloc.id]
      );
      if (bal.remaining_days < days) {
        throw new ApiError(
          409,
          `Insufficient ${lr.leave_type_name} balance — ${days} day(s) requested, ${bal.remaining_days} available`
        );
      }
      await conn.query(
        "UPDATE employee_leave_allocations SET used_days=used_days+?, remaining_days=remaining_days-? WHERE id=?",
        [days, days, alloc.id]
      );
      const [decision] = await conn.query(
        "UPDATE leave_requests SET status='approved', approved_by=?, approved_at=NOW() WHERE uuid=? AND status='pending'",
        [actorUuid, uuid]
      );
      // Guard against two concurrent approvals of the same request: if the
      // row was already decided between our read and this update, undo the
      // balance deduction we just made.
      if (!decision.affectedRows) {
        throw new ApiError(409, "Leave request has already been decided");
      }
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  } else {
    const [decision] = await pool.query(
      "UPDATE leave_requests SET status='rejected', approved_by=?, approved_at=NOW() WHERE uuid=? AND status='pending'",
      [actorUuid, uuid]
    );
    if (!decision.affectedRows) {
      throw new ApiError(409, "Leave request has already been decided");
    }
  }

  // Notify the requesting employee.
  const statusText = status === "approved" ? "Approved" : "Rejected";
  if (lr.linked_user_uuid) {
    try {
      await createNotificationForUsers({
        userIds: [lr.linked_user_uuid],
        type: status === "approved" ? "leave_approved" : "leave_rejected",
        title: `Leave ${statusText.toLowerCase()}`,
        message: `Your ${lr.leave_type_name} leave request (${isoDate(lr.start_date)} → ${isoDate(lr.end_date)}) was ${statusText.toLowerCase()}.`,
        link: "/leaves",
        referenceId: uuid,
      });
    } catch (e) {
      console.error("Leave decision notification failed:", e.message);
    }
  }

  logAudit({
    ...getActorFromReq(req),
    action: status === "approved" ? "leave.approve" : "leave.reject",
    entityType: "leave_request",
    entityId: uuid,
    details: { status },
    req,
  });

  const [final] = await pool.query("SELECT * FROM leave_requests WHERE uuid=?", [uuid]);
  return ok(res, { leaveRequest: final[0] }, "Leave request updated");
}