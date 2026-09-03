import ApiError from "../../utils/ApiError.js";
import { pool } from "../../config/db.js";
import { ok, created } from "../../utils/response.js";
import { assertUuid } from "../../utils/publicResponse.js";
import { logAudit, getActorFromReq } from "../../utils/auditLog.js";

/**
 * Org-admin defined, REUSABLE allowance/deduction TYPES (a catalog).
 * They are no longer applied automatically to every employee — instead they
 * are individually assigned to specific employees (with per-employee amounts)
 * via the employee_salary_components endpoints (see
 * employeeSalaryComponents.controller.js). Payroll generation pulls only those
 * per-employee assigned components.
 * All routes are protected by requireOrgAdmin, so only the primary org-admin
 * can define them. req.scopeOrgId is the acting org_admin's organization id.
 */

const COMPONENT_SELECT = `SELECT id, uuid, organization_id, name, type,
        is_percentage, default_value, is_active, created_at
 FROM salary_components`;

function normalizeComponent(body, { requireType = true } = {}) {
  const { name, type, is_percentage, default_value, is_active } = body || {};

  if (name === undefined || String(name).trim() === "") {
    throw new ApiError(400, "name is required");
  }
  if (requireType && type !== "allowance" && type !== "deduction") {
    throw new ApiError(400, "type must be 'allowance' or 'deduction'");
  }

  let value = Number(default_value);
  if (default_value === undefined || default_value === null || default_value === "") value = 0;
  if (!Number.isFinite(value) || value < 0) {
    throw new ApiError(400, "default_value must be a non-negative number");
  }

  const normalized = {
    name: String(name).trim(),
    type,
    is_percentage:
      is_percentage === true || is_percentage === 1 || is_percentage === "1" || is_percentage === "true",
    default_value: Math.round(value * 100) / 100,
  };

  // is_active defaults to active (1) and is only set when explicitly provided.
  if (is_active === true || is_active === 1 || is_active === "1" || is_active === "true") {
    normalized.is_active = 1;
  } else if (is_active === false || is_active === 0 || is_active === "0" || is_active === "false") {
    normalized.is_active = 0;
  }

  return normalized;
}

async function findComponentInScope(uuid, orgId) {
  assertUuid(uuid, "Component UUID");
  const [rows] = await pool.query(
    `${COMPONENT_SELECT} WHERE uuid=? AND organization_id=?`,
    [uuid, orgId]
  );
  if (!rows.length) throw new ApiError(404, "Salary component not found");
  return rows[0];
}

export async function listSalaryComponents(req, res) {
  const type =
    typeof req.query.type === "string" &&
    (req.query.type === "allowance" || req.query.type === "deduction")
      ? req.query.type
      : "";

  const params = [req.scopeOrgId];
  let sql = `${COMPONENT_SELECT} WHERE organization_id=?`;
  if (type) {
    sql += " AND type=?";
    params.push(type);
  }
  sql += " ORDER BY is_percentage DESC, name ASC";

  const [rows] = await pool.query(sql, params);
  return ok(res, { items: rows }, "Salary components");
}

export async function createSalaryComponent(req, res) {
  const data = normalizeComponent(req.body);
  const createdBy = req.user?.id ?? null;

  let result;
  try {
    [result] = await pool.query(
      `INSERT INTO salary_components
         (uuid, organization_id, name, type, is_percentage, default_value, is_active, created_by)
       VALUES (UUID(), ?, ?, ?, ?, ?, COALESCE(?, 1), ?)`,
      [req.scopeOrgId, data.name, data.type, data.is_percentage, data.default_value, data.is_active, createdBy]
    );
  } catch (e) {
    if (String(e.message).includes("Duplicate")) {
      throw new ApiError(409, `A ${data.type} named "${data.name}" already exists`);
    }
    throw e;
  }

  const [[component]] = await pool.query(
    `${COMPONENT_SELECT} WHERE id=?`,
    [result.insertId]
  );

  logAudit({
    ...getActorFromReq(req),
    action: "salary_component.create",
    entityType: "salary_component",
    entityId: component.uuid,
    details: { name: component.name, type: component.type, is_percentage: component.is_percentage, default_value: component.default_value },
    req,
  });

  return created(res, { component }, "Salary component created");
}

export async function updateSalaryComponent(req, res) {
  const { uuid } = req.params;
  const existing = await findComponentInScope(uuid, req.scopeOrgId);
  const data = normalizeComponent(req.body, { requireType: false });

  const updateFields = [];
  const updateValues = [];
  for (const field of ["name", "is_percentage", "default_value", "is_active"]) {
    if (data[field] !== undefined) {
      updateFields.push(`${field} = ?`);
      updateValues.push(data[field]);
    }
  }
  if (updateFields.length === 0) throw new ApiError(400, "At least one field is required to update");
  updateValues.push(uuid);

  try {
    await pool.query(`UPDATE salary_components SET ${updateFields.join(", ")} WHERE uuid=?`, updateValues);
  } catch (e) {
    if (String(e.message).includes("Duplicate")) {
      throw new ApiError(409, `A ${existing.type} named "${data.name}" already exists`);
    }
    throw e;
  }

  const [updated] = await pool.query(`${COMPONENT_SELECT} WHERE uuid=?`, [uuid]);

  logAudit({
    ...getActorFromReq(req),
    action: "salary_component.update",
    entityType: "salary_component",
    entityId: uuid,
    details: { name: updated[0].name, type: updated[0].type, is_percentage: updated[0].is_percentage, default_value: updated[0].default_value },
    req,
  });

  return ok(res, { component: updated[0] }, "Salary component updated");
}

export async function deleteSalaryComponent(req, res) {
  const { uuid } = req.params;
  const existing = await findComponentInScope(uuid, req.scopeOrgId);

  await pool.query("DELETE FROM salary_components WHERE uuid=?", [uuid]);

  logAudit({
    ...getActorFromReq(req),
    action: "salary_component.delete",
    entityType: "salary_component",
    entityId: uuid,
    details: { name: existing.name, type: existing.type },
    req,
  });

  return ok(res, {}, "Salary component deleted");
}

/**
 * Toggle a component's Active/Inactive status. Deactivating a component stops
 * it from being applied to FUTURE payroll generations; already-generated
 * payroll records are stored as computed totals and are never retroactively
 * changed.
 */
export async function toggleSalaryComponentStatus(req, res) {
  const { uuid } = req.params;
  const existing = await findComponentInScope(uuid, req.scopeOrgId);

  const nextActive = existing.is_active ? 0 : 1;
  await pool.query("UPDATE salary_components SET is_active=? WHERE uuid=?", [nextActive, uuid]);

  const [updated] = await pool.query(`${COMPONENT_SELECT} WHERE uuid=?`, [uuid]);

  logAudit({
    ...getActorFromReq(req),
    action: "salary_component.status_toggle",
    entityType: "salary_component",
    entityId: uuid,
    details: { name: updated[0].name, type: updated[0].type, is_active: nextActive },
    req,
  });

  return ok(res, { component: updated[0] }, nextActive ? "Salary component activated" : "Salary component deactivated");
}