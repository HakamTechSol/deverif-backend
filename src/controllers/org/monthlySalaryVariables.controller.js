import ApiError from "../../utils/ApiError.js";
import { pool } from "../../config/db.js";
import { ok, created } from "../../utils/response.js";
import { assertUuid } from "../../utils/publicResponse.js";
import { logAudit, getActorFromReq } from "../../utils/auditLog.js";

function periodFields(month, year) {
  const m = Number(month);
  const y = Number(year);
  if (!Number.isInteger(m) || m < 1 || m > 12) throw new ApiError(400, "month must be between 1 and 12");
  if (!Number.isInteger(y) || y < 2000 || y > 2100) throw new ApiError(400, "year is invalid");
  return { month: m, year: y };
}

async function employeeInOrg(uuid, orgId) {
  assertUuid(uuid, "Employee UUID");
  const [rows] = await pool.query(
    "SELECT uuid, full_name FROM employees WHERE uuid=? AND organization_id=?",
    [uuid, orgId],
  );
  if (!rows.length) throw new ApiError(404, "Employee not found in this organization");
  return rows[0];
}

export async function listMonthlySalaryVariables(req, res) {
  const employee = await employeeInOrg(req.params.uuid, req.scopeOrgId);
  const { month, year } = periodFields(req.query.month, req.query.year);
  const [items] = await pool.query(
    `SELECT uuid, label, type, amount, month, year, created_at
       FROM monthly_salary_variables
      WHERE organization_id=? AND employee_uuid=? AND month=? AND year=?
      ORDER BY created_at, id`,
    [req.scopeOrgId, employee.uuid, month, year],
  );
  return ok(res, { items }, "Monthly variable salary components");
}

export async function createMonthlySalaryVariable(req, res) {
  const employee = await employeeInOrg(req.params.uuid, req.scopeOrgId);
  const { label, type, amount } = req.body || {};
  const { month, year } = periodFields(req.body?.month, req.body?.year);
  const name = typeof label === "string" ? label.trim() : "";
  if (!name || name.length > 150) throw new ApiError(400, "Component name is required (maximum 150 characters)");
  if (!["allowance", "deduction"].includes(type)) throw new ApiError(400, "type must be allowance or deduction");
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) throw new ApiError(400, "amount must be greater than zero");
  const rounded = Math.round(value * 100) / 100;
  const [result] = await pool.query(
    `INSERT INTO monthly_salary_variables
       (uuid, organization_id, employee_uuid, label, type, amount, month, year, created_by)
     VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, ?)`,
    [req.scopeOrgId, employee.uuid, name, type, rounded, month, year, req.user?.id ?? null],
  );
  const [rows] = await pool.query(
    "SELECT uuid, label, type, amount, month, year, created_at FROM monthly_salary_variables WHERE id=?",
    [result.insertId],
  );
  logAudit({
    ...getActorFromReq(req),
    action: "payroll.monthly_variable.create",
    entityType: "employee",
    entityId: employee.uuid,
    details: { label: name, type, amount: rounded, month, year },
    req,
  });
  return created(res, { item: rows[0] }, "Monthly salary component added");
}

export async function updateMonthlySalaryVariable(req, res) {
  const employee = await employeeInOrg(req.params.uuid, req.scopeOrgId);
  assertUuid(req.params.variableUuid, "Monthly component UUID");
  const [existingRows] = await pool.query(
    `SELECT uuid, label, type, amount, month, year
       FROM monthly_salary_variables
      WHERE uuid=? AND organization_id=? AND employee_uuid=?`,
    [req.params.variableUuid, req.scopeOrgId, employee.uuid],
  );
  if (!existingRows.length) throw new ApiError(404, "Monthly salary component not found");

  const existing = existingRows[0];
  const body = req.body || {};
  const label = body.label === undefined ? existing.label : String(body.label).trim();
  const type = body.type === undefined ? existing.type : body.type;
  const amount = body.amount === undefined ? Number(existing.amount) : Number(body.amount);
  const { month, year } = periodFields(body.month ?? existing.month, body.year ?? existing.year);

  if (!label || label.length > 150) throw new ApiError(400, "Component name is required (maximum 150 characters)");
  if (!["allowance", "deduction"].includes(type)) throw new ApiError(400, "type must be allowance or deduction");
  if (!Number.isFinite(amount) || amount <= 0) throw new ApiError(400, "amount must be greater than zero");
  const rounded = Math.round(amount * 100) / 100;

  await pool.query(
    `UPDATE monthly_salary_variables
        SET label=?, type=?, amount=?, month=?, year=?
      WHERE uuid=? AND organization_id=? AND employee_uuid=?`,
    [label, type, rounded, month, year, req.params.variableUuid, req.scopeOrgId, employee.uuid],
  );
  const [rows] = await pool.query(
    "SELECT uuid, label, type, amount, month, year, created_at FROM monthly_salary_variables WHERE uuid=? AND organization_id=? AND employee_uuid=?",
    [req.params.variableUuid, req.scopeOrgId, employee.uuid],
  );
  logAudit({
    ...getActorFromReq(req),
    action: "payroll.monthly_variable.update",
    entityType: "employee",
    entityId: employee.uuid,
    details: {
      variable_uuid: req.params.variableUuid,
      before: { label: existing.label, type: existing.type, amount: Number(existing.amount), month: existing.month, year: existing.year },
      after: { label, type, amount: rounded, month, year },
    },
    req,
  });
  return ok(res, { item: rows[0] }, "Monthly salary component updated");
}

export async function deleteMonthlySalaryVariable(req, res) {
  const employee = await employeeInOrg(req.params.uuid, req.scopeOrgId);
  assertUuid(req.params.variableUuid, "Monthly component UUID");
  const [result] = await pool.query(
    `DELETE FROM monthly_salary_variables
      WHERE uuid=? AND organization_id=? AND employee_uuid=?`,
    [req.params.variableUuid, req.scopeOrgId, employee.uuid],
  );
  if (!result.affectedRows) throw new ApiError(404, "Monthly salary component not found");
  logAudit({
    ...getActorFromReq(req),
    action: "payroll.monthly_variable.delete",
    entityType: "employee",
    entityId: employee.uuid,
    details: { variable_uuid: req.params.variableUuid },
    req,
  });
  return ok(res, { deleted: true }, "Monthly salary component removed");
}
