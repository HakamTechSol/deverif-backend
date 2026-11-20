import ApiError from "../utils/ApiError.js";
import { pool } from "../config/db.js";
import { employeeScopeCondition, assertEmployeeInDataScope } from "../utils/dataScopes.js";
import { ok, created } from "../utils/response.js";
import { assertUuid } from "../utils/publicResponse.js";
import { parsePagination, paginatedResponse } from "../utils/pagination.js";
import { logAudit, getActorFromReq } from "../utils/auditLog.js";
import { ipMatches, isValidIpRule } from "../utils/ipMatch.js";
import { normalizeIp } from "../utils/ip.js";
import ipaddr from "ipaddr.js";
import { isoDate } from "../utils/leaveBalance.js";
import {
  attendanceDurationForShift,
  attendanceMetrics,
  buildAttendanceRange,
  karachiDate,
  karachiDateTime,
  validAttendanceDate,
  validAttendanceTime,
} from "../services/attendance.service.js";

function serializeAttendanceDate(row) {
  if (!row?.date) return row;
  const metrics = attendanceMetrics({
    checkInAt: row.check_in_at,
    checkOutAt: row.check_out_at,
    breakDurationMinutes: row.break_duration_minutes ?? 0,
    shiftDurationMinutes: attendanceDurationForShift(row.shift_start_time, row.shift_end_time),
  });
  return {
    ...row,
    date: isoDate(row.date),
    elapsed_minutes: row.check_out_at ? row.elapsed_minutes ?? metrics.elapsed_minutes : null,
    worked_minutes: row.check_out_at ? row.worked_minutes ?? metrics.worked_minutes : null,
    regular_minutes: metrics.regular_minutes,
    overtime_minutes: row.check_out_at ? row.overtime_minutes ?? metrics.overtime_minutes : null,
  };
}

const RECORD_SELECT = `
  SELECT ar.uuid, ar.employee_uuid, ar.organization_id,
         DATE_FORMAT(ar.check_in_at, '%Y-%m-%d %H:%i:%s') AS check_in_at,
         DATE_FORMAT(ar.check_out_at, '%Y-%m-%d %H:%i:%s') AS check_out_at,
         ar.check_in_ip, ar.check_out_ip, ar.checkout_source, ar.break_duration_minutes,
         ar.worked_minutes, ar.overtime_minutes,
         DATE_FORMAT(ar.date, '%Y-%m-%d') AS date, ar.status, ar.is_manual,
         ar.manual_reason, ar.created_at, ps.shift_start_time, ps.shift_end_time,
         e.full_name AS employee_name, e.email AS employee_email, dg.name AS designation,
         o.uuid AS organization_uuid, o.name AS organization_name
  FROM attendance_records ar
  JOIN employees e ON e.uuid = ar.employee_uuid
  LEFT JOIN designations dg ON dg.id = e.designation_id
  LEFT JOIN organization_payroll_settings ps ON ps.organization_id = ar.organization_id
  JOIN organizations o ON o.id = ar.organization_id`;

async function inAttendanceTransaction(work) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await work(conn);
    await conn.commit();
    return result;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

async function calculateAttendanceForOrg({ conn, organizationId, checkInAt, checkOutAt, breakDurationMinutes = 0 }) {
  const [policyRows] = await conn.query(
    "SELECT shift_start_time, shift_end_time FROM organization_payroll_settings WHERE organization_id=?",
    [organizationId],
  );
  const shiftDuration = policyRows.length
    ? attendanceDurationForShift(policyRows[0].shift_start_time, policyRows[0].shift_end_time)
    : null;
  return attendanceMetrics({
    checkInAt,
    checkOutAt,
    breakDurationMinutes,
    shiftDurationMinutes: shiftDuration,
  });
}

function parseBreakDuration(value, { nullable = true } = {}) {
  if ((value === undefined || value === null || value === "") && nullable) return null;
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) {
    throw new ApiError(400, "break_duration_minutes must be a whole number between 0 and 1440.");
  }
  return minutes;
}

/** Resolve org id for IP-list management (org-admin scoped, or admin by uuid). */
async function resolveScopeOrgId(req) {
  if (req.scopeOrgId) return req.scopeOrgId;
  const orgUuid = req.body.organization_uuid || req.query.organization_uuid;
  if (!orgUuid) throw new ApiError(400, "organization_uuid is required");
  assertUuid(orgUuid, "Organization UUID");
  const [rows] = await pool.query("SELECT id FROM organizations WHERE uuid=?", [orgUuid]);
  if (!rows.length) throw new ApiError(404, "Organization not found");
  return rows[0].id;
}

