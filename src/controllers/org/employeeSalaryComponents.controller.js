import ApiError from "../../utils/ApiError.js";
import { pool } from "../../config/db.js";
import { ok, created } from "../../utils/response.js";
import { assertUuid } from "../../utils/publicResponse.js";
import { logAudit, getActorFromReq } from "../../utils/auditLog.js";

/**
 * Per-employee allowance/deduction ASSIGNMENTS.
 *
 * salary_components is a reusable CATALOG of types ("Transport Allowance",
 * "Tax Deduction", ...). These endpoints assign a catalog component to a
 * single employee with that employee's OWN amount (which may differ from the
 * catalog's default_value). Payroll generation pulls ONLY these assigned rows
 * per employee — not a blanket application of every active catalog component.
 *
 * Routes are mounted after requireRole("org_admin","sub_admin") in org.routes.js
 * (staff). req.scopeOrgId is the acting org's id.
 */

const ASSIGNMENT_SELECT = `SELECT esc.id, esc.uuid, esc.employee_uuid, esc.salary_component_id,
       esc.amount, esc.is_active, esc.assigned_at,
       sc.name, sc.type, sc.is_percentage AS component_is_percentage,
       sc.default_value AS component_default_value
 FROM employee_salary_components esc
 JOIN salary_components sc ON sc.id = esc.salary_component_id`;

async function findEmployeeInScope(employeeUuid, orgId) {
  assertUuid(employeeUuid, "Employee UUID");
  const [rows] = await pool.query(
    "SELECT uuid, full_name FROM employees WHERE uuid=? AND organization_id=?",
    [employeeUuid, orgId]
  );
  if (!rows.length) throw new ApiError(404, "Employee not found in this organization");
  return rows[0];
}

async function findComponentInScope(componentId, orgId) {
  const [rows] = await pool.query(
    `SELECT id, uuid, name, type, is_percentage, default_value
     FROM salary_components WHERE id=? AND organization_id=?`,
    [componentId, orgId]
  );
  if (!rows.length) throw new ApiError(404, "Salary component not found in this organization");
  return rows[0];
}

/** Normalize a money amount: finite number, >= 0, rounded to 2 decimals. */
function amountFrom(value, label = "amount") {
  const n = Number(value);
  if (value === undefined || value === null || value === "") {
    throw new ApiError(400, `${label} is required`);
  }
  if (!Number.isFinite(n) || n < 0) {
    throw new ApiError(400, `${label} must be a non-negative number`);
  }
  return Math.round(n * 100) / 100;
}

async function fetchAssignments(employeeUuid) {
  const [rows] = await pool.query(
    `${ASSIGNMENT_SELECT} WHERE esc.employee_uuid=? ORDER BY sc.type, sc.name`,
    [employeeUuid]
  );
  return rows;
}

// ---------------------------------------------------------------------------
// List this employee's assigned components
// ---------------------------------------------------------------------------

export async function listEmployeeSalaryComponents(req, res) {
  const employee = await findEmployeeInScope(req.params.uuid, req.scopeOrgId);
  const assignments = await fetchAssignments(employee.uuid);
  return ok(res, { assignments }, "Employee salary components");
}

// ---------------------------------------------------------------------------
// Assign a catalog component to this employee with a specific amount
// ---------------------------------------------------------------------------

export async function assignEmployeeSalaryComponent(req, res) {
  const employee = await findEmployeeInScope(req.params.uuid, req.scopeOrgId);
  const { salary_component_id, amount } = req.body || {};

  const componentId = Number(salary_component_id);
  if (!Number.isInteger(componentId) || componentId <= 0) {
    throw new ApiError(400, "salary_component_id is required");
  }
  const component = await findComponentInScope(componentId, req.scopeOrgId);
  const amt = amountFrom(amount);
  const assignedBy = req.user?.id ?? null;

  try {
    await pool.query(
      `INSERT INTO employee_salary_components
         (uuid, employee_uuid, salary_component_id, amount, is_active, assigned_by)
       VALUES (UUID(), ?, ?, ?, 1, ?)`,
      [employee.uuid, component.id, amt, assignedBy]
    );
  } catch (e) {
    if (String(e.message).includes("Duplicate")) {
      throw new ApiError(
        409,
        `"${component.name}" is already assigned to this employee. Edit its amount or remove it first.`
      );
    }
    throw e;
  }

  const assignments = await fetchAssignments(employee.uuid);
  logAudit({
    ...getActorFromReq(req),
    action: "employee_salary_component.assign",
    entityType: "employee",
    entityId: employee.uuid,
    details: { salary_component_id: component.id, name: component.name, amount: amt },
    req,
  });
  return created(res, { assignments }, `"${component.name}" assigned to ${employee.full_name}`);
}

