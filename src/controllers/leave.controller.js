import ApiError from "../utils/ApiError.js";
import { pool } from "../config/db.js";
import { employeeScopeCondition, assertEmployeeInDataScope } from "../utils/dataScopes.js";
import { ok, created } from "../utils/response.js";
import { assertUuid } from "../utils/publicResponse.js";
import { parsePagination, paginatedResponse } from "../utils/pagination.js";
import { createNotificationForUsers } from "./notification.controller.js";
import { logAudit, getActorFromReq } from "../utils/auditLog.js";
import { isoDate, yearOfDate } from "../utils/leaveBalance.js";
import { getLeaveLedgerBalance, recordLeaveBalanceTransaction } from "../utils/leaveLedger.js";
import * as payrollService from "../services/payroll.service.js";

const DEFAULT_UNPAID_LEAVE_TYPE = "Unpaid Leave (Default)";
const DEFAULT_UNPAID_LEAVE_LABEL = "Unpaid Leave";

function isDefaultUnpaidLeaveType(name) {
  return String(name).trim().toLowerCase() === DEFAULT_UNPAID_LEAVE_TYPE.toLowerCase();
}

function validIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

async function getWorkingDatesBetween(orgId, startDate, endDate, conn = pool) {
  return payrollService.getWorkingDatesBetween({ orgId, startDate, endDate, conn });
}

async function getDefaultUnpaidLeaveType(orgId) {
  const findType = async () => {
    const [rows] = await pool.query(
      "SELECT id, name, is_paid FROM leave_types WHERE organization_id=? AND name=?",
      [orgId, DEFAULT_UNPAID_LEAVE_TYPE]
    );
    return rows[0] || null;
  };

  let type = await findType();
  if (!type) {
    try {
      await pool.query(
        "INSERT INTO leave_types (organization_id, name, days_allowed_per_year, is_paid) VALUES (?, ?, 0, 'no')",
        [orgId, DEFAULT_UNPAID_LEAVE_TYPE]
      );
    } catch (error) {
      if (error.code !== "ER_DUP_ENTRY") throw error;
    }
    type = await findType();
  }
  if (!type || type.is_paid !== "no") {
    throw new ApiError(409, `The reserved "${DEFAULT_UNPAID_LEAVE_TYPE}" leave type must be unpaid.`);
  }
  return type;
}

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
    `SELECT lt.id, lt.name, lt.days_allowed_per_year, lt.is_paid, lt.created_at,
            o.uuid AS organization_uuid, o.name AS organization_name
     FROM leave_types lt
     JOIN organizations o ON o.id = lt.organization_id
     WHERE lt.organization_id = ? AND lt.name <> ?
     ORDER BY lt.name`,
    [orgId, DEFAULT_UNPAID_LEAVE_TYPE]
  );
  return ok(res, { leaveTypes: rows }, "Leave types");
}

export async function createLeaveType(req, res) {
  const orgId = await resolveScopeOrgId(req);
  const { name, days_allowed_per_year } = req.body;
  const isPaid = req.body?.is_paid ?? "yes";
  if (!name || !String(name).trim()) throw new ApiError(400, "name is required");
  if (!["yes", "no"].includes(isPaid)) throw new ApiError(400, "is_paid must be yes or no.");
  if (isDefaultUnpaidLeaveType(name)) {
    throw new ApiError(400, `"${DEFAULT_UNPAID_LEAVE_TYPE}" is reserved for employee unpaid leave requests.`);
  }
  // Leave types are now name-only definitions (allocations are assigned
  // individually per employee). The legacy days column is kept but no longer
  // drives employee balances — it defaults to 0.
  const days = days_allowed_per_year === undefined ? 0 : parseInt(days_allowed_per_year, 10);
  if (isNaN(days) || days < 0) throw new ApiError(400, "days_allowed_per_year must be a non-negative integer");

  let result;
  try {
    [result] = await pool.query(
      "INSERT INTO leave_types (organization_id, name, days_allowed_per_year, is_paid) VALUES (?, ?, ?, ?)",
      [orgId, String(name).trim(), days, isPaid]
    );
  } catch (e) {
    if (String(e.message).includes("Duplicate")) {
      throw new ApiError(409, "A leave type with this name already exists for the organization");
    }
    throw e;
  }

  const [rows] = await pool.query(
    "SELECT id, name, days_allowed_per_year, is_paid FROM leave_types WHERE id=?",
    [result.insertId]
  );
  logAudit({
    ...getActorFromReq(req),
    action: "leave_type.create",
    entityType: "leave_type",
    entityId: String(result.insertId),
    details: { organization_id: orgId, name, days, is_paid: isPaid },
    req,
  });
  return created(res, { leaveType: rows[0] }, "Leave type created");
}

