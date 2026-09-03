import ApiError from "../utils/ApiError.js";
import { pool } from "../config/db.js";
import { ok } from "../utils/response.js";
import { assertUuid } from "../utils/publicResponse.js";
import { parsePagination, paginatedResponse } from "../utils/pagination.js";
import { logAudit, getActorFromReq } from "../utils/auditLog.js";
import { generatePayslipPdf } from "../utils/payslipPdf.js";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Normalize a money field: finite number, >= 0, rounded to 2 decimals. */
function moneyField(value, label) {
  const n = Number(value);
  if (value === undefined || value === null || value === "") {
    return 0;
  }
  if (!Number.isFinite(n) || n < 0) {
    throw new ApiError(400, `${label} must be a non-negative number`);
  }
  return Math.round(n * 100) / 100;
}

function monthYearFields(month, year) {
  const m = parseInt(month, 10);
  if (isNaN(m) || m < 1 || m > 12) throw new ApiError(400, "month must be between 1 and 12");
  const y = parseInt(year, 10);
  if (isNaN(y) || y < 2000 || y > 2100) throw new ApiError(400, "year is invalid");
  return { m, y };
}

/** Verify an employee exists and belongs to the given organization. */
async function findEmployee(employeeUuid, orgId) {
  assertUuid(employeeUuid, "Employee UUID");
  const [rows] = await pool.query(
    "SELECT uuid, full_name, email, designation FROM employees WHERE uuid=? AND organization_id=?",
    [employeeUuid, orgId]
  );
  if (!rows.length) throw new ApiError(404, "Employee not found in this organization");
  return rows[0];
}

// ---------------------------------------------------------------------------
// Payroll generation (automatic, from salary history + components)
// ---------------------------------------------------------------------------

function monthRange(month, year) {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const last = new Date(Date.UTC(year, month, 0));
  return {
    firstDay: first.toISOString().slice(0, 10),
    lastDay: last.toISOString().slice(0, 10),
  };
}

// Pick the effective (numeric) basic salary for a given month by matching the
// month's last day against each period's [effective_from, effective_to] range.
async function effectiveBasicForMonth(employeeUuid, month, year) {
  const { lastDay } = monthRange(month, year);
  const [rows] = await pool.query(
    `SELECT basic_salary
     FROM employee_salary_history
     WHERE employee_uuid=?
       AND effective_from <= ?
       AND (effective_to IS NULL OR effective_to >= ?)
     ORDER BY effective_from DESC
     LIMIT 1`,
    [employeeUuid, lastDay, lastDay]
  );
  return rows.length ? rows[0].basic_salary : 0;
}

function computedNet(basic, allowancesTotal, deductionsTotal) {
  return Math.round((basic + allowancesTotal - deductionsTotal) * 100) / 100;
}

/**
 * Generate payroll for a whole month. For every employee (whether or not they
 * are a linked platform user) we look up their effective basic salary from
 * employee_salary_history and apply this org's salary_components â€” fixed
 * amounts and percentages â€” then store the totals in salary_records.
 * Net is computed automatically; it is never entered manually.
 */
