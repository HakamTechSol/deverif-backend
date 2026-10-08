import ApiError from "../utils/ApiError.js";
import { pool } from "../config/db.js";
import { ok } from "../utils/response.js";
import { assertUuid } from "../utils/publicResponse.js";
import { parsePagination, paginatedResponse } from "../utils/pagination.js";
import { logAudit, getActorFromReq } from "../utils/auditLog.js";
import { generatePayslipPdf } from "../utils/payslipPdf.js";
import { randomUUID } from "node:crypto";
import * as payrollService from "../services/payroll.service.js";
const { computeAutomaticLines, getMonthlyAttendanceAndLeaveSummary, insertSalaryRecordLines } =
  payrollService;
import * as expenses from "../services/expenses.service.js";

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
    "SELECT uuid, full_name, email, dg.name AS designation FROM employees e LEFT JOIN designations dg ON dg.id = e.designation_id WHERE e.uuid=? AND e.organization_id=?",
    [employeeUuid, orgId]
  );
  if (!rows.length) throw new ApiError(404, "Employee not found in this organization");
  return rows[0];
}

// ---------------------------------------------------------------------------
// Payroll generation (automatic, from salary history + components)
// ---------------------------------------------------------------------------

/**
 * Everything about one employee for one month, with nothing written.
 *
 * Deliberately side-effect free and shared by generate and preview, because the
 * two MUST agree: a preview that computes a different number from the run it is
 * previewing is worse than no preview, since it moves the number people approve.
 * The previous code could not be reused this way because its component loop
 * collapsed straight into an INSERT.
 *
 * Lines are produced in two groups. `componentLines` are the org's configured
 * allowances and deductions; `autoLines` are the ones this module now derives
 * from leave and attendance. They are kept apart because they are
 * answerable-to differently: a component is "what we agreed", an automatic line
 * is "what actually happened", and an employee disputing a payslip needs to be
 * told which of the two they are looking at.
 */
async function computeEmployeePayroll({ employeeUuid, orgId, m, y, conn }) {
  const basic = await effectiveBasicForMonth(employeeUuid, m, y, conn);

  // Pull ONLY this employee's individually-assigned, active salary components.
  // We use the per-employee amount (esc.amount), NOT the catalog's default_value,
  // and never apply every active catalog component to every employee. Inactive
  // assignments are excluded so they stop affecting future runs; already-generated
  // records store computed totals and are never retroactively changed.
  const [empComponents] = await conn.query(
    `SELECT sc.name, sc.type, sc.is_percentage, esc.amount
     FROM employee_salary_components esc
     JOIN salary_components sc ON sc.id = esc.salary_component_id
     WHERE esc.employee_uuid=? AND esc.is_active=1`,
    [employeeUuid]
  );

  const componentLines = [];
  let allowances = 0;
  let deductions = 0;
  for (const c of empComponents) {
    let amt = Number(c.amount);
    if (c.is_percentage) amt = Number(basic) * (amt / 100);
    amt = moneyField(amt, c.name);
    componentLines.push({
      label: c.name,
      type: c.type === "deduction" ? "deduction" : "earning",
      source: "component",
      amount: amt,
      basis_value: null,
      basis_unit: null,
    });
    if (c.type === "deduction") deductions += amt;
    else allowances += amt;
  }

  const summary = await getMonthlyAttendanceAndLeaveSummary({
    employeeUuid,
    orgId,
    month: m,
    year: y,
    conn,
  });

  const automatic = computeAutomaticLines({ summary, basicSalary: basic });

  /**
   * Expense reimbursements for the month, as one payslip line.
   *
   * Read on the SAME connection as the writes, because "which claims are still
   * unpaid" is a question about the state payroll is about to change. Reading on
   * the pool and writing on a transaction is how a claim gets paid by a run that
   * then rolls back - and 'paid' is exactly the state that stops a claim being
   * picked up again, so a rolled-back run that marked them paid would lose the
   * reimbursement permanently.
   *
   * The claim list is returned as well, because the generate path has to mark
   * them paid in the same transaction. The preview path must NOT: it writes
   * nothing, so a preview must not consume anything.
   */
  const approvedClaims = await expenses.getApprovedClaimsForPeriod({
    orgId,
    employeeUuid,
    month: m,
    year: y,
    conn,
  });
  const expenseLine = expenses.expenseReimbursementLine(approvedClaims);

  const lines = [
    ...componentLines,
    ...automatic.lines,
    // Reimbursement is money COMING to the employee, so it is an earning alongside
    // allowances rather than a negative anywhere. Folding it into the deduction
    // side would hide it from a payslip that already nets off to zero.
    ...(expenseLine ? [expenseLine] : []),
  ];

  const totalAllowances = moneyField(allowances + automatic.totalAddition, "allowances");
  const totalDeductions = moneyField(deductions + automatic.totalDeduction, "deductions");

  // Cap net at zero (deductions cannot exceed earnings).
  const net = Math.max(0, computedNet(basic, totalAllowances, totalDeductions));

  return {
    basic,
    allowances: totalAllowances,
    deductions: totalDeductions,
    net,
    lines,
    summary,
    automatic,
    expenseLine,
    approvedClaims,
  };
}

