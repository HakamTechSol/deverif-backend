import ApiError from "../../utils/ApiError.js";
import { pool } from "../../config/db.js";
import { ok } from "../../utils/response.js";
import { assertUuid } from "../../utils/publicResponse.js";
import { logAudit, getActorFromReq } from "../../utils/auditLog.js";

/**
 * Per-year, non-destructive salary history. One ACTIVE row (effective_to IS NULL)
 * per employee at any time. Increments close the active row (effective_to =
 * day-before the new effective_from) and insert a brand new row — the old
 * basic_salary is never overwritten.
 * Routes are org-admin only (mounted after requireOrgAdmin).
 */

function moneyFrom(value, label) {
  const n = Number(value);
  if (value === undefined || value === null || value === "") {
    throw new ApiError(400, `${label} is required`);
  }
  if (!Number.isFinite(n) || n < 0) {
    throw new ApiError(400, `${label} must be a non-negative number`);
  }
  return Math.round(n * 100) / 100;
}

function dateOnly(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ApiError(400, "effective_from must be a valid date (YYYY-MM-DD)");
  }
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new ApiError(400, "effective_from is not a valid date");
  return value;
}

/** Subtract one day from a YYYY-MM-DD string without timezone pitfalls. */
function dayBefore(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}

async function findEmployeeInScope(employeeUuid, orgId) {
  assertUuid(employeeUuid, "Employee UUID");
  const [rows] = await pool.query(
    "SELECT uuid, full_name FROM employees WHERE uuid=? AND organization_id=?",
    [employeeUuid, orgId]
  );
  if (!rows.length) throw new ApiError(404, "Employee not found in this organization");
  return rows[0];
}

// ---------------------------------------------------------------------------
// Historical view
// ---------------------------------------------------------------------------

export async function listEmployeeSalaryHistory(req, res) {
  const employee = await findEmployeeInScope(req.params.uuid, req.scopeOrgId);

  const [rows] = await pool.query(
    `SELECT uuid, year, basic_salary, effective_from, effective_to, created_at
     FROM employee_salary_history
     WHERE employee_uuid=?
     ORDER BY effective_from ASC`,
    [employee.uuid]
  );

  return ok(res, { history: rows }, "Employee salary history");
}

// ---------------------------------------------------------------------------
// Increment (closes the active period and opens a new one)
// ---------------------------------------------------------------------------