/** Load the current user's linked employee record. */
async function resolveEmployee(req) {
  if (!req.user.organization) throw new ApiError(400, "User has no organization");
  const [empRows] = await pool.query(
    "SELECT uuid, organization_id, is_platform_user FROM employees WHERE linked_user_uuid=?",
    [req.user.uuid]
  );
  if (!empRows.length) throw new ApiError(403, "No employee record is linked to your account");
  const emp = empRows[0];
  if (emp.is_platform_user !== "yes") throw new ApiError(403, "Your account is not a platform user");
  if (emp.organization_id !== req.user.organization) throw new ApiError(403, "Organization mismatch");
  return emp;
}

/**
 * Loopback requests (::1 / 127.0.0.1) only ever occur in local development —
 * the vite dev proxy adds no X-Forwarded-For, so req.ip is always loopback and
 * a public-IP allow-list can never match. Opt-in via ALLOW_LOOPBACK_ATTENDANCE=true
 * (dev .env only — never set this in production).
 */
function isLoopbackIp(value) {
  try {
    return ipaddr.process(String(value)).range() === "loopback";
  } catch {
    return false;
  }
}

/** Reject if the request IP is not on the organization's allow-list. */
async function assertAllowedIp(req, orgId) {
  const [orgRows] = await pool.query(
    "SELECT id FROM organizations WHERE id=?",
    [orgId]
  );
  if (!orgRows.length) throw new ApiError(404, "Organization not found");

  const [ruleRows] = await pool.query(
    "SELECT ip_address, rule_type FROM organization_ip_rules WHERE organization_id=?",
    [orgId]
  );
  const allowRules = [];
  const denyRules = [];
  for (const r of ruleRows) {
    if (r.rule_type === "deny") denyRules.push(r.ip_address);
    else allowRules.push(r.ip_address);
  }

  // No allow-list configured at all -> attendance is OFF for this organization.
  // This is checked BEFORE the loopback dev bypass on purpose: a bypass exists
  // to let a developer work from localhost once real IPs are configured, never
  // to stand in for the admin never having set anything up. Without this guard
  // an organization that configured nothing could still mark attendance, which
  // defeats the whole point of office-IP-only attendance.
  if (allowRules.length === 0) {
    throw new ApiError(403, "Attendance is not enabled for your organization yet. Please contact your admin.");
  }

  const clientIp = normalizeIp(req.ip);
  if (process.env.ALLOW_LOOPBACK_ATTENDANCE === "true" && isLoopbackIp(clientIp)) {
    console.warn(
      `[attendance] IP allow-list bypassed for loopback address ${clientIp} (ALLOW_LOOPBACK_ATTENDANCE=true)`
    );
    return;
  }

  if (ipMatches(clientIp, denyRules)) {
    throw new ApiError(
      403,
      `Your IP address (${clientIp}) is explicitly blocked on this organization.`
    );
  }
  if (!ipMatches(clientIp, allowRules)) {
    throw new ApiError(
      403,
      `Your IP address (${clientIp}) is not on this organization's allowed list. ` +
        "Attendance can only be marked from an approved office network."
    );
  }
}

/** Staff (org_admin/sub_admin) are managers, not tracked staff — attendance is for employees only. */
function assertSelfCheckInAllowed(req) {
  if (req.user?.org_role === "org_admin" || req.user?.org_role === "sub_admin") {
    throw new ApiError(
      403,
      "Org admins and sub-admins manage attendance for their team and cannot mark attendance for themselves"
    );
  }
}

// ---------------------------------------------------------------------------
// Platform user: own attendance history
// ---------------------------------------------------------------------------

export async function myAttendanceHistory(req, res) {
  const [empRows] = await pool.query(
    "SELECT uuid FROM employees WHERE linked_user_uuid=? AND is_platform_user='yes'",
    [req.user.uuid]
  );
  if (!empRows.length) return ok(res, paginatedResponse([], 0, 1, 10), "Attendance records");

  const employeeUuid = empRows[0].uuid;
  const { page, limit, offset } = parsePagination(req.query);
  const dateFrom = typeof req.query.dateFrom === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.dateFrom) ? req.query.dateFrom : "";
  const dateTo = typeof req.query.dateTo === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.dateTo) ? req.query.dateTo : "";
  const status = typeof req.query.status === "string" && ["checked_in", "checked_out"].includes(req.query.status) ? req.query.status : "";
  const conditions = ["ar.employee_uuid=?"];
  const params = [employeeUuid];
  if (dateFrom) { conditions.push("ar.date >= ?"); params.push(dateFrom); }
  if (dateTo) { conditions.push("ar.date <= ?"); params.push(dateTo); }
  if (status) { conditions.push("ar.status = ?"); params.push(status); }
  const whereClause = `WHERE ${conditions.join(" AND ")}`;

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM attendance_records ar ${whereClause}`,
    params
  );
  const [rows] = await pool.query(
    `${RECORD_SELECT} ${whereClause}
     ORDER BY ar.date DESC, ar.check_in_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return ok(res, paginatedResponse(rows.map(serializeAttendanceDate), total, page, limit), "Attendance records");
}

