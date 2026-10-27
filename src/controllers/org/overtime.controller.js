import ApiError from "../../utils/ApiError.js";
import { pool } from "../../config/db.js";
import { ok, created } from "../../utils/response.js";
import { assertUuid } from "../../utils/publicResponse.js";
import { parsePagination, paginatedResponse } from "../../utils/pagination.js";
import { logAudit, getActorFromReq } from "../../utils/auditLog.js";

/**
 * Overtime requests and their approval.
 *
 * Modelled on leave_requests because it is the same shape of problem: someone
 * asks, somebody decides, payroll reads the decided answer. It exists at all
 * because payroll needs APPROVED overtime hours and the schema had nowhere to
 * put them — `overtime` appeared nowhere in the codebase before this, and
 * attendance_records has no hours column, only check-in and check-out timestamps.
 *
 * The requested/approved split is the whole point. Payroll may only ever pay
 * `approved_hours`; a single column would make the amount management allowed and
 * the amount claimed indistinguishable, and unapproved hours would quietly become
 * pay.
 */

const MAX_HOURS_PER_DAY = 24;

function hoursField(value, label) {
  if (value === undefined || value === null || value === "") return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new ApiError(400, `${label} must be a non-negative number`);
  // Two decimals, matching DECIMAL(5,2). Rounded here rather than trusted from
  // the client, because a payroll input that silently truncates is worse than one
  // that is rejected.
  return Math.round(n * 100) / 100;
}

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ""))) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime());
}

/** The employee must exist AND belong to the caller's org. */
async function employeeInOrg(orgId, employeeUuid) {
  assertUuid(employeeUuid, "Employee UUID");
  const [rows] = await pool.query(
    "SELECT uuid, full_name FROM employees WHERE uuid=? AND organization_id=?",
    [employeeUuid, orgId]
  );
  if (!rows.length) throw new ApiError(404, "Employee not found in this organization");
  return rows[0];
}

export async function createOvertimeRequest(req, res) {
  const orgId = req.scopeOrgId ?? req.user?.organization;
  const { employee_uuid, work_date, requested_hours, reason } = req.body || {};
  const employee = await employeeInOrg(orgId, employee_uuid);

  if (!isValidDate(work_date)) throw new ApiError(400, "work_date must be a valid YYYY-MM-DD date");
  const hours = hoursField(requested_hours, "requested_hours");
  if (hours <= 0) throw new ApiError(400, "requested_hours must be greater than zero");
  // Capped rather than merely validated: 30 "hours" in one day is not overtime,
  // it is a typo, and it would flow straight into the payslip.
  if (hours > MAX_HOURS_PER_DAY) {
    throw new ApiError(400, `requested_hours cannot exceed ${MAX_HOURS_PER_DAY} for a single day`);
  }

  let result;
  try {
    [result] = await pool.query(
      `INSERT INTO overtime_requests
         (uuid, employee_uuid, organization_id, work_date, requested_hours,
          approved_hours, reason, status, created_at, updated_at)
       VALUES (UUID(), ?, ?, ?, ?, 0, ?, 'pending', NOW(), NOW())`,
      [employee.uuid, orgId, work_date, hours, reason ? String(reason).trim() : null]
    );
  } catch (e) {
    if (e.code === "ER_DUP_ENTRY") {
      // One request per employee per day, enforced by a unique key. Two rows for
      // the same day would either double-pay or silently arbitrate, and neither
      // is knowable after the fact.
      throw new ApiError(409, "An overtime request already exists for this employee on that date");
    }
    throw e;
  }

  const [rows] = await pool.query(
    `SELECT uuid, employee_uuid, work_date, requested_hours, approved_hours, reason,
            status, decided_by, decided_at, decision_notes, created_at
       FROM overtime_requests WHERE id=?`,
    [result.insertId]
  );

  logAudit({
    ...getActorFromReq(req),
    action: "overtime.create",
    entityType: "overtime_request",
    entityId: rows[0].uuid,
    details: { employee_uuid: employee.uuid, work_date, requested_hours: hours },
    req,
  });

  return created(res, { overtimeRequest: rows[0] }, "Overtime request created");
}