export async function incrementEmployeeSalary(req, res) {
  const employee = await findEmployeeInScope(req.params.uuid, req.scopeOrgId);
  const { new_basic_salary, effective_from } = req.body || {};

  const basic = moneyFrom(new_basic_salary, "new_basic_salary");
  const effectiveFrom = dateOnly(effective_from);
  const createdBy = req.user?.id ?? null;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [activeRows] = await conn.query(
      `SELECT id, effective_from, basic_salary
       FROM employee_salary_history
       WHERE employee_uuid=? AND effective_to IS NULL
       ORDER BY effective_from DESC
       LIMIT 1
       FOR UPDATE`,
      [employee.uuid]
    );

    if (activeRows.length) {
      const active = activeRows[0];
      const activeStart = active.effective_from instanceof Date
        ? active.effective_from.toISOString().slice(0, 10)
        : String(active.effective_from).slice(0, 10);

      if (effectiveFrom <= activeStart) {
        throw new ApiError(
          400,
          "The new effective date must be after the current salary's start date"
        );
      }

      await conn.query(
        "UPDATE employee_salary_history SET effective_to=? WHERE id=?",
        [dayBefore(effectiveFrom), active.id]
      );
    }

    const [result] = await conn.query(
      `INSERT INTO employee_salary_history
         (uuid, employee_uuid, year, basic_salary, effective_from, effective_to, created_by)
       VALUES (UUID(), ?, ?, ?, ?, NULL, ?)`,
      [employee.uuid, Number(effectiveFrom.slice(0, 4)), basic, effectiveFrom, createdBy]
    );

    const [[newRow]] = await conn.query(
      "SELECT uuid FROM employee_salary_history WHERE id=?",
      [result.insertId]
    );

    await conn.commit();

    const [history] = await conn.query(
      `SELECT uuid, year, basic_salary, effective_from, effective_to, created_at
       FROM employee_salary_history
       WHERE employee_uuid=?
       ORDER BY effective_from ASC`,
      [employee.uuid]
    );

    logAudit({
      ...getActorFromReq(req),
      action: "employee.salary_increment",
      entityType: "employee",
      entityId: employee.uuid,
      details: {
        new_basic_salary: basic,
        effective_from: effectiveFrom,
        history_row_uuid: newRow?.uuid ?? null,
      },
      req,
    });

    return ok(res, { history }, "Salary incremented — previous period preserved");
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

function asDateStr(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

async function fetchEmployeeHistory(conn, employeeUuid) {
  const [rows] = await conn.query(
    `SELECT uuid, year, basic_salary, effective_from, effective_to, created_at
     FROM employee_salary_history
     WHERE employee_uuid=?
     ORDER BY effective_from ASC`,
    [employeeUuid]
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Edit a salary history record (basic_salary and/or effective_from)
// ---------------------------------------------------------------------------

export async function updateEmployeeSalaryHistory(req, res) {
  const employee = await findEmployeeInScope(req.params.uuid, req.scopeOrgId);
  const { historyUuid } = req.params;
  assertUuid(historyUuid, "Salary history UUID");
  const { basic_salary, effective_from } = req.body || {};

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [targetRows] = await conn.query(
      `SELECT id, uuid, basic_salary, effective_from, effective_to
       FROM employee_salary_history
       WHERE uuid=? AND employee_uuid=? FOR UPDATE`,
      [historyUuid, employee.uuid]
    );
    if (!targetRows.length) throw new ApiError(404, "Salary history record not found");
    const target = targetRows[0];

    let newBasic = Number(target.basic_salary);
    if (basic_salary !== undefined && basic_salary !== null && basic_salary !== "") {
      newBasic = moneyFrom(basic_salary, "basic_salary");
    }

    let newEffFrom = asDateStr(target.effective_from);
    if (effective_from !== undefined && effective_from !== null && effective_from !== "") {
      newEffFrom = dateOnly(effective_from);
    }

    if (newBasic === Number(target.basic_salary) && newEffFrom === asDateStr(target.effective_from)) {
      throw new ApiError(400, "No changes to save");
    }

    const targetEff = asDateStr(target.effective_from);
    const [allRows] = await conn.query(
      `SELECT id, effective_from, effective_to
       FROM employee_salary_history
       WHERE employee_uuid=?
       ORDER BY effective_from ASC`,
      [employee.uuid]
    );

    let prev = null;
    let next = null;
    for (const r of allRows) {
      if (r.id === target.id) continue;
      const rf = asDateStr(r.effective_from);
      if (rf < targetEff) {
        prev = r;
      } else if (rf > targetEff && !next) {
        next = r;
      }
    }

    if (prev) {
      if (newEffFrom <= asDateStr(prev.effective_from)) {
        throw new ApiError(400, "Effective date must be after the previous salary period");
      }
    }
    if (next) {
      if (newEffFrom >= asDateStr(next.effective_from)) {
        throw new ApiError(400, "Effective date must be before the next salary period");
      }
    }

    await conn.query(
      "UPDATE employee_salary_history SET basic_salary=?, effective_from=? WHERE id=?",
      [newBasic, newEffFrom, target.id]
    );

    // If this is the active (open) row, keep the previous period adjacent.
    if (target.effective_to === null && prev) {
      await conn.query(
        "UPDATE employee_salary_history SET effective_to=? WHERE id=?",
        [dayBefore(newEffFrom), prev.id]
      );
    }

    await conn.commit();

    const history = await fetchEmployeeHistory(conn, employee.uuid);
    logAudit({
      ...getActorFromReq(req),
      action: "employee.salary_history_update",
      entityType: "employee",
      entityId: employee.uuid,
      details: { history_row_uuid: historyUuid, basic_salary: newBasic, effective_from: newEffFrom },
      req,
    });
    return ok(res, { history }, "Salary history updated");
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

// ---------------------------------------------------------------------------
// Delete a salary history record (the current active salary cannot be deleted)
// ---------------------------------------------------------------------------

export async function deleteEmployeeSalaryHistory(req, res) {
  const employee = await findEmployeeInScope(req.params.uuid, req.scopeOrgId);
  const { historyUuid } = req.params;
  assertUuid(historyUuid, "Salary history UUID");

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [targetRows] = await conn.query(
      `SELECT id, effective_from, effective_to
       FROM employee_salary_history
       WHERE uuid=? AND employee_uuid=? FOR UPDATE`,
      [historyUuid, employee.uuid]
    );
    if (!targetRows.length) throw new ApiError(404, "Salary history record not found");
    const target = targetRows[0];

    if (target.effective_to === null) {
      throw new ApiError(
        409,
        "Cannot delete the current active salary. Edit it or use Increment Salary instead."
      );
    }

    const targetEff = asDateStr(target.effective_from);
    const targetTo = asDateStr(target.effective_to);

    // Graft the previous closed period to cover the deleted one (keep days adjacent).
    const [prevRows] = await conn.query(
      `SELECT id, effective_from FROM employee_salary_history
       WHERE employee_uuid=? AND effective_to IS NOT NULL AND id <> ?
       ORDER BY effective_from ASC`,
      [employee.uuid, target.id]
    );
    let prev = null;
    for (const r of prevRows) {
      if (asDateStr(r.effective_from) < targetEff) prev = r;
    }
    if (prev) {
      await conn.query(
        "UPDATE employee_salary_history SET effective_to=? WHERE id=?",
        [targetTo, prev.id]
      );
    }

    await conn.query("DELETE FROM employee_salary_history WHERE id=?", [target.id]);
    await conn.commit();

    const history = await fetchEmployeeHistory(conn, employee.uuid);
    logAudit({
      ...getActorFromReq(req),
      action: "employee.salary_history_delete",
      entityType: "employee",
      entityId: employee.uuid,
      details: { history_row_uuid: historyUuid },
      req,
    });
    return ok(res, { history }, "Salary history record deleted");
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}