// ---------------------------------------------------------------------------
// Platform user: check-in / check-out / today
// ---------------------------------------------------------------------------

export async function checkIn(req, res) {
  assertSelfCheckInAllowed(req);
  const emp = await resolveEmployee(req);
  await assertAllowedIp(req, req.user.organization);
  const date = karachiDate();
  const checkInAt = karachiDateTime();
  let result;
  try {
    result = await inAttendanceTransaction(async (conn) => {
      const [lockedEmployee] = await conn.query(
        "SELECT uuid FROM employees WHERE uuid=? AND organization_id=? FOR UPDATE",
        [emp.uuid, req.user.organization],
      );
      if (!lockedEmployee.length) throw new ApiError(403, "Organization mismatch");

      const [openRows] = await conn.query(
        `SELECT id FROM attendance_records
          WHERE employee_uuid=? AND check_out_at IS NULL AND status='checked_in'
          ORDER BY check_in_at DESC LIMIT 1 FOR UPDATE`,
        [emp.uuid],
      );
      if (openRows.length) throw new ApiError(409, "You already have an active attendance shift");

      const [existingRows] = await conn.query(
        "SELECT id, status FROM attendance_records WHERE employee_uuid=? AND date=? FOR UPDATE",
        [emp.uuid, date],
      );
      if (existingRows.length) {
        throw new ApiError(
          409,
          existingRows[0].status === "checked_out" ? "Already checked out for this shift date" : "Already checked in",
        );
      }

      const [inserted] = await conn.query(
        `INSERT INTO attendance_records
           (uuid, employee_uuid, organization_id, check_in_at, check_in_ip, date, status,
            checkout_source, break_duration_minutes, worked_minutes, overtime_minutes)
         VALUES (UUID(), ?, ?, ?, ?, ?, 'checked_in', NULL, NULL, NULL, NULL)`,
        [emp.uuid, req.user.organization, checkInAt, normalizeIp(req.ip), date],
      );
      return inserted;
    });
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (e && (e.code === "ER_DUP_ENTRY" || String(e.message).includes("Duplicate"))) {
      throw new ApiError(409, "Already checked in today");
    }
    throw e;
  }
  const [rows] = await pool.query(`${RECORD_SELECT} WHERE ar.id=?`, [result.insertId]);

  logAudit({
    ...getActorFromReq(req),
    action: "attendance.check_in",
    entityType: "attendance_record",
    entityId: rows[0].uuid,
    details: { ip: normalizeIp(req.ip) },
    req,
  });
  return created(res, { record: serializeAttendanceDate(rows[0]) }, "Checked in successfully");
}

export async function checkOut(req, res) {
  assertSelfCheckInAllowed(req);
  const emp = await resolveEmployee(req);
  await assertAllowedIp(req, req.user.organization);
  const checkOutAt = karachiDateTime();
  let attendanceId;
  await inAttendanceTransaction(async (conn) => {
    const [openRows] = await conn.query(
      `SELECT id, DATE_FORMAT(check_in_at, '%Y-%m-%d %H:%i:%s') AS check_in_at,
              break_duration_minutes
         FROM attendance_records
        WHERE employee_uuid=? AND organization_id=?
          AND check_out_at IS NULL AND status='checked_in'
        ORDER BY check_in_at DESC LIMIT 2 FOR UPDATE`,
      [emp.uuid, req.user.organization],
    );
    if (openRows.length > 1) {
      throw new ApiError(409, "Multiple open attendance shifts exist; ask an administrator to correct them.");
    }
    if (!openRows.length) {
      const [closedRows] = await conn.query(
        `SELECT id FROM attendance_records
          WHERE employee_uuid=? AND organization_id=? AND status='checked_out'
            AND DATE(check_out_at)=?
          ORDER BY check_out_at DESC LIMIT 1`,
        [emp.uuid, req.user.organization, karachiDate()],
      );
      if (closedRows.length) throw new ApiError(409, "Already checked out for this shift");
      throw new ApiError(404, "You do not have an active check-in to check out");
    }
    const existing = openRows[0];
    let metrics;
    try {
      const [policyRows] = await conn.query(
        "SELECT shift_start_time, shift_end_time FROM organization_payroll_settings WHERE organization_id=?",
        [req.user.organization],
      );
      const shiftDuration = policyRows.length
        ? attendanceDurationForShift(policyRows[0].shift_start_time, policyRows[0].shift_end_time)
        : null;
      metrics = attendanceMetrics({
        checkInAt: existing.check_in_at,
        checkOutAt,
        breakDurationMinutes: existing.break_duration_minutes ?? 0,
        shiftDurationMinutes: shiftDuration,
      });
    } catch (error) {
      throw new ApiError(409, error.message);
    }
    const [updated] = await conn.query(
      `UPDATE attendance_records
          SET status='checked_out', check_out_at=?, check_out_ip=?, checkout_source='self',
              worked_minutes=?, overtime_minutes=?
        WHERE id=? AND check_out_at IS NULL AND status='checked_in'`,
      [checkOutAt, normalizeIp(req.ip), metrics.worked_minutes, metrics.overtime_minutes, existing.id],
    );
    if (!updated.affectedRows) throw new ApiError(409, "This attendance shift was already checked out.");
    attendanceId = existing.id;
  });
  const [rows] = await pool.query(`${RECORD_SELECT} WHERE ar.id=?`, [attendanceId]);

  logAudit({
    ...getActorFromReq(req),
    action: "attendance.check_out",
    entityType: "attendance_record",
    entityId: rows[0].uuid,
    details: { ip: normalizeIp(req.ip) },
    req,
  });
  return ok(res, { record: serializeAttendanceDate(rows[0]) }, "Checked out successfully");
}