export async function listOvertimeRequests(req, res) {
  const orgId = req.scopeOrgId ?? req.user?.organization;
  const { page, limit, offset } = parsePagination(req.query);

  const clauses = ["orq.organization_id = ?"];
  const params = [orgId];

  if (req.query.status) {
    const s = String(req.query.status);
    if (!["pending", "approved", "rejected"].includes(s)) {
      throw new ApiError(400, "status must be one of: pending, approved, rejected");
    }
    clauses.push("orq.status = ?");
    params.push(s);
  }
  if (req.query.employee_uuid) {
    await employeeInOrg(orgId, req.query.employee_uuid);
    clauses.push("orq.employee_uuid = ?");
    params.push(req.query.employee_uuid);
  }
  if (req.query.year) {
    const y = parseInt(req.query.year, 10);
    if (isNaN(y) || y < 2000 || y > 2100) throw new ApiError(400, "year is invalid");
    clauses.push("YEAR(orq.work_date) = ?");
    params.push(y);
  }

  const where = clauses.join(" AND ");

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM overtime_requests orq WHERE ${where}`,
    params
  );
  const [rows] = await pool.query(
    `SELECT orq.*, e.full_name AS employee_name, e.email AS employee_email,
            dg.name AS designation
       FROM overtime_requests orq
       JOIN employees e ON e.uuid = orq.employee_uuid
       LEFT JOIN designations dg ON dg.id = e.designation_id
      WHERE ${where}
      ORDER BY orq.work_date DESC, e.full_name
      LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  return ok(res, paginatedResponse(rows, total, page, limit), "Overtime requests");
}

export async function decideOvertimeRequest(req, res) {
  const orgId = req.scopeOrgId ?? req.user?.organization;
  const uuid = req.params.uuid;
  assertUuid(uuid, "Overtime request UUID");
  const { status, approved_hours, decision_notes } = req.body || {};

  if (!["approved", "rejected"].includes(status)) {
    throw new ApiError(400, "status must be either approved or rejected");
  }

  const [rows] = await pool.query(
    "SELECT uuid, employee_uuid, work_date, requested_hours, approved_hours, status FROM overtime_requests WHERE uuid=? AND organization_id=?",
    [uuid, orgId]
  );
  if (!rows.length) throw new ApiError(404, "Overtime request not found");
  const existing = rows[0];

  if (existing.status !== "pending") {
    // Deciding twice is how an approved claim quietly becomes a rejected one with
    // no record that it was ever approved, and payroll would follow the latest
    // write. The decision is terminal.
    throw new ApiError(409, `This request was already ${existing.status}`);
  }

  let finalApproved = 0;
  if (status === "approved") {
    finalApproved = hoursField(
      approved_hours === undefined || approved_hours === null || approved_hours === ""
        ? existing.requested_hours
        : approved_hours,
      "approved_hours"
    );
    if (finalApproved <= 0) throw new ApiError(400, "approved_hours must be greater than zero");
    // Approving more than was claimed would be paying for hours nobody attested to
    // working. Clamping rather than rejecting, because the common case is a typo
    // in the approval box and the approver still meant to approve the claim.
    const claimed = Number(existing.requested_hours);
    if (finalApproved > claimed) finalApproved = claimed;
  }

  await pool.query(
    `UPDATE overtime_requests
        SET status=?, approved_hours=?, decided_by=?, decided_at=NOW(), decision_notes=?
      WHERE uuid=? AND organization_id=?`,
    [
      status,
      finalApproved,
      req.user?.uuid ?? null,
      decision_notes ? String(decision_notes).trim() : null,
      uuid,
      orgId,
    ]
  );

  const [updated] = await pool.query(
    `SELECT uuid, employee_uuid, work_date, requested_hours, approved_hours, reason,
            status, decided_by, decided_at, decision_notes, created_at
       FROM overtime_requests WHERE uuid=?`,
    [uuid]
  );

  logAudit({
    ...getActorFromReq(req),
    action: "overtime.decide",
    entityType: "overtime_request",
    entityId: uuid,
    details: {
      status,
      requested_hours: Number(existing.requested_hours),
      approved_hours: finalApproved,
    },
    req,
  });

  return ok(res, { overtimeRequest: updated[0] }, `Overtime request ${status}`);
}