export async function generatePayroll(req, res) {
  const orgId = req.scopeOrgId;
  const { month, year, employee_uuids, regenerate } = req.body || {};
  const { m, y } = monthYearFields(month, year);

  const conn = await pool.getConnection();
  let skipped = 0;
  try {
    await conn.beginTransaction();

    // Normalize an optional employee selection. When `employee_uuids` is
    // provided (individual or check-box selection), only those employees are
    // generated for. Otherwise ALL employees of the org are processed.
    // Sub_admins and the org_admin are users without employee records and
    // therefore are not part of payroll.
    const selected = Array.isArray(employee_uuids) ? employee_uuids.filter(Boolean) : [];
    let employees = [];

    if (selected.length) {
      const placeholders = selected.map(() => "?").join(",");
      [employees] = await conn.query(
        `SELECT uuid FROM employees WHERE organization_id=? AND uuid IN (${placeholders})`,
        [orgId, ...selected]
      );
      if (!employees.length) {
        throw new ApiError(404, "None of the selected employees exist in this organization");
      }
    } else {
      [employees] = await conn.query(
        "SELECT uuid FROM employees WHERE organization_id=?",
        [orgId]
      );
      if (!employees.length) throw new ApiError(404, "No employees in this organization to process");
    }

    // Regenerate mode: explicitly delete the existing records for exactly the
    // selected employees + period, then recreate them below. This is the
    // admin-curated "recompute" path and intentionally overwrites old values.
    if (regenerate === true) {
      if (!selected.length) {
        throw new ApiError(
          400,
          "Regenerate requires a specific employee selection so it never wipes the whole period"
        );
      }
      const placeholders = employees.map(() => "?").join(",");
      await conn.query(
        `DELETE FROM salary_records
         WHERE organization_id=? AND month=? AND year=? AND employee_uuid IN (${placeholders})`,
        [orgId, m, y, ...employees.map((e) => e.uuid)]
      );
      skipped = 0;
    } else if (selected.length) {
      // Fine-grained mode: skip any selected employee who already has a record
      // for this period, so individuals already generated are not duplicated
      // (you can top-up the remaining employees later).
      const existing = new Set();
      const placeholders = employees.map(() => "?").join(",");
      const [ex] = await conn.query(
        `SELECT employee_uuid FROM salary_records
         WHERE organization_id=? AND month=? AND year=? AND employee_uuid IN (${placeholders})`,
        [orgId, m, y, ...employees.map((e) => e.uuid)]
      );
      ex.forEach((r) => existing.add(r.employee_uuid));
      const before = employees.length;
      employees = employees.filter((e) => !existing.has(e.uuid));
      skipped = before - employees.length;
      if (!employees.length) {
        throw new ApiError(
          409,
          `Payroll for ${MONTHS[m - 1]} ${y} already exists for all selected employees \u2014 use "Regenerate" to recompute them`
        );
      }
    } else {
      // Full (all-employees) generation refuses to regenerate a period that
      // already has records. Regeneration for a whole period is intentionally
      // not allowed here; use Regenerate with a specific employee selection.
      const [existing] = await conn.query(
        "SELECT employee_uuid FROM salary_records WHERE organization_id=? AND month=? AND year=?",
        [orgId, m, y]
      );
      if (existing.length) {
        throw new ApiError(
          409,
          `Payroll for ${MONTHS[m - 1]} ${y} already exists for this organization \u2014 delete those records or regenerate per employee first`
        );
      }
    }

    const createdBy = req.user?.id ?? null;

    for (const emp of employees) {
      const basic = await effectiveBasicForMonth(emp.uuid, m, y);

      // Pull ONLY this employee's individually-assigned, active salary
      // components (from employee_salary_components, joined with the catalog
      // for type). We use the per-employee amount (esc.amount), NOT the
      // catalog's default_value, and never apply every active catalog
      // component to every employee. Inactive assignments are excluded so they
      // stop affecting future runs; already-generated records store computed
      // totals and are never retroactively changed.
      const [empComponents] = await conn.query(
        `SELECT sc.name, sc.type, sc.is_percentage, esc.amount
         FROM employee_salary_components esc
         JOIN salary_components sc ON sc.id = esc.salary_component_id
         WHERE esc.employee_uuid=? AND esc.is_active=1`,
        [emp.uuid]
      );

      let allowances = 0;
      let deductions = 0;
      for (const c of empComponents) {
        let amt = Number(c.amount);
        if (c.is_percentage) amt = basic * (amt / 100);
        amt = Math.round(amt * 100) / 100;
        if (c.type === "deduction") deductions += amt;
        else allowances += amt;
      }
      // Cap net at zero (deductions cannot exceed earnings).
      const net = Math.max(0, computedNet(basic, allowances, deductions));

      await conn.query(
        `INSERT INTO salary_records
           (uuid, employee_uuid, organization_id, month, year, basic_salary,
            allowances, deductions, net_salary, notes, created_by, created_at)
         VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [emp.uuid, orgId, m, y, basic, allowances, deductions, net, null, createdBy]
      );
    }

    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }

  const [rows] = await pool.query(
    `SELECT sr.*, e.full_name AS employee_name, e.email AS employee_email,
            e.designation, o.name AS organization_name
     FROM salary_records sr
     JOIN employees e ON e.uuid = sr.employee_uuid
     JOIN organizations o ON o.id = sr.organization_id
     WHERE sr.organization_id=? AND sr.month=? AND sr.year=?
     ORDER BY e.full_name`,
    [orgId, m, y]
  );

  logAudit({
    ...getActorFromReq(req),
    action: "payroll.generate",
    entityType: "payroll",
    entityId: `${y}-${String(m).padStart(2, "0")}`,
    details: { month: m, year: y, records: rows.length },
    req,
  });

  return ok(res, { items: rows, month: m, year: y, count: rows.length, skipped }, "Payroll generated from salary history and components");
}

// ---------------------------------------------------------------------------
// Delete an entire generated payroll period (regeneratable)
// ---------------------------------------------------------------------------

export async function deleteSalaryPeriod(req, res) {
  const orgId = req.scopeOrgId;
  const { m, y } = monthYearFields(req.params.month, req.params.year);

  const [result] = await pool.query(
    "DELETE FROM salary_records WHERE organization_id=? AND month=? AND year=?",
    [orgId, m, y]
  );

  logAudit({
    ...getActorFromReq(req),
    action: "payroll.delete_period",
    entityType: "payroll",
    entityId: `${y}-${String(m).padStart(2, "0")}`,
    details: { month: m, year: y, deleted: result.affectedRows },
    req,
  });

  return ok(res, { deleted: result.affectedRows }, "Payroll period deleted");
}

// ---------------------------------------------------------------------------
// Delete one generated payroll record without affecting other employees.
export async function deleteSalaryRecord(req, res) {
  const orgId = req.scopeOrgId;
  assertUuid(req.params.uuid, "Salary record UUID");

  const [result] = await pool.query(
    "DELETE FROM salary_records WHERE uuid=? AND organization_id=?",
    [req.params.uuid, orgId]
  );
  if (!result.affectedRows) throw new ApiError(404, "Salary record not found");

  logAudit({
    ...getActorFromReq(req),
    action: "payroll.delete_record",
    entityType: "salary_record",
    entityId: req.params.uuid,
    details: { deleted: result.affectedRows },
    req,
  });

  return ok(res, { deleted: result.affectedRows }, "Payroll record deleted");
}
// List
// ---------------------------------------------------------------------------

export async function listOrgSalaryRecords(req, res) {
  const orgId = req.scopeOrgId;
  const { page, limit, offset } = parsePagination(req.query);
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const employeeUuid = typeof req.query.employee_uuid === "string" && req.query.employee_uuid.trim()
    ? req.query.employee_uuid.trim() : "";
  const month = typeof req.query.month === "string" && req.query.month.trim() ? req.query.month.trim() : "";
  const year = typeof req.query.year === "string" && req.query.year.trim() ? req.query.year.trim() : "";

  let whereClause = "WHERE sr.organization_id = ?";
  const params = [orgId];

  if (employeeUuid) {
    assertUuid(employeeUuid, "Employee UUID");
    whereClause += " AND sr.employee_uuid = ?";
    params.push(employeeUuid);
  }
  const m = parseInt(month, 10);
  if (month && !isNaN(m) && m >= 1 && m <= 12) {
    whereClause += " AND sr.month = ?";
    params.push(m);
  }
  const y = parseInt(year, 10);
  if (year && !isNaN(y)) {
    whereClause += " AND sr.year = ?";
    params.push(y);
  }
  if (search) {
    whereClause += " AND (e.full_name LIKE ? OR e.email LIKE ?)";
    const like = `%${search}%`;
    params.push(like, like);
  }

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total
     FROM salary_records sr
     JOIN employees e ON e.uuid = sr.employee_uuid
     ${whereClause}`,
    params
  );
  const [rows] = await pool.query(
    `SELECT sr.uuid, sr.employee_uuid, sr.month, sr.year, sr.basic_salary,
            sr.allowances, sr.deductions, sr.net_salary, sr.notes, sr.created_at,
            e.full_name AS employee_name, e.email AS employee_email, e.designation,
            o.name AS organization_name
     FROM salary_records sr
     JOIN employees e ON e.uuid = sr.employee_uuid
     JOIN organizations o ON o.id = sr.organization_id
     ${whereClause}
     ORDER BY sr.year DESC, sr.month DESC, e.full_name
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return ok(res, paginatedResponse(rows, total, page, limit), "Salary records");
}

export async function listAllSalaryRecords(req, res) {
  const { page, limit, offset } = parsePagination(req.query);
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const orgUuid = typeof req.query.organization_uuid === "string" && req.query.organization_uuid.trim()
    ? req.query.organization_uuid.trim() : "";
  const employeeUuid = typeof req.query.employee_uuid === "string" && req.query.employee_uuid.trim()
    ? req.query.employee_uuid.trim() : "";
  const month = typeof req.query.month === "string" && req.query.month.trim() ? req.query.month.trim() : "";
  const year = typeof req.query.year === "string" && req.query.year.trim() ? req.query.year.trim() : "";

  let whereClause = "WHERE 1=1";
  const params = [];

  if (orgUuid) {
    assertUuid(orgUuid, "Organization UUID");
    whereClause += " AND o.uuid = ?";
    params.push(orgUuid);
  }
  if (employeeUuid) {
    assertUuid(employeeUuid, "Employee UUID");
    whereClause += " AND sr.employee_uuid = ?";
    params.push(employeeUuid);
  }
  const m = parseInt(month, 10);
  if (month && !isNaN(m) && m >= 1 && m <= 12) {
    whereClause += " AND sr.month = ?";
    params.push(m);
  }
  const y = parseInt(year, 10);
  if (year && !isNaN(y)) {
    whereClause += " AND sr.year = ?";
    params.push(y);
  }
  if (search) {
    whereClause += " AND (e.full_name LIKE ? OR e.email LIKE ?)";
    const like = `%${search}%`;
    params.push(like, like);
  }

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total
     FROM salary_records sr
     JOIN employees e ON e.uuid = sr.employee_uuid
     JOIN organizations o ON o.id = sr.organization_id
     ${whereClause}`,
    params
  );
  const [rows] = await pool.query(
    `SELECT sr.uuid, sr.employee_uuid, sr.month, sr.year, sr.basic_salary,
            sr.allowances, sr.deductions, sr.net_salary, sr.notes, sr.created_at,
            e.full_name AS employee_name, e.email AS employee_email, e.designation,
            o.uuid AS organization_uuid, o.name AS organization_name
     FROM salary_records sr
     JOIN employees e ON e.uuid = sr.employee_uuid
     JOIN organizations o ON o.id = sr.organization_id
     ${whereClause}
     ORDER BY sr.year DESC, sr.month DESC, e.full_name
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return ok(res, paginatedResponse(rows, total, page, limit), "Salary records");
}

// ---------------------------------------------------------------------------
// Payslip PDF
// ---------------------------------------------------------------------------

async function getSalaryRecordForPayslip(uuid, orgId, isAdmin) {
  assertUuid(uuid, "Salary record UUID");
  let whereClause;
  const params = [];
  if (isAdmin) {
    whereClause = "WHERE sr.uuid = ?";
    params.push(uuid);
  } else {
    whereClause = "WHERE sr.uuid = ? AND sr.organization_id = ?";
    params.push(uuid, orgId);
  }
  const [rows] = await pool.query(
    `SELECT sr.*, e.full_name AS employee_name,
            o.name AS organization_name
     FROM salary_records sr
     JOIN employees e ON e.uuid = sr.employee_uuid
     JOIN organizations o ON o.id = sr.organization_id
     ${whereClause}`,
    params
  );
  if (!rows.length) throw new ApiError(404, "Salary record not found");
  return rows[0];
}

export async function downloadPayslip(req, res) {
  const isAdmin = Boolean(req.admin);
  const orgId = isAdmin ? null : req.scopeOrgId;
  const record = await getSalaryRecordForPayslip(req.params.uuid, orgId, isAdmin);

  const pdf = await generatePayslipPdf({
    record,
    employeeName: record.employee_name,
    organizationName: record.organization_name,
  });

  const filename = `dvarif-payslip-${record.uuid.slice(0, 8)}.pdf`;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(pdf);
}

// ---------------------------------------------------------------------------
// CSV export (org-admin only)
// ---------------------------------------------------------------------------

function escapeCsvCell(value) {
  const s = String(value ?? "");
  return s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

export async function exportOrgSalaryRecords(req, res) {
  const orgId = req.scopeOrgId;
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const employeeUuid = typeof req.query.employee_uuid === "string" && req.query.employee_uuid.trim()
    ? req.query.employee_uuid.trim() : "";
  const month = typeof req.query.month === "string" && req.query.month.trim() ? req.query.month.trim() : "";
  const year = typeof req.query.year === "string" && req.query.year.trim() ? req.query.year.trim() : "";

  let whereClause = "WHERE sr.organization_id = ?";
  const params = [orgId];

  if (employeeUuid) {
    assertUuid(employeeUuid, "Employee UUID");
    whereClause += " AND sr.employee_uuid = ?";
    params.push(employeeUuid);
  }
  const m = parseInt(month, 10);
  if (month && !isNaN(m) && m >= 1 && m <= 12) {
    whereClause += " AND sr.month = ?";
    params.push(m);
  }
  const y = parseInt(year, 10);
  if (year && !isNaN(y)) {
    whereClause += " AND sr.year = ?";
    params.push(y);
  }
  if (search) {
    whereClause += " AND (e.full_name LIKE ? OR e.email LIKE ?)";
    const like = `%${search}%`;
    params.push(like, like);
  }

  const [rows] = await pool.query(
    `SELECT sr.employee_uuid, sr.month, sr.year, sr.basic_salary,
            sr.allowances, sr.deductions, sr.net_salary, sr.notes, sr.created_at,
            e.full_name AS employee_name, e.email AS employee_email, e.designation
     FROM salary_records sr
     JOIN employees e ON e.uuid = sr.employee_uuid
     ${whereClause}
     ORDER BY sr.year DESC, sr.month DESC, e.full_name`,
    params
  );

  const header = "Employee,Email,Designation,Month,Year,Basic Salary,Allowances,Deductions,Net Salary,Notes";
  const lines = rows.map((r) => [
    r.employee_name,
    r.employee_email,
    r.designation,
    MONTHS[r.month - 1] ?? r.month,
    r.year,
    r.basic_salary,
    r.allowances,
    r.deductions,
    r.net_salary,
    r.notes,
  ].map(escapeCsvCell).join(","));

  const csv = [header, ...lines].join("\r\n");
  const filename = `dvarif-payroll-${year || "all"}-${month ? MONTHS[m - 1] || "all" : "all"}.csv`;

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send("\uFEFF" + csv);
}

// ---------------------------------------------------------------------------
// Member self-service: own salary records only (no PDF download)
// ---------------------------------------------------------------------------

export async function mySalaryRecords(req, res) {
  const [empRows] = await pool.query(
    "SELECT uuid FROM employees WHERE linked_user_uuid=? AND is_platform_user='yes'",
    [req.user.uuid]
  );
  if (!empRows.length) return ok(res, paginatedResponse([], 0, 1, 10), "Salary records");

  const employeeUuid = empRows[0].uuid;
  const { page, limit, offset } = parsePagination(req.query);
  const month = typeof req.query.month === "string" && req.query.month.trim() ? req.query.month.trim() : "";
  const year = typeof req.query.year === "string" && req.query.year.trim() ? req.query.year.trim() : "";

  let whereClause = "WHERE sr.employee_uuid = ?";
  const params = [employeeUuid];

  const m = parseInt(month, 10);
  if (month && !isNaN(m) && m >= 1 && m <= 12) {
    whereClause += " AND sr.month = ?";
    params.push(m);
  }
  const y = parseInt(year, 10);
  if (year && !isNaN(y)) {
    whereClause += " AND sr.year = ?";
    params.push(y);
  }

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM salary_records sr ${whereClause}`,
    params
  );
  const [rows] = await pool.query(
    `SELECT sr.uuid, sr.employee_uuid, sr.month, sr.year, sr.basic_salary,
            sr.allowances, sr.deductions, sr.net_salary, sr.notes, sr.created_at,
            e.full_name AS employee_name, e.email AS employee_email, e.designation,
            o.name AS organization_name
     FROM salary_records sr
     JOIN employees e ON e.uuid = sr.employee_uuid
     JOIN organizations o ON o.id = sr.organization_id
     ${whereClause}
     ORDER BY sr.year DESC, sr.month DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return ok(res, paginatedResponse(rows, total, page, limit), "Salary records");
}
