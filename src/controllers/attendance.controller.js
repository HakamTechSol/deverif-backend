import ApiError from "../utils/ApiError.js";
import { pool } from "../config/db.js";
import { ok, created } from "../utils/response.js";
import { assertUuid } from "../utils/publicResponse.js";
import { parsePagination, paginatedResponse } from "../utils/pagination.js";
import { logAudit, getActorFromReq } from "../utils/auditLog.js";
import { ipMatches, isValidIpRule } from "../utils/ipMatch.js";
import { normalizeIp } from "../utils/ip.js";
import ipaddr from "ipaddr.js";

const RECORD_SELECT = `
  SELECT ar.uuid, ar.employee_uuid, ar.organization_id, ar.check_in_at, ar.check_out_at,
         ar.check_in_ip, ar.check_out_ip, ar.date, ar.status, ar.is_manual,
         ar.manual_reason, ar.created_at,
         e.full_name AS employee_name, e.email AS employee_email, dg.name AS designation,
         o.uuid AS organization_uuid, o.name AS organization_name
  FROM attendance_records ar
  JOIN employees e ON e.uuid = ar.employee_uuid
  LEFT JOIN designations dg ON dg.id = e.designation_id
  JOIN organizations o ON o.id = ar.organization_id`;

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

  const [[{ total }]] = await pool.query(
    "SELECT COUNT(*) AS total FROM attendance_records WHERE employee_uuid=?",
    [employeeUuid]
  );
  const [rows] = await pool.query(
    `${RECORD_SELECT}
     WHERE ar.employee_uuid=?
     ORDER BY ar.date DESC, ar.check_in_at DESC LIMIT ? OFFSET ?`,
    [employeeUuid, limit, offset]
  );
  return ok(res, paginatedResponse(rows, total, page, limit), "Attendance records");
}

// ---------------------------------------------------------------------------
// Platform user: check-in / check-out / today
// ---------------------------------------------------------------------------

export async function checkIn(req, res) {
  assertSelfCheckInAllowed(req);
  const emp = await resolveEmployee(req);
  await assertAllowedIp(req, req.user.organization);

  const [[existing]] = await pool.query(
    "SELECT id, status FROM attendance_records WHERE employee_uuid=? AND date=CURDATE()",
    [emp.uuid]
  );
  if (existing) {
    throw new ApiError(
      409,
      existing.status === "checked_out" ? "Already checked out today" : "Already checked in today"
    );
  }

  // The (employee_uuid, date) unique key is the real guard against duplicate
  // check-ins from concurrent requests — map the violation to a friendly 409.
  let result;
  try {
    [result] = await pool.query(
      `INSERT INTO attendance_records
         (uuid, employee_uuid, organization_id, check_in_at, check_in_ip, date, status)
       VALUES (UUID(), ?, ?, NOW(), ?, CURDATE(), 'checked_in')`,
      [emp.uuid, req.user.organization, normalizeIp(req.ip)]
    );
  } catch (e) {
    if (e && (e.code === "ER_DUP_ENTRY" || String(e.message).includes("Duplicate"))) {
      throw new ApiError(409, "Already checked in today");
    }
    throw e;
  }
  const [rows] = await pool.query("SELECT * FROM attendance_records WHERE id=?", [result.insertId]);

  logAudit({
    ...getActorFromReq(req),
    action: "attendance.check_in",
    entityType: "attendance_record",
    entityId: rows[0].uuid,
    details: { ip: normalizeIp(req.ip) },
    req,
  });
  return created(res, { record: rows[0] }, "Checked in successfully");
}

export async function checkOut(req, res) {
  assertSelfCheckInAllowed(req);
  const emp = await resolveEmployee(req);
  await assertAllowedIp(req, req.user.organization);

  const [[existing]] = await pool.query(
    "SELECT * FROM attendance_records WHERE employee_uuid=? AND date=CURDATE()",
    [emp.uuid]
  );
  if (!existing) throw new ApiError(404, "You have not checked in today");
  if (existing.status === "checked_out") throw new ApiError(409, "Already checked out today");

  await pool.query(
    "UPDATE attendance_records SET status='checked_out', check_out_at=NOW(), check_out_ip=? WHERE id=?",
    [normalizeIp(req.ip), existing.id]
  );
  const [rows] = await pool.query("SELECT * FROM attendance_records WHERE id=?", [existing.id]);

  logAudit({
    ...getActorFromReq(req),
    action: "attendance.check_out",
    entityType: "attendance_record",
    entityId: rows[0].uuid,
    details: { ip: normalizeIp(req.ip) },
    req,
  });
  return ok(res, { record: rows[0] }, "Checked out successfully");
}