export async function todayStatus(req, res) {
  const emp = await resolveEmployee(req);
  const [rows] = await pool.query(
    `SELECT id, uuid, status,
            DATE_FORMAT(check_in_at, '%Y-%m-%d %H:%i:%s') AS check_in_at,
            DATE_FORMAT(check_out_at, '%Y-%m-%d %H:%i:%s') AS check_out_at,
            check_in_ip, check_out_ip, checkout_source, break_duration_minutes,
            worked_minutes, overtime_minutes, DATE_FORMAT(date, '%Y-%m-%d') AS date
       FROM attendance_records
      WHERE employee_uuid=? AND (date=? OR (status='checked_in' AND check_out_at IS NULL))
      ORDER BY (status='checked_in' AND check_out_at IS NULL) DESC, check_in_at DESC
      LIMIT 1`,
    [emp.uuid, karachiDate()],
  );
  return ok(res, { record: serializeAttendanceDate(rows[0]) ?? null }, "Today's attendance");
}

// ---------------------------------------------------------------------------
// Org-admin: manual attendance entry and correction on behalf of an employee
// ---------------------------------------------------------------------------

export async function manualEntry(req, res) {
  const { employee_uuid, date, check_in_time, check_out_time, break_duration_minutes } = req.body;
  const reason = typeof req.body.reason === "string" ? req.body.reason.trim() : "";

  assertUuid(employee_uuid, "Employee UUID");
  await assertEmployeeInDataScope(req, "attendance", employee_uuid);
  if (!validAttendanceDate(date)) throw new ApiError(400, "date must be a valid YYYY-MM-DD value");
  if (!validAttendanceTime(check_in_time)) throw new ApiError(400, "check_in_time must be HH:MM (24h)");
  const normalizedCheckOut = check_out_time === undefined || check_out_time === null || check_out_time === ""
    ? null
    : check_out_time;
  let timeRange;
  try {
    timeRange = buildAttendanceRange(date, check_in_time, normalizedCheckOut);
  } catch (error) {
    throw new ApiError(400, error.message);
  }
  if (!reason) throw new ApiError(400, "reason is required for a manual attendance entry");
  const breakMinutes = parseBreakDuration(break_duration_minutes);

  // Backdate window — configurable via MANUAL_ATTENDANCE_MAX_AGE_DAYS (default 7).
  const maxAgeDays = Math.max(0, parseInt(process.env.MANUAL_ATTENDANCE_MAX_AGE_DAYS || "7", 10));
  const todayStr = karachiDate();
  const [todayYear, todayMonth, todayDay] = todayStr.split("-").map(Number);
  const earliest = new Date(Date.UTC(todayYear, todayMonth - 1, todayDay - maxAgeDays));
  const minDate = `${earliest.getUTCFullYear()}-${String(earliest.getUTCMonth() + 1).padStart(2, "0")}-${String(earliest.getUTCDate()).padStart(2, "0")}`;
  if (date > todayStr) throw new ApiError(400, "Manual entries cannot be for a future date");
  if (date < minDate && !req.allowMissingAttendanceBackdate) {
    throw new ApiError(
      400,
      `Manual entries can only be backdated up to ${maxAgeDays} day(s) (earliest allowed: ${minDate})`
    );
  }
  if (timeRange.checkInAt > karachiDateTime()) {
    throw new ApiError(400, "Manual check-in cannot be in the future (Asia/Karachi time).");
  }
  if (timeRange.checkOutAt && timeRange.checkOutAt > karachiDateTime()) {
    throw new ApiError(400, "Manual check-out cannot be in the future (Asia/Karachi time).");
  }

  // Target employee must belong to the admin's organization and never be the admin themselves.
  const [empRows] = await pool.query(
    "SELECT uuid, organization_id, linked_user_uuid, full_name, status, joining_date FROM employees WHERE uuid=?",
    [employee_uuid]
  );
  if (!empRows.length) throw new ApiError(404, "Employee not found");
  const emp = empRows[0];
  if (emp.organization_id !== req.scopeOrgId) {
    throw new ApiError(403, "This employee is not part of your organization");
  }
  if (emp.linked_user_uuid === req.user.uuid) {
    throw new ApiError(403, "Org admins cannot add manual attendance for themselves");
  }
  // "Active" here means on the current roster, which after the record_type merge
  // is two enum values: 'current_employee' (normal) and 'active' (deactivated
  // platform user). Reading only 'active' would have rejected every ordinary
  // employee, since a newly created one is 'current_employee'.
  if (!["active", "current_employee"].includes(emp.status)) {
    throw new ApiError(400, "Employee is not a current employee of this organization");
  }
  if (req.allowMissingAttendanceBackdate) {
    if (emp.joining_date && date < isoDate(emp.joining_date)) {
      throw new ApiError(400, "Attendance cannot be recorded before the employee's joining date");
    }
    const [missingRows] = await pool.query(
      `SELECT 1
         FROM organization_monthly_work_schedules s
        WHERE s.organization_id=? AND s.schedule_date=? AND s.day_type='working'
          AND NOT EXISTS (
            SELECT 1 FROM holidays h
             WHERE h.organization_id=s.organization_id AND h.date=s.schedule_date
          )
          AND NOT EXISTS (
            SELECT 1 FROM attendance_records ar
             WHERE ar.employee_uuid=? AND ar.organization_id=s.organization_id AND ar.date=s.schedule_date
          )
        LIMIT 1`,
      [req.scopeOrgId, date, emp.uuid],
    );
    if (!missingRows.length) {
      throw new ApiError(400, "Only an unrecorded scheduled working day can be filled from Missing Attendance");
    }
  }

  const status = timeRange.checkOutAt ? "checked_out" : "checked_in";
  let metrics = { worked_minutes: null, overtime_minutes: null };
  if (timeRange.checkOutAt) {
    try {
      metrics = await calculateAttendanceForOrg({
        conn: pool,
        organizationId: req.scopeOrgId,
        breakDurationMinutes: breakMinutes ?? 0,
        ...timeRange,
      });
    } catch (error) {
      throw new ApiError(400, error.message);
    }
  }
  try {
    await pool.query(
      `INSERT INTO attendance_records
         (uuid, employee_uuid, organization_id, check_in_at, check_out_at, date, status,
          is_manual, manual_reason, checkout_source, break_duration_minutes, worked_minutes, overtime_minutes)
       VALUES (UUID(), ?, ?, ?, ?, ?, ?, 'yes', ?, ?, ?, ?, ?)`,
      [
        emp.uuid,
        req.scopeOrgId,
        timeRange.checkInAt,
        timeRange.checkOutAt,
        date,
        status,
        reason.slice(0, 255),
        timeRange.checkOutAt ? "admin" : null,
        breakMinutes,
        metrics.worked_minutes,
        metrics.overtime_minutes,
      ]
    );
  } catch (e) {
    if (e && (e.code === "ER_DUP_ENTRY" || String(e.message).includes("Duplicate"))) {
      throw new ApiError(409, `An attendance record already exists for this employee on ${date}`);
    }
    throw e;
  }
  const [rows] = await pool.query(
    `${RECORD_SELECT} WHERE ar.employee_uuid=? AND ar.date=?`,
    [emp.uuid, date]
  );

  logAudit({
    ...getActorFromReq(req),
    action: "attendance.manual_entry",
    entityType: "attendance_record",
    entityId: rows[0]?.uuid,
    details: {
      employee_uuid: employee_uuid,
      employee_name: emp.full_name,
      date,
      check_in_time,
      check_out_time: normalizedCheckOut,
      check_out_at: timeRange.checkOutAt,
      reason: reason.slice(0, 255),
    },
    req,
  });

  return created(res, { record: serializeAttendanceDate(rows[0]) }, "Manual attendance entry added");
}

