import ApiError from "../../utils/ApiError.js";
import { pool } from "../../config/db.js";
import { ok } from "../../utils/response.js";
import { assertUuid } from "../../utils/publicResponse.js";
import { logAudit, getActorFromReq } from "../../utils/auditLog.js";

/** Validate a year integer against a sane range. */
function parseYear(value) {
  const y = parseInt(value, 10);
  if (isNaN(y) || y < 2000 || y > 2100) {
    throw new ApiError(400, "A valid year is required");
  }
  return y;
}

/**
 * GET /org/leave-allocations?year=
 * Returns a per-employee x per-leave-type allocation grid for the given year
 * for the org-admin's own organization.
 */
export async function listLeaveAllocations(req, res) {
  const orgId = req.scopeOrgId;
  const year = req.query.year ? parseYear(req.query.year) : new Date().getFullYear();

  const [types] = await pool.query(
    "SELECT id, name FROM leave_types WHERE organization_id=? ORDER BY name",
    [orgId]
  );

  const [employees] = await pool.query(
    `SELECT e.uuid AS employee_uuid, e.full_name, e.email, dg.name AS designation, dp.name AS department, e.status
     FROM employees e
     LEFT JOIN designations dg ON dg.id = e.designation_id
     LEFT JOIN departments dp ON dp.id = e.department_id
     WHERE e.organization_id = ? AND e.status <> 'removed'
     ORDER BY e.full_name`,
    [orgId]
  );

  const [rows] = await pool.query(
    "SELECT employee_uuid, leave_type_id, allocated_days, used_days, remaining_days FROM employee_leave_allocations WHERE year=? AND employee_uuid IN (SELECT uuid FROM employees WHERE organization_id=?)",
    [year, orgId]
  );

  const map = new Map();
  for (const r of rows) {
    const key = r.employee_uuid;
    if (!map.has(key)) map.set(key, new Map());
    map.get(key).set(r.leave_type_id, {
      allocated_days: r.allocated_days,
      used_days: r.used_days,
      remaining_days: r.remaining_days,
    });
  }

  const employeeRows = employees.map((e) => ({
    employee_uuid: e.employee_uuid,
    full_name: e.full_name,
    email: e.email,
    designation: e.designation,
    department: e.department,
    status: e.status,
    allocations: types.map((t) => {
      const a = map.get(e.employee_uuid)?.get(t.id);
      return {
        leave_type_id: t.id,
        allocated_days: a ? a.allocated_days : 0,
        used_days: a ? a.used_days : 0,
        remaining_days: a ? a.remaining_days : 0,
      };
    }),
  }));

  return ok(res, { year, leaveTypes: types, employees: employeeRows }, "Leave allocations");
}

/**
 * PUT /org/leave-allocations
 * body: { employee_uuid, leave_type_id, year, allocated_days }
 * Upserts an individual employee's allocation for a type/year. `used_days`
 * history is preserved; `remaining_days` is kept consistent with the new cap.
 */
export async function setLeaveAllocation(req, res) {
  const orgId = req.scopeOrgId;
  const { employee_uuid, leave_type_id, year, allocated_days } = req.body || {};
  assertUuid(employee_uuid, "Employee UUID");
  const typeId = parseInt(leave_type_id, 10);
  const yr = parseYear(year);
  if (isNaN(typeId)) throw new ApiError(400, "leave_type_id is required");
  const alloc = parseInt(allocated_days, 10);
  if (isNaN(alloc) || alloc < 0) {
    throw new ApiError(400, "allocated_days must be a non-negative integer");
  }

  const [[emp]] = await pool.query(
    "SELECT uuid FROM employees WHERE uuid=? AND organization_id=?",
    [employee_uuid, orgId]
  );
  if (!emp) throw new ApiError(404, "Employee not found");

  const [[lt]] = await pool.query(
    "SELECT id, name FROM leave_types WHERE id=? AND organization_id=?",
    [typeId, orgId]
  );
  if (!lt) throw new ApiError(404, "Leave type not found");

  const [existing] = await pool.query(
    "SELECT id, used_days FROM employee_leave_allocations WHERE employee_uuid=? AND leave_type_id=? AND year=?",
    [employee_uuid, typeId, yr]
  );

  let row;
  if (existing.length) {
    const used = existing[0].used_days;
    const remaining = Math.max(0, alloc - used);
    await pool.query(
      "UPDATE employee_leave_allocations SET allocated_days=?, remaining_days=? WHERE id=?",
      [alloc, remaining, existing[0].id]
    );
    row = { id: existing[0].id, allocated_days: alloc, used_days: used, remaining_days: remaining };
  } else {
    const [ins] = await pool.query(
      `INSERT INTO employee_leave_allocations
         (uuid, employee_uuid, leave_type_id, year, allocated_days, used_days, remaining_days)
       VALUES (UUID(), ?, ?, ?, ?, 0, ?)`,
      [employee_uuid, typeId, yr, alloc, alloc]
    );
    row = { id: ins.insertId, allocated_days: alloc, used_days: 0, remaining_days: alloc };
  }

  logAudit({
    ...getActorFromReq(req),
    action: "leave_allocation.set",
    entityType: "employee_leave_allocation",
    entityId: String(row.id),
    details: { employee_uuid, leave_type_id: typeId, year: yr, allocated_days: alloc },
    req,
  });

  return ok(res, { allocation: row, leave_type_name: lt.name }, "Allocation saved");
}

/**
 * GET /org/employees/:uuid/leave-allocations
 * Returns an individual employee's allocation history across all years
 * (permanent history; nothing is reset). Org-admin only.
 */
export async function getEmployeeLeaveHistory(req, res) {
  const orgId = req.scopeOrgId;
  const { uuid } = req.params;
  assertUuid(uuid, "Employee UUID");

  const [[emp]] = await pool.query(
    "SELECT uuid, full_name, email FROM employees WHERE uuid=? AND organization_id=?",
    [uuid, orgId]
  );
  if (!emp) throw new ApiError(404, "Employee not found");

  const [rows] = await pool.query(
    `SELECT ela.year, ela.allocated_days, ela.used_days, ela.remaining_days,
            lt.id AS leave_type_id, lt.name AS leave_type_name
     FROM employee_leave_allocations ela
     JOIN leave_types lt ON lt.id = ela.leave_type_id
     WHERE ela.employee_uuid=?
     ORDER BY ela.year DESC, lt.name`,
    [uuid]
  );

  return ok(
    res,
    { employee_uuid: uuid, employee_name: emp.full_name, employee_email: emp.email, allocations: rows },
    "Employee leave allocation history"
  );
}