/**
 * The employee's basic salary for the month, from the shared payroll service.
 *
 * Previously a local function. It now lives in payroll.service.js because the
 * Full & Final settlement needs the identical figure to price a day of unused
 * leave, and two copies of this rule is how FnF ends up quoting a daily rate
 * that disagrees with the payslip it accompanies.
 */
async function effectiveBasicForMonth(employeeUuid, month, year, conn = pool) {
  return payrollService.effectiveBasicForMonth({ employeeUuid, month, year, conn });
}

function computedNet(basicSalary, allowancesTotal, deductionsTotal) {
  // mysql2 returns DECIMAL columns as strings by default. Convert before
  // adding so JavaScript does not concatenate the basic and allowance values.
  const basic = Number(basicSalary);
  const allowances = Number(allowancesTotal);
  const deductions = Number(deductionsTotal);
  return Math.round((basic + allowances - deductions) * 100) / 100;
}

/**
 * Generate payroll for a whole month. For every employee (whether or not they
 * are a linked platform user) we look up their effective basic salary from
 * employee_salary_history and apply this org's salary_components —” fixed
 * amounts and percentages —” then store the totals in salary_records.
 * Net is computed automatically; it is never entered manually.
 */
export async function generatePayroll(req, res) {
  const orgId = req.scopeOrgId;
  const { month, year, employee_uuids, regenerate } = req.body || {};
  const { m, y } = monthYearFields(month, year);

  const conn = await pool.getConnection();
  let skipped = 0;
  // Declared outside the transaction block because it is reported after the commit.
  let claimsPaid = 0;
  /**
   * auto_expense lines lifted off the records Regenerate is about to delete, keyed
   * by employee. Populated inside the transaction and read back in the per-employee
   * loop; an empty map for an ordinary generate, because there is nothing to carry.
   */
  const carriedExpenses = new Map();
  /** salary_record uuids about to be deleted, so their claims can be re-pointed. */
  let carriedClaimPointers = [];
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

      /**
       * Preserve the reimbursements this period has already disbursed.
       *
       * salary_record_lines CASCADES from salary_records, so deleting the records
       * deletes the auto_expense lines with them. The claims, however, stay 'paid'
       * and keep pointing at a salary_record_uuid that no longer exists - so a
       * regenerated payslip silently loses every reimbursement, while the claim
       * list still says the employee was reimbursed. The employee is handed a
       * payslip that no longer accounts for money they received.
       *
       * The claims are NOT released back to 'approved' to fix this. That would
       * restore the line, but salary_records has no marker saying whether the
       * period was actually disbursed, so "recompute before payout" and "recompute
       * after the money went out" are indistinguishable - and un-consuming would
       * pay the same expense a second time in the second case. That is the one
       * failure this module must never have.
       *
       * So the lines are carried forward instead. A reimbursement is a disbursement
       * that already happened, not a value derived from attendance and salary
       * components, which is exactly what Regenerate exists to recompute. The claim
       * stays paid, and its paid_via pointer is re-pointed at the new record below
       * so the audit trail does not dangle.
       *
       * Read BEFORE the delete, because the cascade destroys the rows being read.
       */
      const [doomedRecords] = await conn.query(
        `SELECT uuid, employee_uuid FROM salary_records
          WHERE organization_id=? AND month=? AND year=? AND employee_uuid IN (${placeholders})`,
        [orgId, m, y, ...employees.map((e) => e.uuid)]
      );

      carriedExpenses.clear();
      if (doomedRecords.length) {
        const recordPlaceholders = doomedRecords.map(() => "?").join(",");
        const [oldLines] = await conn.query(
          `SELECT l.salary_record_uuid, r.employee_uuid, l.label, l.type, l.source,
                  l.amount, l.basis_value, l.basis_unit
             FROM salary_record_lines l
             JOIN salary_records r ON r.uuid = l.salary_record_uuid
            WHERE l.source='auto_expense' AND l.salary_record_uuid IN (${recordPlaceholders})`,
          doomedRecords.map((r) => r.uuid)
        );
        for (const line of oldLines) {
          if (!carriedExpenses.has(line.employee_uuid)) carriedExpenses.set(line.employee_uuid, []);
          carriedExpenses.get(line.employee_uuid).push(line);
        }

        // The claims each carried line disbursed, so they can be re-pointed at the
        // replacement record once it exists.
        carriedClaimPointers = doomedRecords.map((r) => r.uuid);
      }

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
      const computed = await computeEmployeePayroll({ employeeUuid: emp.uuid, orgId, m, y, conn });

      // Counted across the run so the response can say how many claims were
      // disbursed. Zero is the normal case and is worth stating explicitly,
      // because "no expense claims paid" is an answer to a question people ask.
      const paidForEmployee = computed.approvedClaims.length;
      claimsPaid += paidForEmployee;

      // The record's own uuid is generated here rather than by the table, because
      // salary_record_lines has to point at it and the two are written in the same
      // transaction. UUID() inside the INSERT would return the value to nobody.
      const recordUuid = randomUUID();

      await conn.query(
        `INSERT INTO salary_records
           (uuid, employee_uuid, organization_id, month, year, basic_salary,
            allowances, deductions, net_salary, notes, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [
          recordUuid,
          emp.uuid,
          orgId,
          m,
          y,
          computed.basic,
          computed.allowances,
          computed.deductions,
          computed.net,
          null,
          createdBy,
        ]
      );

      await insertSalaryRecordLines({
        conn,
        recordUuid,
        orgId,
        employeeUuid: emp.uuid,
        month: m,
        year: y,
        lines: computed.lines,
      });

      /**
       * Re-attach the reimbursements carried forward from the deleted record.
       *
       * Appended AFTER computed.lines so the carried disbursement is visible on the
       * payslip alongside anything newly computed - a claim approved since the last
       * run is picked up in the same regeneration, which is the whole point of
       * recomputing a period.
       *
       * Only the LINE is carried. No claim is re-consumed, because these claims are
       * already paid; re-consuming them would be a second disbursement.
       */
      const carried = carriedExpenses.get(emp.uuid) ?? [];
      if (carried.length) {
        await insertSalaryRecordLines({
          conn,
          recordUuid,
          orgId,
          employeeUuid: emp.uuid,
          month: m,
          year: y,
          lines: carried,
        });
      }

      /**
       * Consume the claims, in the SAME transaction as the salary record.
       *
       * The ordering matters. If this ran first and the payroll then failed, the
       * claims would be 'paid' for money nobody received - and 'paid' is precisely
       * the state that excludes them from the next run, so the reimbursement
       * would be lost silently and appear on no payslip.
       */
      if (computed.approvedClaims.length) {
        await expenses.markClaimsPaidByPayroll({
          conn,
          orgId,
          salaryRecordUuid: recordUuid,
          claims: computed.approvedClaims,
        });
      }

      /**
       * Re-point the carried claims at their replacement record.
       *
       * Left alone, paid_via_salary_record_uuid would name a row the regenerate just
       * deleted, and the audit trail for a real disbursement would dead-end on a
       * uuid that resolves to nothing.
       */
      if (carried.length && carriedClaimPointers.length) {
        await expenses.repointClaimsPaidByPayroll({
          conn,
          orgId,
          salaryRecordUuid: recordUuid,
          previousRecordUuids: carriedClaimPointers,
        });
      }
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
            dg.name AS designation, o.name AS organization_name
     FROM salary_records sr
     JOIN employees e ON e.uuid = sr.employee_uuid
     LEFT JOIN designations dg ON dg.id = e.designation_id
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
    details: {
      month: m,
      year: y,
      records: rows.length,
      // Named in the audit entry because money moving into a payroll is the thing
      // an auditor asks about later, and "the payroll ran" does not answer it.
      expense_claims_paid: claimsPaid,
    },
    req,
  });

  return ok(res, { items: rows, month: m, year: y, count: rows.length, skipped, expense_claims_paid: claimsPaid }, "Payroll generated from salary history, components, leave, attendance and expense claims");
}

// ---------------------------------------------------------------------------
// Preview: the same computation, written nowhere.
//
// Auto-computed deductions are the part of a payslip people contest, so the
// number has to be inspectable BEFORE it is committed — not discoverable a month
// later from a stored total. This runs the identical computeEmployeePayroll the
// generate path runs, on the same connection shape, so a preview and the run it
// precedes cannot disagree.
//
// It takes no transaction and writes nothing: no salary_records row, no
// salary_record_lines row, no audit entry. A GET that mutated payroll state would
// be a trap, and the endpoint is registered as POST only because the request body
// carries month/year/employee selection rather than a query string.
// ---------------------------------------------------------------------------

export async function previewPayroll(req, res) {
  const orgId = req.scopeOrgId;
  const { month, year, employee_uuids } = req.body || {};
  const { m, y } = monthYearFields(month, year);

  const selected = Array.isArray(employee_uuids) ? employee_uuids.filter(Boolean) : [];
  let employees;
  if (selected.length) {
    const placeholders = selected.map(() => "?").join(",");
    [employees] = await pool.query(
      `SELECT uuid, full_name FROM employees WHERE organization_id=? AND uuid IN (${placeholders})
        ORDER BY full_name`,
      [orgId, ...selected]
    );
    if (!employees.length) {
      throw new ApiError(404, "None of the selected employees exist in this organization");
    }
  } else {
    [employees] = await pool.query(
      `SELECT uuid, full_name FROM employees WHERE organization_id=? ORDER BY full_name`,
      [orgId]
    );
  }

  const items = [];
  for (const emp of employees) {
    const computed = await computeEmployeePayroll({ employeeUuid: emp.uuid, orgId, m, y, conn: pool });
    items.push({
      employee_uuid: emp.uuid,
      employee_name: emp.full_name,
      basic_salary: computed.basic,
      allowances: computed.allowances,
      deductions: computed.deductions,
      net_salary: computed.net,
      lines: computed.lines,
      attendance: {
        working_days: computed.summary.workingDays,
        attended_days: computed.summary.attendedDays,
        absent_days: computed.summary.absentDays,
        late_count: computed.summary.lateCount,
        paid_leave_days: computed.summary.paidLeaveDays,
        unpaid_leave_days: computed.summary.unpaidLeaveDays,
        approved_overtime_hours: computed.summary.approvedOvertimeHours,
        holidays_in_month: computed.summary.holidayCount,
      },
      rates: {
        per_day: computed.automatic.perDayRate,
        hourly: computed.automatic.hourlyRate,
        skip_reason: computed.automatic.skipReason,
      },
      /**
       * Expense reimbursement, broken out rather than folded into the allowances
       * total. It is money the employee is owed back for their own spending, and
       * an approver looking at a payslip deserves to see that it came from four
       * taxi claims rather than from a component nobody can name.
       */
      expense_reimbursement: {
        claim_count: computed.approvedClaims.length,
        amount: computed.expenseLine ? computed.expenseLine.amount : 0,
        claims: computed.approvedClaims,
      },
    });
  }

  const totals = items.reduce(
    (acc, i) => ({
      basic: moneyField(acc.basic + Number(i.basic_salary), "basic"),
      allowances: moneyField(acc.allowances + Number(i.allowances), "allowances"),
      deductions: moneyField(acc.deductions + Number(i.deductions), "deductions"),
      net: moneyField(acc.net + Number(i.net_salary), "net"),
    }),
    { basic: 0, allowances: 0, deductions: 0, net: 0 },
  );

  return ok(res, { month: m, year: y, items, totals, count: items.length }, "Payroll preview");
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
            e.full_name AS employee_name, e.email AS employee_email, dg.name AS designation,
            o.name AS organization_name
     FROM salary_records sr
     JOIN employees e ON e.uuid = sr.employee_uuid
     LEFT JOIN designations dg ON dg.id = e.designation_id
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
            e.full_name AS employee_name, e.email AS employee_email, dg.name AS designation,
            o.uuid AS organization_uuid, o.name AS organization_name
     FROM salary_records sr
     JOIN employees e ON e.uuid = sr.employee_uuid
     LEFT JOIN designations dg ON dg.id = e.designation_id
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
    `SELECT sr.*, e.full_name AS employee_name, e.cnic AS employee_cnic,
            e.phone AS employee_phone, dg.name AS designation, dp.name AS department,
            o.name AS organization_name, o.logo AS organization_logo
     FROM salary_records sr
     JOIN employees e ON e.uuid = sr.employee_uuid
     LEFT JOIN designations dg ON dg.id = e.designation_id
     LEFT JOIN departments dp ON dp.id = e.department_id
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

  const filename = `dverif-payslip-${record.uuid.slice(0, 8)}.pdf`;
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
            e.full_name AS employee_name, e.email AS employee_email, dg.name AS designation
     FROM salary_records sr
     JOIN employees e ON e.uuid = sr.employee_uuid
     LEFT JOIN designations dg ON dg.id = e.designation_id
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
  const filename = `dverif-payroll-${year || "all"}-${month ? MONTHS[m - 1] || "all" : "all"}.csv`;

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
            e.full_name AS employee_name, e.email AS employee_email, dg.name AS designation,
            o.name AS organization_name
     FROM salary_records sr
     JOIN employees e ON e.uuid = sr.employee_uuid
     LEFT JOIN designations dg ON dg.id = e.designation_id
     JOIN organizations o ON o.id = sr.organization_id
     ${whereClause}
     ORDER BY sr.year DESC, sr.month DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return ok(res, paginatedResponse(rows, total, page, limit), "Salary records");
}