export async function manualMissingEntry(req, res) {
  req.allowMissingAttendanceBackdate = true;
  return manualEntry(req, res);
}

export async function correctAttendance(req, res) {
  const { uuid } = req.params;
  const { check_in_time, check_out_time } = req.body;
  const reason = typeof req.body.reason === "string" ? req.body.reason.trim() : "";
  assertUuid(uuid, "Attendance UUID");
  if (!validAttendanceTime(check_in_time)) throw new ApiError(400, "check_in_time must be HH:MM (24h)");
  const normalizedCheckOut = check_out_time === undefined || check_out_time === null || check_out_time === ""
    ? null
    : check_out_time;
  if (normalizedCheckOut !== null && !validAttendanceTime(normalizedCheckOut)) {
    throw new ApiError(400, "check_out_time must be HH:MM (24h) or empty to clear checkout");
  }
  if (!reason) throw new ApiError(400, "reason is required for an attendance correction");

  let attendanceId;
  let auditDetails;
  await inAttendanceTransaction(async (conn) => {
    const [rows] = await conn.query(
      `SELECT id, uuid, employee_uuid, organization_id, DATE_FORMAT(date, '%Y-%m-%d') AS date,
              DATE_FORMAT(check_in_at, '%Y-%m-%d %H:%i:%s') AS check_in_at,
              DATE_FORMAT(check_out_at, '%Y-%m-%d %H:%i:%s') AS check_out_at,
              break_duration_minutes
         FROM attendance_records
        WHERE uuid=? AND organization_id=? FOR UPDATE`,
      [uuid, req.scopeOrgId],
    );
    if (!rows.length) throw new ApiError(404, "Attendance record not found in this organization");
    const previous = rows[0];
    await assertEmployeeInDataScope(req, "attendance", previous.employee_uuid);
    const breakMinutes = req.body.break_duration_minutes === undefined
      ? previous.break_duration_minutes
      : parseBreakDuration(req.body.break_duration_minutes);
    let timeRange;
    try {
      timeRange = buildAttendanceRange(isoDate(previous.date), check_in_time, normalizedCheckOut);
    } catch (error) {
      throw new ApiError(400, error.message);
    }
    if (timeRange.checkInAt > karachiDateTime()) {
      throw new ApiError(400, "Corrected check-in cannot be in the future (Asia/Karachi time).");
    }
    if (timeRange.checkOutAt && timeRange.checkOutAt > karachiDateTime()) {
      throw new ApiError(400, "Corrected check-out cannot be in the future (Asia/Karachi time).");
    }

    let metrics = { worked_minutes: null, overtime_minutes: null };
    if (timeRange.checkOutAt) {
      try {
        metrics = await calculateAttendanceForOrg({
          conn,
          organizationId: req.scopeOrgId,
          breakDurationMinutes: breakMinutes ?? 0,
          ...timeRange,
        });
      } catch (error) {
        throw new ApiError(400, error.message);
      }
    }
    const status = timeRange.checkOutAt ? "checked_out" : "checked_in";
    await conn.query(
      `UPDATE attendance_records
          SET check_in_at=?, check_out_at=?, status=?, checkout_source=?,
              check_out_ip=NULL, break_duration_minutes=?, worked_minutes=?, overtime_minutes=?
        WHERE id=? AND organization_id=?`,
      [
        timeRange.checkInAt,
        timeRange.checkOutAt,
        status,
        timeRange.checkOutAt ? "admin" : null,
        breakMinutes,
        metrics.worked_minutes,
        metrics.overtime_minutes,
        previous.id,
        req.scopeOrgId,
      ],
    );
    attendanceId = previous.id;
    auditDetails = {
      old: {
        check_in_at: previous.check_in_at,
        check_out_at: previous.check_out_at,
        break_duration_minutes: previous.break_duration_minutes,
      },
      new: {
        check_in_at: timeRange.checkInAt,
        check_out_at: timeRange.checkOutAt,
        break_duration_minutes: breakMinutes,
      },
      reason: reason.slice(0, 255),
    };
  });
  const [rows] = await pool.query(`${RECORD_SELECT} WHERE ar.id=? AND ar.organization_id=?`, [
    attendanceId,
    req.scopeOrgId,
  ]);
  logAudit({
    ...getActorFromReq(req),
    action: "attendance.correct",
    entityType: "attendance_record",
    entityId: uuid,
    details: auditDetails,
    req,
  });
  return ok(res, { record: serializeAttendanceDate(rows[0]) }, "Attendance corrected");
}