// ---------------------------------------------------------------------------
// Update an assignment (amount / active state)
// ---------------------------------------------------------------------------

export async function updateEmployeeSalaryComponent(req, res) {
  const employee = await findEmployeeInScope(req.params.uuid, req.scopeOrgId);
  const { assignUuid } = req.params;
  assertUuid(assignUuid, "Assignment UUID");

  const [rows] = await pool.query(
    `SELECT esc.id, esc.salary_component_id, esc.amount, esc.is_active,
            sc.name, sc.type
     FROM employee_salary_components esc
     JOIN salary_components sc ON sc.id = esc.salary_component_id
     WHERE esc.uuid=? AND esc.employee_uuid=?`,
    [assignUuid, employee.uuid]
  );
  if (!rows.length) throw new ApiError(404, "Salary component assignment not found");
  const existing = rows[0];

  const { amount, is_active } = req.body || {};
  const updates = [];
  const values = [];

  if (amount !== undefined && amount !== null && amount !== "") {
    updates.push("amount = ?");
    values.push(amountFrom(amount));
  }
  if (is_active === true || is_active === 1 || is_active === "1" || is_active === "true") {
    updates.push("is_active = 1");
  } else if (is_active === false || is_active === 0 || is_active === "0" || is_active === "false") {
    updates.push("is_active = 0");
  }

  if (updates.length === 0) throw new ApiError(400, "At least one field is required to update");
  values.push(assignUuid);
  await pool.query(
    `UPDATE employee_salary_components SET ${updates.join(", ")} WHERE uuid=? AND employee_uuid=?`,
    [...values, employee.uuid]
  );

  const assignments = await fetchAssignments(employee.uuid);
  logAudit({
    ...getActorFromReq(req),
    action: "employee_salary_component.update",
    entityType: "employee",
    entityId: employee.uuid,
    details: { assignment_uuid: assignUuid, name: existing.name, amount: amountFrom(amount ?? existing.amount) },
    req,
  });
  return ok(res, { assignments }, `"${existing.name}" updated`);
}

// ---------------------------------------------------------------------------
// Remove an assignment
// ---------------------------------------------------------------------------

export async function removeEmployeeSalaryComponent(req, res) {
  const employee = await findEmployeeInScope(req.params.uuid, req.scopeOrgId);
  const { assignUuid } = req.params;
  assertUuid(assignUuid, "Assignment UUID");

  const [rows] = await pool.query(
    `SELECT esc.id, sc.name
     FROM employee_salary_components esc
     JOIN salary_components sc ON sc.id = esc.salary_component_id
     WHERE esc.uuid=? AND esc.employee_uuid=?`,
    [assignUuid, employee.uuid]
  );
  if (!rows.length) throw new ApiError(404, "Salary component assignment not found");

  await pool.query(
    "DELETE FROM employee_salary_components WHERE uuid=? AND employee_uuid=?",
    [assignUuid, employee.uuid]
  );

  const assignments = await fetchAssignments(employee.uuid);
  logAudit({
    ...getActorFromReq(req),
    action: "employee_salary_component.remove",
    entityType: "employee",
    entityId: employee.uuid,
    details: { assignment_uuid: assignUuid, name: rows[0].name },
    req,
  });
  return ok(res, { assignments }, `"${rows[0].name}" removed`);
}