export async function updateLeaveType(req, res) {
  const orgId = await resolveScopeOrgId(req);
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) throw new ApiError(400, "Invalid leave type id");

  const [exists] = await pool.query(
    "SELECT id, name, is_paid FROM leave_types WHERE id=? AND organization_id=?",
    [id, orgId]
  );
  if (!exists.length) throw new ApiError(404, "Leave type not found");
  if (isDefaultUnpaidLeaveType(exists[0].name)) {
    throw new ApiError(400, `"${DEFAULT_UNPAID_LEAVE_TYPE}" is reserved for employee unpaid leave requests.`);
  }

  const { name, days_allowed_per_year } = req.body;
  const updates = {};
  if (name !== undefined) {
    if (!String(name).trim()) throw new ApiError(400, "name cannot be empty");
    if (isDefaultUnpaidLeaveType(name)) {
      throw new ApiError(400, `"${DEFAULT_UNPAID_LEAVE_TYPE}" is reserved for employee unpaid leave requests.`);
    }
    updates.name = String(name).trim();
  }
  if (days_allowed_per_year !== undefined) {
    const days = parseInt(days_allowed_per_year, 10);
    if (isNaN(days) || days < 0) throw new ApiError(400, "days_allowed_per_year must be a non-negative integer");
    updates.days_allowed_per_year = days;
  }
  if (req.body?.is_paid !== undefined) {
    if (!["yes", "no"].includes(req.body.is_paid)) throw new ApiError(400, "is_paid must be yes or no.");
    updates.is_paid = req.body.is_paid;
  }
  if (!Object.keys(updates).length) throw new ApiError(400, "Nothing to update");

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query("SELECT id FROM leave_types WHERE id=? AND organization_id=? FOR UPDATE", [id, orgId]);
    await conn.query("UPDATE leave_types SET ? WHERE id=?", [updates, id]);
    if (updates.is_paid !== undefined) {
      await conn.query(
        "UPDATE leave_requests SET requested_treatment=? WHERE leave_type_id=? AND status='pending'",
        [updates.is_paid === "no" ? "unpaid" : "paid", id],
      );
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    if (String(e.message).includes("Duplicate")) {
      throw new ApiError(409, "A leave type with this name already exists for the organization");
    }
    throw e;
  } finally {
    conn.release();
  }

  const [rows] = await pool.query(
    "SELECT id, name, days_allowed_per_year, is_paid FROM leave_types WHERE id=?",
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
    "SELECT id, name FROM leave_types WHERE id=? AND organization_id=?",
    [id, orgId]
  );
  if (!exists.length) throw new ApiError(404, "Leave type not found");
  if (isDefaultUnpaidLeaveType(exists[0].name)) {
    throw new ApiError(400, `"${DEFAULT_UNPAID_LEAVE_TYPE}" is reserved for employee unpaid leave requests.`);
  }

  try {
    await pool.query("DELETE FROM leave_types WHERE id=?", [id]);
  } catch (e) {
    if (
      String(e.message).includes("fk_leave_requests_type")
      || String(e.message).includes("fk_leave_ledger_type")
    ) {
      throw new ApiError(409, "Cannot delete — leave requests or balance ledger history already exist for this type.");
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
    `SELECT lt.id, lt.name, lt.days_allowed_per_year, lt.is_paid
     FROM leave_types lt
     JOIN employee_leave_allocations ela ON ela.leave_type_id = lt.id
     WHERE lt.organization_id=? AND lt.name<>? AND ela.employee_uuid=? AND ela.year=? AND ela.allocated_days > 0
     GROUP BY lt.id, lt.name, lt.days_allowed_per_year, lt.is_paid
     ORDER BY lt.name`,
    [req.user.organization, DEFAULT_UNPAID_LEAVE_TYPE, empRows[0].uuid, year]
  );
  return ok(res, { leaveTypes: rows }, "Leave types");
}