// ---------------------------------------------------------------------------
// Allowed IP list management (org-admin scoped, or admin by organization_uuid)
// ---------------------------------------------------------------------------

export async function getAllowedIps(req, res) {
  const orgId = await resolveScopeOrgId(req);
  const [rules] = await pool.query(
    "SELECT id, ip_address, rule_type FROM organization_ip_rules WHERE organization_id=? ORDER BY id ASC",
    [orgId]
  );
  const allowedIps = rules.filter((r) => r.rule_type === "allow").map((r) => r.ip_address);
  return ok(res, { allowedIps, rules }, "Allowed IP addresses");
}

export async function addAllowedIp(req, res) {
  const orgId = await resolveScopeOrgId(req);
  const value = req.body.ip !== undefined ? String(req.body.ip).trim() : "";
  if (!value) throw new ApiError(400, "ip is required");
  if (!isValidIpRule(value)) {
    throw new ApiError(400, "Invalid IP — use an exact address, CIDR range (e.g. 192.168.1.0/24), or IPv4 wildcard (e.g. 192.168.1.*)");
  }

  const [dup] = await pool.query(
    "SELECT id FROM organization_ip_rules WHERE organization_id=? AND ip_address=?",
    [orgId, value]
  );
  if (dup.length) throw new ApiError(409, "This IP is already allowed");

  await pool.query(
    "INSERT INTO organization_ip_rules (organization_id, ip_address, rule_type) VALUES (?, ?, 'allow')",
    [orgId, value]
  );

  logAudit({
    ...getActorFromReq(req),
    action: "attendance.ip_add",
    entityType: "organization",
    entityId: String(orgId),
    details: { ip: value },
    req,
  });

  const [rules] = await pool.query(
    "SELECT id, ip_address, rule_type FROM organization_ip_rules WHERE organization_id=? ORDER BY id ASC",
    [orgId]
  );
  return ok(res, { allowedIps: rules.filter((r) => r.rule_type === "allow").map((r) => r.ip_address), rules }, "IP added to allow-list");
}