export async function todayStatus(req, res) {
  const emp = await resolveEmployee(req);
  const [rows] = await pool.query(
    `SELECT id, uuid, status, check_in_at, check_out_at, check_in_ip, check_out_ip, date
     FROM attendance_records WHERE employee_uuid=? AND date=CURDATE()`,
    [emp.uuid]
  );
  return ok(res, { record: rows[0] ?? null }, "Today's attendance");
}

// ---------------------------------------------------------------------------
// Org-admin: manual attendance entry on behalf of an employee
// ---------------------------------------------------------------------------

function isValidDateStr(v) {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
}

function isValidTimeStr(v) {
  return typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
}

export async function manualEntry(req, res) {
  const { employee_uuid, date, check_in_time, check_out_time } = req.body;
  const reason = typeof req.body.reason === "string" ? req.body.reason.trim() : "";

  assertUuid(employee_uuid, "Employee UUID");
  if (!isValidDateStr(date)) throw new ApiError(400, "date must be a valid YYYY-MM-DD value");
  if (!isValidTimeStr(check_in_time)) throw new ApiError(400, "check_in_time must be HH:MM (24h)");
  if (check_out_time !== undefined && check_out_time !== null && check_out_time !== "") {
    if (!isValidTimeStr(check_out_time)) throw new ApiError(400, "check_out_time must be HH:MM (24h)");
    if (check_out_time <= check_in_time) {
      throw new ApiError(400, "check_out_time must be after check_in_time");
    }
  }
  if (!reason) throw new ApiError(400, "reason is required for a manual attendance entry");

  // Backdate window — configurable via MANUAL_ATTENDANCE_MAX_AGE_DAYS (default 7).
  const maxAgeDays = Math.max(0, parseInt(process.env.MANUAL_ATTENDANCE_MAX_AGE_DAYS || "7", 10));
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const minDate = new Date(today.getTime() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (date > todayStr) throw new ApiError(400, "Manual entries cannot be for a future date");
  if (date < minDate) {
    throw new ApiError(
      400,
      `Manual entries can only be backdated up to ${maxAgeDays} day(s) (earliest allowed: ${minDate})`
    );
  }

  // Target employee must belong to the admin's organization and never be the admin themselves.
  const [empRows] = await pool.query(
    "SELECT uuid, organization_id, linked_user_uuid, full_name, status FROM employees WHERE uuid=?",
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
  if (emp.status !== "active") throw new ApiError(400, "Employee is inactive");

  const status = check_out_time ? "checked_out" : "checked_in";
  try {
    await pool.query(
      `INSERT INTO attendance_records
         (uuid, employee_uuid, organization_id, check_in_at, check_out_at, date, status,
          is_manual, manual_reason)
       VALUES (UUID(), ?, ?, ?, ?, ?, ?, 'yes', ?)`,
      [
        emp.uuid,
        req.scopeOrgId,
        `${date} ${check_in_time}:00`,
        check_out_time ? `${date} ${check_out_time}:00` : null,
        date,
        status,
        reason.slice(0, 255),
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
      check_out_time: check_out_time || null,
      reason: reason.slice(0, 255),
    },
    req,
  });

  return created(res, { record: rows[0] }, "Manual attendance entry added");
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

  const clauses = [];
  const params = [];
  if (["checked_in", "checked_out"].includes(status)) {
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
  return ok(res, paginatedResponse(rows, total, page, limit), "Attendance records");
}

export async function listAllAttendance(req, res) {
  const { page, limit, offset } = parsePagination(req.query);
  const f = buildRecordFilters(req.query);
  const orgUuid = typeof req.query.organization_uuid === "string" && req.query.organization_uuid.trim()
    ? req.query.organization_uuid.trim() : "";

  const clauses = [...f.clauses];
  const params = [...f.params];
  if (orgUuid) {
    assertUuid(orgUuid, "Organization UUID");
    clauses.push("o.uuid = ?");
    params.push(orgUuid);
  }
  const whereClause = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
  const whereJoin = whereClause ? " " + whereClause : "";

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM attendance_records ar JOIN employees e ON e.uuid = ar.employee_uuid JOIN organizations o ON o.id = ar.organization_id ${whereJoin}`,
    params
  );
  const [rows] = await pool.query(
    `${RECORD_SELECT}${whereJoin} ORDER BY ar.date DESC, ar.check_in_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return ok(res, paginatedResponse(rows, total, page, limit), "Attendance records");
}