export async function myLeaveCalendar(req, res) {
  if (!req.user.organization) throw new ApiError(400, "User has no organization");
  const { m, y } = payrollService.assertMonthYear(req.query.month, req.query.year);
  const [empRows] = await pool.query(
    "SELECT uuid FROM employees WHERE linked_user_uuid=? AND organization_id=?",
    [req.user.uuid, req.user.organization]
  );
  if (!empRows.length) throw new ApiError(403, "No employee record is linked to your account");

  const calendar = await payrollService.getWorkingDaysForMonth({
    orgId: req.user.organization,
    month: m,
    year: y,
  });
  const monthStart = `${y}-${String(m).padStart(2, "0")}-01`;
  const monthEnd = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const [busyRanges] = await pool.query(
    `SELECT DATE_FORMAT(start_date, '%Y-%m-%d') AS start_date,
            DATE_FORMAT(end_date, '%Y-%m-%d') AS end_date
     FROM leave_requests
     WHERE employee_uuid=? AND status IN ('pending','approved')
       AND start_date <= ? AND end_date >= ?`,
    [empRows[0].uuid, monthEnd, monthStart]
  );

  let rangeWorkingDays = null;
  let rangeOverlaps = false;
  const { from, to } = req.query;
  if (from !== undefined || to !== undefined) {
    if (!validIsoDate(from) || !validIsoDate(to) || from > to) {
      throw new ApiError(400, "A valid from/to date range is required.");
    }
    const dates = await getWorkingDatesBetween(req.user.organization, from, to);
    rangeWorkingDays = dates.length;
    const [[overlap]] = await pool.query(
      `SELECT COUNT(*) AS count FROM leave_requests
       WHERE employee_uuid=? AND status IN ('pending','approved')
         AND start_date <= ? AND end_date >= ?`,
      [empRows[0].uuid, to, from]
    );
    rangeOverlaps = Number(overlap.count) > 0;
  }

  return ok(res, {
    month: m,
    year: y,
    working_dates: calendar.workingDates,
    busy_ranges: busyRanges,
    range_working_days: rangeWorkingDays,
    range_overlaps: rangeOverlaps,
  }, "Leave calendar");
}