export async function removeAllowedIp(req, res) {
  const orgId = await resolveScopeOrgId(req);
  const ruleId = Number(req.params.id);
  if (!Number.isInteger(ruleId) || ruleId <= 0) {
    throw new ApiError(400, "Valid IP rule id is required");
  }

  const [result] = await pool.query(
    "DELETE FROM organization_ip_rules WHERE id=? AND organization_id=?",
    [ruleId, orgId]
  );
  if (!result.affectedRows) throw new ApiError(404, "IP rule not found");

  logAudit({
    ...getActorFromReq(req),
    action: "attendance.ip_remove",
    entityType: "organization",
    entityId: String(orgId),
    details: { rule_id: ruleId },
    req,
  });

  const [rules] = await pool.query(
    "SELECT id, ip_address, rule_type FROM organization_ip_rules WHERE organization_id=? ORDER BY id ASC",
    [orgId]
  );
  return ok(res, { allowedIps: rules.filter((r) => r.rule_type === "allow").map((r) => r.ip_address), rules }, "IP removed from allow-list");
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

function buildRecordFilters(query) {
  const status = typeof query.status === "string" && query.status.trim()
    ? query.status.trim() : "";
  const search = typeof query.search === "string" ? query.search.trim() : "";
  const dateFrom = typeof query.dateFrom === "string" ? query.dateFrom.trim() : "";
  const dateTo = typeof query.dateTo === "string" ? query.dateTo.trim() : "";
  const employeeUuid = typeof query.employee_uuid === "string" ? query.employee_uuid.trim() : "";
  const department = typeof query.department === "string" ? query.department.trim() : "";
  const month = typeof query.month === "string" ? query.month.trim() : "";

  const clauses = [];
  const params = [];
  if (status && !["checked_in", "checked_out"].includes(status)) {
    throw new ApiError(400, "status must be checked_in or checked_out");
  }
  if (dateFrom && !validAttendanceDate(dateFrom)) throw new ApiError(400, "dateFrom must be YYYY-MM-DD");
  if (dateTo && !validAttendanceDate(dateTo)) throw new ApiError(400, "dateTo must be YYYY-MM-DD");
  if (dateFrom && dateTo && dateFrom > dateTo) throw new ApiError(400, "dateFrom must not be after dateTo");
  if (employeeUuid) {
    assertUuid(employeeUuid, "Employee UUID");
    clauses.push("ar.employee_uuid = ?");
    params.push(employeeUuid);
  }
  if (department) {
    clauses.push("EXISTS (SELECT 1 FROM departments dp WHERE dp.id=e.department_id AND dp.organization_id=e.organization_id AND dp.name=?)");
    params.push(department);
  }
  if (month) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new ApiError(400, "month must use YYYY-MM format");
    clauses.push("ar.date >= ? AND ar.date < DATE_ADD(?, INTERVAL 1 MONTH)");
    params.push(month + "-01", month + "-01");
  }
  // No date filter means today's attendance only. Explicit date ranges remain
  // available for monthly and custom-period reporting.
  if (!dateFrom && !dateTo && !month) {
    clauses.push("ar.date = ?");
    params.push(karachiDate());
  }
  if (status) {
    clauses.push("ar.status = ?");
    params.push(status);
  }
  if (search) {
    clauses.push("(e.full_name LIKE ? OR e.email LIKE ?)");
    const like = `%${search}%`;
    params.push(like, like);
  }
  if (dateFrom) {
    clauses.push("ar.date >= ?");
    params.push(dateFrom);
  }
  if (dateTo) {
    clauses.push("ar.date <= ?");
    params.push(dateTo);
  }
  return { status, search, dateFrom, dateTo, clauses, params };
}

export async function listOrgAttendance(req, res) {
  const orgId = req.scopeOrgId;
  const { page, limit, offset } = parsePagination(req.query);
  const f = buildRecordFilters(req.query);
  const scopeFilter = employeeScopeCondition(req, "attendance", "e");
  if (scopeFilter) {
    f.clauses.push(scopeFilter.sql);
    f.params.push(...scopeFilter.params);
  }

  const whereClause = `WHERE ar.organization_id = ?${f.clauses.length ? " AND " + f.clauses.join(" AND ") : ""}`;
  const params = [orgId, ...f.params];

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM attendance_records ar JOIN employees e ON e.uuid = ar.employee_uuid ${whereClause}`,
    params
  );
  const [rows] = await pool.query(
    `${RECORD_SELECT} ${whereClause} ORDER BY ar.date DESC, ar.check_in_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return ok(res, paginatedResponse(rows.map(serializeAttendanceDate), total, page, limit), "Attendance records");
}

export async function listMissingAttendance(req, res) {
  const month = typeof req.query.month === "string" ? req.query.month : "";
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new ApiError(400, "month must use YYYY-MM format");
  }
  const [year, monthNumber] = month.split("-").map(Number);
  const { page, limit, offset } = parsePagination(req.query);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const firstDate = `${month}-01`;
  const lastDate = `${month}-${String(lastDay).padStart(2, "0")}`;
  const [[{ total: scheduledDays }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM organization_monthly_work_schedules
      WHERE organization_id=? AND schedule_date BETWEEN ? AND ?`,
    [req.scopeOrgId, firstDate, lastDate],
  );
  if (Number(scheduledDays) !== lastDay) {
    throw new ApiError(
      409,
      `Monthly attendance schedule is incomplete for ${month}. Configure every date before reviewing missing attendance.`,
    );
  }

  const today = karachiDate();
  const [scheduleRows] = await pool.query(
    `SELECT DATE_FORMAT(schedule_date, '%Y-%m-%d') AS work_date
       FROM organization_monthly_work_schedules
      WHERE organization_id=? AND schedule_date BETWEEN ? AND ?
        AND day_type='working' AND schedule_date <= ?`,
    [req.scopeOrgId, firstDate, lastDate, today],
  );
  if (!scheduleRows.length) {
    return ok(res, paginatedResponse([], 0, page, limit), "Missing attendance");
  }
  const scheduleDates = scheduleRows.map((row) => row.work_date);
  const calendarQuery = `SELECT ? AS work_date${scheduleDates.slice(1).map(() => " UNION ALL SELECT ?").join("")}`;
  const calendarParams = [scheduleDates[0], ...scheduleDates.slice(1)];
  const missingScopeFilter = employeeScopeCondition(req, "attendance", "e");
  const baseQuery = `
    FROM (${calendarQuery}) calendar
    JOIN employees e
      ON e.organization_id=? AND e.status IN ('active','current_employee')
       AND (e.joining_date IS NULL OR e.joining_date <= calendar.work_date)
    LEFT JOIN attendance_records ar
      ON ar.employee_uuid=e.uuid AND ar.organization_id=e.organization_id
       AND ar.date=calendar.work_date
    WHERE ar.id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM holidays h
         WHERE h.organization_id=e.organization_id AND h.date=calendar.work_date
      )${missingScopeFilter ? ` AND ${missingScopeFilter.sql}` : ""}`;
  const commonParams = [...calendarParams, req.scopeOrgId, ...(missingScopeFilter?.params ?? [])];
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total ${baseQuery}`,
    commonParams,
  );
  const [rows] = await pool.query(
    `SELECT e.uuid AS employee_uuid, e.full_name AS employee_name, e.email AS employee_email,
            calendar.work_date AS date
       ${baseQuery}
      ORDER BY calendar.work_date DESC, e.full_name ASC
      LIMIT ? OFFSET ?`,
    [...commonParams, limit, offset],
  );
  return ok(
    res,
    paginatedResponse(rows.map((row) => ({ ...row, date: isoDate(row.date) })), total, page, limit),
    "Missing attendance",
  );
}