export async function myLeaveBalances(req, res) {
  if (!req.user.organization) throw new ApiError(400, "User has no organization");
  const [empRows] = await pool.query(
    "SELECT uuid FROM employees WHERE linked_user_uuid=? AND organization_id=?",
    [req.user.uuid, req.user.organization]
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
    "SELECT uuid FROM employees WHERE linked_user_uuid=? AND organization_id=?",
    [req.user.uuid, req.user.organization]
  );
  if (!empRows.length) return ok(res, paginatedResponse([], 0, page, limit), "My leaves");

  const status = typeof req.query.status === "string" && ["pending", "approved", "rejected", "cancelled"].includes(req.query.status) ? req.query.status : "";
  const dateFrom = typeof req.query.dateFrom === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.dateFrom) ? req.query.dateFrom : "";
  const dateTo = typeof req.query.dateTo === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.dateTo) ? req.query.dateTo : "";
  const conditions = ["lr.employee_uuid=?"];
  const params = [empRows[0].uuid];
  if (status) { conditions.push("lr.status=?"); params.push(status); }
  if (dateFrom) { conditions.push("lr.start_date >= ?"); params.push(dateFrom); }
  if (dateTo) { conditions.push("lr.start_date <= ?"); params.push(dateTo); }
  const whereClause = `WHERE ${conditions.join(" AND ")}`;

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM leave_requests lr ${whereClause}`,
    params
  );
  const [rows] = await pool.query(
    `SELECT lr.uuid,
            DATE_FORMAT(lr.start_date, '%Y-%m-%d') AS start_date,
            DATE_FORMAT(lr.end_date, '%Y-%m-%d') AS end_date,
            lr.reason, lr.status, lr.approved_by, lr.approved_at,
            lr.created_at, lr.employee_uuid, lr.leave_type_id,
            lr.day_portion, lr.approved_days, lr.requested_treatment, lr.approved_treatment,
            lr.cancelled_by, lr.cancelled_at,
            CASE WHEN lt.name = '${DEFAULT_UNPAID_LEAVE_TYPE}' THEN '${DEFAULT_UNPAID_LEAVE_LABEL}' ELSE lt.name END AS leave_type_name
     FROM leave_requests lr
     JOIN leave_types lt ON lt.id = lr.leave_type_id
     ${whereClause}
     ORDER BY lr.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
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
  const { leave_type_id, default_unpaid, start_date, end_date, reason } = req.body;
  const dayPortion = req.body?.day_portion ?? "full";
  if (!["full", "half"].includes(dayPortion)) {
    throw new ApiError(400, "day_portion must be full or half.");
  }
  if (dayPortion !== "full" && start_date !== end_date) {
    throw new ApiError(400, "Half-day leave must apply to exactly one date.");
  }
  const requestsDefaultUnpaid = default_unpaid === true;
  if (!requestsDefaultUnpaid && !leave_type_id) throw new ApiError(400, "leave_type_id is required");
  if (!validIsoDate(start_date) || !validIsoDate(end_date)) throw new ApiError(400, "Valid start_date and end_date are required");
  if (String(start_date) > String(end_date)) throw new ApiError(400, "start_date must be before or equal to end_date");

  const [empRows] = await pool.query(
    "SELECT uuid, organization_id, is_platform_user, joining_date FROM employees WHERE linked_user_uuid=? AND organization_id=?",
    [req.user.uuid, req.user.organization]
  );
  if (!empRows.length) throw new ApiError(403, "No employee record is linked to your account");
  const emp = empRows[0];
  if (emp.is_platform_user !== "yes") throw new ApiError(403, "Your account is not a platform user");
  if (emp.organization_id !== req.user.organization) throw new ApiError(403, "Organization mismatch");
  if (emp.joining_date && start_date < isoDate(emp.joining_date)) {
    throw new ApiError(400, "Leave cannot start before the employee's joining date.");
  }

  let leaveType;
  if (requestsDefaultUnpaid) {
    leaveType = await getDefaultUnpaidLeaveType(req.user.organization);
  } else {
    const typeId = Number(leave_type_id);
    const [ltRows] = await pool.query(
      "SELECT id, name, is_paid FROM leave_types WHERE id=? AND organization_id=?",
      [typeId, req.user.organization]
    );
    if (!ltRows.length) throw new ApiError(404, "Leave type not found");
    if (isDefaultUnpaidLeaveType(ltRows[0].name)) {
      throw new ApiError(400, "Select the default unpaid option to request unpaid leave without an allocation.");
    }
    leaveType = ltRows[0];
  }
  const typeId = leaveType.id;
  const requestedTreatment = leaveType.is_paid === "no" ? "unpaid" : "paid";
  const leaveTypeLabel = requestsDefaultUnpaid ? DEFAULT_UNPAID_LEAVE_LABEL : leaveType.name;

  let days;
  const year = yearOfDate(start_date);

  // Requirement 3: block submission when the employee has no remaining balance
  // allocated for this leave type in the leave's year.
  const alloc = requestsDefaultUnpaid ? null : await getAllocation(pool, emp.uuid, typeId, year);
  if (!requestsDefaultUnpaid && (!alloc || alloc.remaining_days <= 0)) {
    const available = alloc ? alloc.remaining_days : 0;
    throw new ApiError(
      409,
      `No ${leaveType.name} leave balance remaining for ${year} (${available} day(s) available)`
    );
  }
  const conn = await pool.getConnection();
  let rows;
  try {
    await conn.beginTransaction();
    await conn.query("SELECT uuid FROM employees WHERE uuid=? FOR UPDATE", [emp.uuid]);
    const workingDates = await getWorkingDatesBetween(
      req.user.organization,
      start_date,
      end_date,
      conn,
    );
    if (!workingDates.includes(start_date) || !workingDates.includes(end_date)) {
      throw new ApiError(400, "Leave start and end dates must be working days in the payroll calendar.");
    }
    if (dayPortion !== "full" && workingDates.length !== 1) {
      throw new ApiError(400, "Half-day leave must apply to one configured working day.");
    }
    days = dayPortion === "full" ? workingDates.length : 0.5;
    if (days < 0.5) throw new ApiError(400, "Leave range must include at least one working day.");
    const [overlaps] = await conn.query(
      `SELECT uuid FROM leave_requests
       WHERE employee_uuid=? AND status IN ('pending','approved')
         AND start_date <= ? AND end_date >= ?
       LIMIT 1`,
      [emp.uuid, end_date, start_date]
    );
    if (overlaps.length) {
      throw new ApiError(409, "This leave overlaps an existing pending or approved leave request.");
    }
    const [result] = await conn.query(
      `INSERT INTO leave_requests
         (uuid, employee_uuid, leave_type_id, start_date, end_date, reason, requested_treatment, day_portion, status)
       VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [emp.uuid, typeId, start_date, end_date, reason || null, requestedTreatment, dayPortion]
    );
    [rows] = await conn.query("SELECT * FROM leave_requests WHERE id=?", [result.insertId]);
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }

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
        message: `${req.user.full_name} requested ${days} day(s) of ${leaveTypeLabel} leave.`,
        link: "/org/leaves",
        referenceId: rows[0].uuid,
        email: {
          category: "leave",
          eventKey: `leave:${rows[0].uuid}:submitted`,
          subject: `Leave request needs review — ${req.user.full_name}`,
          title: "New leave request",
          message: `${req.user.full_name} requested ${days} day(s) of ${leaveTypeLabel} leave. Please review the request in Dverif.`,
        },
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
    details: { leave_type: leaveTypeLabel, days, start_date, end_date },
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
  const dateFrom = typeof req.query.dateFrom === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.dateFrom)
    ? req.query.dateFrom : "";
  const dateTo = typeof req.query.dateTo === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.dateTo)
    ? req.query.dateTo : "";

  let whereClause = "WHERE e.organization_id = ?";
  const params = [orgId];
  const scopeFilter = employeeScopeCondition(req, "leave_management", "e");
  if (scopeFilter) {
    whereClause += ` AND ${scopeFilter.sql}`;
    params.push(...scopeFilter.params);
  }
  // Review queues must include future requests as well as requests active today.
  if (dateFrom || dateTo) {
    const from = dateFrom || dateTo;
    const to = dateTo || dateFrom;
    whereClause += " AND lr.start_date <= ? AND lr.end_date >= ?";
    params.push(to, from);
  }
  if (["pending", "approved", "rejected", "cancelled"].includes(status)) {
    whereClause += " AND lr.status = ?";
    params.push(status);
  }
  const employeeUuid = typeof req.query.employee_uuid === "string" ? req.query.employee_uuid.trim() : "";
  if (employeeUuid) {
    assertUuid(employeeUuid, "Employee UUID");
    whereClause += " AND e.uuid = ?";
    params.push(employeeUuid);
  }
  const leaveTypeId = typeof req.query.leave_type_id === "string" ? req.query.leave_type_id.trim() : "";
  if (leaveTypeId) {
    const typeId = Number(leaveTypeId);
    if (!Number.isInteger(typeId) || typeId < 1) throw new ApiError(400, "leave_type_id must be a positive integer");
    whereClause += " AND lt.id = ?";
    params.push(typeId);
  }
  if (dateFrom && dateTo && dateFrom > dateTo) throw new ApiError(400, "dateFrom cannot be after dateTo");
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
            lr.reason, lr.status, lr.requested_treatment, lr.approved_treatment,
            lr.day_portion, lr.approved_days, lr.cancelled_by, lr.cancelled_at,
            lr.approved_by, lr.approved_at, lr.created_at,
            e.uuid AS employee_uuid, e.full_name AS employee_name,
            e.email AS employee_email, dg.name AS designation,
            lt.id AS leave_type_id,
            CASE WHEN lt.name = '${DEFAULT_UNPAID_LEAVE_TYPE}' THEN '${DEFAULT_UNPAID_LEAVE_LABEL}' ELSE lt.name END AS leave_type_name
     FROM leave_requests lr
     JOIN employees e ON e.uuid = lr.employee_uuid
     LEFT JOIN designations dg ON dg.id = e.designation_id
     JOIN leave_types lt ON lt.id = lr.leave_type_id
     ${whereClause}
     ORDER BY lr.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  const items = await Promise.all(rows.map(async (row) => {
    const [schedule] = await pool.query(
      `SELECT schedule_date, day_type
       FROM organization_monthly_work_schedules
       WHERE organization_id=? AND schedule_date BETWEEN ? AND ?`,
      [orgId, row.start_date, row.end_date],
    );
    const start = new Date(`${row.start_date}T00:00:00Z`);
    const end = new Date(`${row.end_date}T00:00:00Z`);
    const dateCount = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
    const scheduleComplete = Number.isFinite(dateCount) && dateCount > 0 && schedule.length === dateCount;
    return {
      ...row,
      working_days: row.approved_days ?? (
        row.day_portion !== "full" ? 0.5 : scheduleComplete
          ? schedule.filter((day) => day.day_type === "working").length
          : null
      ),
    };
  }));
  return ok(res, paginatedResponse(items, total, page, limit), "Org leave requests");
}

export async function listLeaveEmployees(req, res) {
  const scopeFilter = employeeScopeCondition(req, "leave_management", "e");
  const whereClause = `WHERE e.organization_id = ?${scopeFilter ? ` AND ${scopeFilter.sql}` : ""}`;
  const params = [req.scopeOrgId, ...(scopeFilter?.params ?? [])];
  const [rows] = await pool.query(
    `SELECT e.uuid, e.full_name
       FROM employees e
       ${whereClause}
      ORDER BY e.full_name`,
    params,
  );
  return ok(res, { employees: rows }, "Leave filter employees");
}

export async function decideLeave(req, res) {
  const { uuid } = req.params;
  const { status } = req.body;
  assertUuid(uuid, "Leave request UUID");
  if (!["approved", "rejected"].includes(status)) {
    throw new ApiError(400, "status must be approved or rejected");
  }
  const requestedApprovalTreatment = req.body?.approved_treatment;
  if (
    requestedApprovalTreatment !== undefined
    && (status !== "approved" || !["paid", "unpaid"].includes(requestedApprovalTreatment))
  ) {
    throw new ApiError(400, "approved_treatment must be paid or unpaid and can only be set when approving a leave.");
  }
  const actorUuid = req.admin?.uuid || req.user?.uuid || null;
  if (!req.admin && !["org_admin", "sub_admin"].includes(req.user?.org_role)) {
    throw new ApiError(403, "Only authorized organization admins can decide leave requests.");
  }

  const conn = await pool.getConnection();
  let lr;
  let finalTreatment = null;
  let days = 0;
  try {
    await conn.beginTransaction();
    const [initial] = await conn.query(
      "SELECT employee_uuid FROM leave_requests WHERE uuid=?",
      [uuid],
    );
    if (!initial.length) throw new ApiError(404, "Leave request not found");
    await conn.query("SELECT uuid FROM employees WHERE uuid=? FOR UPDATE", [initial[0].employee_uuid]);
    const [rows] = await conn.query(
      `SELECT lr.*, lt.name AS leave_type_system_name, lt.is_paid,
              CASE WHEN lt.name = '${DEFAULT_UNPAID_LEAVE_TYPE}' THEN '${DEFAULT_UNPAID_LEAVE_LABEL}' ELSE lt.name END AS leave_type_name,
              e.organization_id, e.linked_user_uuid, e.full_name AS employee_name,
              e.joining_date
       FROM leave_requests lr
       JOIN leave_types lt ON lt.id = lr.leave_type_id
       JOIN employees e ON e.uuid = lr.employee_uuid
       WHERE lr.uuid=? FOR UPDATE`,
      [uuid],
    );
    if (!rows.length) throw new ApiError(404, "Leave request not found");
    lr = rows[0];
    if (lr.status !== "pending") throw new ApiError(409, "Leave request has already been decided");
    if (!req.admin && lr.organization_id !== req.user.organization) {
      throw new ApiError(403, "This leave request is not part of your organization.");
    }
    await assertEmployeeInDataScope(req, "leave_management", lr.employee_uuid);

    if (status === "approved") {
      const startDate = isoDate(lr.start_date);
      const endDate = isoDate(lr.end_date);
      if (lr.joining_date && startDate < isoDate(lr.joining_date)) {
        throw new ApiError(409, "Leave cannot be approved for dates before the employee's joining date.");
      }
      const [overlaps] = await conn.query(
        `SELECT uuid FROM leave_requests
         WHERE employee_uuid=? AND uuid<>? AND status IN ('pending','approved')
           AND start_date <= ? AND end_date >= ?
         LIMIT 1`,
        [lr.employee_uuid, uuid, endDate, startDate],
      );
      if (overlaps.length) {
        throw new ApiError(409, "This request conflicts with another pending or approved leave request.");
      }
      const workingDates = await getWorkingDatesBetween(lr.organization_id, startDate, endDate, conn);
      if (!workingDates.includes(startDate) || !workingDates.includes(endDate)) {
        throw new ApiError(409, "Leave start and end dates must be working days in the payroll calendar.");
      }
      if (lr.day_portion !== "full" && (startDate !== endDate || workingDates.length !== 1)) {
        throw new ApiError(409, "Half-day leave must apply to exactly one configured working day.");
      }
      days = lr.day_portion === "full" ? workingDates.length : 0.5;
      if (days < 0.5) throw new ApiError(409, "Leave range must include at least one working day.");

      finalTreatment = requestedApprovalTreatment ?? (lr.is_paid === "no" ? "unpaid" : "paid");
      const isDefaultUnpaid = isDefaultUnpaidLeaveType(lr.leave_type_system_name);
      let allocation = null;
      if (!isDefaultUnpaid && finalTreatment === "paid") {
        const [[row]] = await conn.query(
          `SELECT * FROM employee_leave_allocations
           WHERE employee_uuid=? AND leave_type_id=? AND year=? FOR UPDATE`,
          [lr.employee_uuid, lr.leave_type_id, yearOfDate(lr.start_date)],
        );
        allocation = row || null;
        if (!allocation) throw new ApiError(409, "No leave balance is allocated for this leave type this year.");
        const previousBalance = await getLeaveLedgerBalance(conn, allocation.id, allocation.remaining_days);
        if (previousBalance < days) {
          throw new ApiError(409, `Insufficient ${lr.leave_type_name} balance — ${days} day(s) requested, ${previousBalance} available.`);
        }
        const updatedBalance = previousBalance - days;
        await conn.query(
          "UPDATE employee_leave_allocations SET used_days=used_days+?, remaining_days=? WHERE id=?",
          [days, updatedBalance, allocation.id],
        );
        await recordLeaveBalanceTransaction(conn, {
          employeeUuid: lr.employee_uuid,
          leaveTypeId: lr.leave_type_id,
          allocationId: allocation.id,
          transactionType: "leave_approved",
          debitedDays: days,
          previousBalance,
          updatedBalance,
          leaveRequestUuid: uuid,
          performedBy: actorUuid,
          reason: `Approved ${lr.leave_type_name} leave from ${startDate} to ${endDate}.`,
        });
      }
      const [decision] = await conn.query(
        `UPDATE leave_requests
         SET status='approved', approved_treatment=?, approved_days=?,
             approved_by=?, approved_at=NOW()
         WHERE uuid=? AND status='pending'`,
        [finalTreatment, days, actorUuid, uuid],
      );
      if (!decision.affectedRows) throw new ApiError(409, "Leave request has already been decided.");
    } else {
      const [decision] = await conn.query(
        "UPDATE leave_requests SET status='rejected', approved_by=?, approved_at=NOW() WHERE uuid=? AND status='pending'",
        [actorUuid, uuid],
      );
      if (!decision.affectedRows) throw new ApiError(409, "Leave request has already been decided.");
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
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
        email: {
          category: "leave",
          eventKey: `leave:${uuid}:decision:${status}`,
          subject: `Your ${lr.leave_type_name} leave was ${statusText.toLowerCase()}`,
          title: `Leave ${statusText.toLowerCase()}`,
          message: `Your ${lr.leave_type_name} leave request (${isoDate(lr.start_date)} to ${isoDate(lr.end_date)}) was ${statusText.toLowerCase()}.`,
        },
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
    details: { status, requested_treatment: lr.requested_treatment || "unpaid", approved_treatment: finalTreatment, days },
    req,
  });

  const [final] = await pool.query("SELECT * FROM leave_requests WHERE uuid=?", [uuid]);
  return ok(res, { leaveRequest: final[0] }, "Leave request updated");
}

export async function cancelLeave(req, res) {
  const { uuid } = req.params;
  assertUuid(uuid, "Leave request UUID");
  const actorUuid = req.admin?.uuid || req.user?.uuid || null;
  const conn = await pool.getConnection();
  let leave;
  let restoredDays = 0;
  try {
    await conn.beginTransaction();
    const [initial] = await conn.query("SELECT employee_uuid FROM leave_requests WHERE uuid=?", [uuid]);
    if (!initial.length) throw new ApiError(404, "Leave request not found");
    await conn.query("SELECT uuid FROM employees WHERE uuid=? FOR UPDATE", [initial[0].employee_uuid]);
    const [rows] = await conn.query(
      `SELECT lr.*, lt.name AS leave_type_name, lt.is_paid,
              e.organization_id, e.linked_user_uuid
       FROM leave_requests lr
       JOIN leave_types lt ON lt.id=lr.leave_type_id
       JOIN employees e ON e.uuid=lr.employee_uuid
       WHERE lr.uuid=? FOR UPDATE`,
      [uuid],
    );
    if (!rows.length) throw new ApiError(404, "Leave request not found");
    leave = rows[0];
    const isOwner = leave.linked_user_uuid === req.user?.uuid;
    const isOrgStaff = ["org_admin", "sub_admin"].includes(req.user?.org_role);
    if (!req.admin && !isOwner && !isOrgStaff) throw new ApiError(403, "You may only cancel your own leave request or a request within your authorized organization scope.");
    if (!req.admin && leave.organization_id !== req.user?.organization) {
      throw new ApiError(403, "This leave request is not part of your organization.");
    }
    if (!isOwner && isOrgStaff) await assertEmployeeInDataScope(req, "leave_management", leave.employee_uuid);
    if (!["pending", "approved"].includes(leave.status)) {
      throw new ApiError(409, "Only pending or approved leave requests can be cancelled.");
    }

    const approvedTreatment = leave.approved_treatment
      ?? (leave.is_paid === "no" ? "unpaid" : "paid");
    if (
      leave.status === "approved"
      && approvedTreatment === "paid"
      && !isDefaultUnpaidLeaveType(leave.leave_type_name)
    ) {
      const year = yearOfDate(leave.start_date);
      const [[allocation]] = await conn.query(
        `SELECT * FROM employee_leave_allocations
         WHERE employee_uuid=? AND leave_type_id=? AND year=? FOR UPDATE`,
        [leave.employee_uuid, leave.leave_type_id, year],
      );
      if (!allocation) throw new ApiError(409, "The approved leave balance allocation no longer exists.");
      const [[approval]] = await conn.query(
        `SELECT debited_days FROM leave_balance_ledger
         WHERE related_leave_request_uuid=? AND transaction_type='leave_approved'`,
        [uuid],
      );
      const [[priorCancellation]] = await conn.query(
        `SELECT id FROM leave_balance_ledger
         WHERE related_leave_request_uuid=? AND transaction_type='leave_cancelled'`,
        [uuid],
      );
      if (priorCancellation) throw new ApiError(409, "This leave balance has already been restored.");
      restoredDays = approval
        ? Number(approval.debited_days)
        : Number(leave.approved_days ?? (await getWorkingDatesBetween(
          leave.organization_id,
          isoDate(leave.start_date),
          isoDate(leave.end_date),
          conn,
        )).length);
      if (!approval && leave.day_portion !== "full") restoredDays = 0.5;
      const previousBalance = await getLeaveLedgerBalance(conn, allocation.id, allocation.remaining_days);
      const updatedBalance = previousBalance + restoredDays;
      await conn.query(
        "UPDATE employee_leave_allocations SET used_days=GREATEST(0, used_days-?), remaining_days=? WHERE id=?",
        [restoredDays, updatedBalance, allocation.id],
      );
      await recordLeaveBalanceTransaction(conn, {
        employeeUuid: leave.employee_uuid,
        leaveTypeId: leave.leave_type_id,
        allocationId: allocation.id,
        transactionType: "leave_cancelled",
        creditedDays: restoredDays,
        previousBalance,
        updatedBalance,
        leaveRequestUuid: uuid,
        performedBy: actorUuid,
        reason: `Cancelled approved ${leave.leave_type_name} leave and restored ${restoredDays} day(s).`,
      });
    }
    const [result] = await conn.query(
      `UPDATE leave_requests
       SET status='cancelled', cancelled_by=?, cancelled_at=NOW()
       WHERE uuid=? AND status IN ('pending','approved')`,
      [actorUuid, uuid],
    );
    if (!result.affectedRows) throw new ApiError(409, "Leave request has already been cancelled.");
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }

  logAudit({
    ...getActorFromReq(req),
    action: "leave.cancel",
    entityType: "leave_request",
    entityId: uuid,
    details: { previous_status: leave.status, restored_days: restoredDays },
    req,
  });
  const [final] = await pool.query("SELECT * FROM leave_requests WHERE uuid=?", [uuid]);
  return ok(res, { leaveRequest: final[0] }, "Leave request cancelled");
}
