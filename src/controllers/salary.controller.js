import ApiError from "../utils/ApiError.js";
import { pool } from "../config/db.js";
import { employeeScopeCondition, assertEmployeeInDataScope } from "../utils/dataScopes.js";
import { ok } from "../utils/response.js";
import { assertUuid } from "../utils/publicResponse.js";
import { parsePagination, paginatedResponse } from "../utils/pagination.js";
import { logAudit, getActorFromReq } from "../utils/auditLog.js";
import { generatePayslipPdf } from "../utils/payslipPdf.js";
import { randomUUID } from "node:crypto";
import * as payrollService from "../services/payroll.service.js";
const {
  calculatePayrollAmounts,
  computeAutomaticLines,
  getMonthlyAttendanceAndLeaveSummary,
  insertSalaryRecordLines,
} =
  payrollService;
import * as expenses from "../services/expenses.service.js";
import { queueNotificationEmail, notificationActionUrl } from "../services/notificationEmail.service.js";
import { isoDate } from "../utils/dateRange.js";
import { CURRENCY } from "../utils/currency.js";

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

function normalizePayrollOvertimeAmounts(input) {
  if (input === undefined) return new Map();
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ApiError(400, "overtime_amounts must be an employee-to-amount object.");
  }
  const amounts = new Map();
  for (const [employeeUuid, rawAmount] of Object.entries(input)) {
    assertUuid(employeeUuid, "Overtime employee UUID");
    if (rawAmount === undefined || rawAmount === null || rawAmount === "") {
      throw new ApiError(400, "Each overtime amount is required.");
    }
    const amount = moneyField(rawAmount, "overtime_amount");
    if (amount > 999999999999.99) {
      throw new ApiError(400, "overtime_amount exceeds the maximum supported amount.");
    }
    amounts.set(employeeUuid, amount);
  }
  return amounts;
}

function assertPayrollOvertimeEmployees(amounts, employees) {
  const employeeUuids = new Set(employees.map((employee) => employee.uuid));
  for (const employeeUuid of amounts.keys()) {
    if (!employeeUuids.has(employeeUuid)) {
      throw new ApiError(400, "Overtime amounts may only be supplied for employees in this payroll run.");
    }
  }
}

function normalizePayrollComponentSelections(input) {
  if (input === undefined) return undefined;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ApiError(400, "component_selections must be an employee-to-components object.");
  }
  const selections = {};
  for (const [employeeUuid, selection] of Object.entries(input)) {
    assertUuid(employeeUuid, "Component-selection employee UUID");
    if (!selection || typeof selection !== "object" || Array.isArray(selection)) {
      throw new ApiError(400, "Each employee component selection must include allowance_uuids and deduction_uuids.");
    }
    const normalized = {};
    for (const field of ["allowance_uuids", "deduction_uuids"]) {
      const values = selection[field];
      if (!Array.isArray(values)) {
        throw new ApiError(400, `Each employee component selection must include an array of ${field}.`);
      }
      const unique = new Set();
      for (const uuid of values) {
        assertUuid(uuid, "Salary component assignment UUID");
        if (unique.has(uuid)) throw new ApiError(400, "Salary component assignments may only be selected once.");
        unique.add(uuid);
      }
      normalized[field] = [...unique];
    }
    selections[employeeUuid] = normalized;
  }
  return selections;
}

function assertPayrollComponentSelectionEmployees(selections, employees) {
  if (!selections) return;
  const employeeUuids = new Set(employees.map((employee) => employee.uuid));
  for (const employeeUuid of Object.keys(selections)) {
    if (!employeeUuids.has(employeeUuid)) {
      throw new ApiError(400, "Component selections may only be supplied for employees in this payroll run.");
    }
  }
}

function normalizePayrollRunPolicy(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ApiError(400, "Payroll run settings are required.");
  }
  const salaryCalculationPolicy = payrollService.normalizePayrollPolicy(
    input.salary_calculation_policy,
    input.salary_calculation_method,
  );
  const salaryCalculationMethod = payrollService.payrollAttendanceBasis(salaryCalculationPolicy);
  if (typeof input.calculate_overtime !== "boolean") {
    throw new ApiError(400, "calculate_overtime must be true or false.");
  }
  const validTime = (value) => typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value);
  if (!validTime(input.shift_start_time) || !validTime(input.shift_end_time)) {
    throw new ApiError(400, "Enter valid shift start and check-out times.");
  }
  const shiftStart = input.shift_start_time.slice(0, 5);
  const shiftEnd = input.shift_end_time.slice(0, 5);
  const startMinutes = Number(shiftStart.slice(0, 2)) * 60 + Number(shiftStart.slice(3, 5));
  const endMinutes = Number(shiftEnd.slice(0, 2)) * 60 + Number(shiftEnd.slice(3, 5));
  if (endMinutes <= startMinutes) {
    throw new ApiError(400, "Check-out must be later than shift start time.");
  }
  const overtimeMultiplier = Number(input.overtime_multiplier);
  if (!Number.isFinite(overtimeMultiplier) || overtimeMultiplier <= 0 || overtimeMultiplier > 5) {
    throw new ApiError(400, "overtime_multiplier must be greater than 0 and at most 5.");
  }
  const deductSalaryForLateArrivals = input.deduct_salary_for_late_arrivals ?? false;
  if (typeof deductSalaryForLateArrivals !== "boolean") {
    throw new ApiError(400, "deduct_salary_for_late_arrivals must be true or false.");
  }
  const lateArrivalThreshold = Number(input.late_arrival_threshold ?? 1);
  if (
    deductSalaryForLateArrivals
    && (!Number.isInteger(lateArrivalThreshold) || lateArrivalThreshold < 1)
  ) {
    throw new ApiError(400, "late_arrival_threshold must be a positive whole number.");
  }
  const lateGraceMinutes = Number(input.late_grace_minutes ?? 10);
  if (!Number.isInteger(lateGraceMinutes) || lateGraceMinutes < 0 || lateGraceMinutes > 180) {
    throw new ApiError(400, "late_grace_minutes must be a whole number between 0 and 180.");
  }
  return {
    salary_calculation_method: salaryCalculationMethod,
    salary_calculation_policy: salaryCalculationPolicy,
    calculate_overtime: input.calculate_overtime,
    shift_start_time: shiftStart,
    shift_end_time: shiftEnd,
    overtime_multiplier: overtimeMultiplier,
    deduct_salary_for_late_arrivals: deductSalaryForLateArrivals,
    late_arrival_threshold: Number.isInteger(lateArrivalThreshold) && lateArrivalThreshold > 0
      ? lateArrivalThreshold
      : 1,
    late_grace_minutes: lateGraceMinutes,
    hours_per_workday: (endMinutes - startMinutes) / 60,
    currency: CURRENCY,
  };
}

function payrollPolicySnapshot(policy) {
  return {
    salary_calculation_method: policy.salary_calculation_method,
    salary_calculation_policy: payrollService.normalizePayrollPolicy(
      policy.salary_calculation_policy,
      policy.salary_calculation_method,
    ),
    calculate_overtime: Number(policy.calculate_overtime) === 1 || policy.calculate_overtime === true,
    shift_start_time: String(policy.shift_start_time).slice(0, 5),
    shift_end_time: String(policy.shift_end_time).slice(0, 5),
    overtime_multiplier: Number(policy.overtime_multiplier),
    deduct_salary_for_late_arrivals:
      Number(policy.deduct_salary_for_late_arrivals) === 1 || policy.deduct_salary_for_late_arrivals === true,
    late_arrival_threshold: Number(policy.late_arrival_threshold ?? 1),
    late_grace_minutes: Number(policy.late_grace_minutes ?? 10),
  };
}

async function resolvePayrollRunInputs({ orgId, m, y, body, conn }) {
  const hasSettings = body?.settings !== undefined;
  const hasDays = body?.days !== undefined;
  if (hasSettings !== hasDays) {
    throw new ApiError(400, "Payroll run settings and working days must be supplied together.");
  }

  let policy;
  let schedule;
  if (hasSettings) {
    policy = normalizePayrollRunPolicy(body.settings);
    schedule = payrollService.normalizePayrollRunSchedule(body.days, m, y);
  } else {
    policy = await payrollService.getPayrollSettings(orgId, conn, m, y);
    const calendar = await payrollService.getWorkingDaysForMonth({ orgId, month: m, year: y, conn });
    const workingDates = new Set(calendar.workingDates);
    const offDates = calendar.nonWorkingDates;
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    schedule = Array.from({ length: daysInMonth }, (_, index) => {
      const date = `${y}-${String(m).padStart(2, "0")}-${String(index + 1).padStart(2, "0")}`;
      return { date, day_type: workingDates.has(date) ? "working" : offDates.has(date) ? "off" : null };
    });
    if (schedule.some((day) => day.day_type === null)) {
      throw new ApiError(409, "Monthly working schedule is incomplete. Configure every date as a working day or off day before payroll.");
    }
  }
  return {
    policy,
    schedule,
    policySnapshot: payrollPolicySnapshot(policy),
    scheduleSnapshot: schedule.map(({ date, day_type }) => ({ date, day_type })),
  };
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
async function computeEmployeePayroll({
  employeeUuid,
  orgId,
  m,
  y,
  joiningDate = null,
  policy,
  scheduleOverride,
  overtimeAmount: overtimeAmountOverride,
  componentSelections,
  conn,
}) {
  const basic = await payrollService.proratedBasicForMonth({ employeeUuid, orgId, month: m, year: y, joiningDate, conn });

  // Pull ONLY this employee's individually-assigned, active salary components.
  // We use the per-employee amount (esc.amount), NOT the catalog's default_value,
  // and never apply every active catalog component to every employee. Inactive
  // assignments are excluded so they stop affecting future runs; already-generated
  // records store computed totals and are never retroactively changed.
  //
  // The catalog's own is_active flag is checked as well. Deactivating a component
  // in the catalog is documented as stopping it being applied to future payroll
  // generations, and the status toggle writes only `salary_components.is_active`.
  // Without this predicate the assignment kept paying an "inactive" component
  // forever, while the screen showed it as switched off.
  const [empComponents] = await conn.query(
    `SELECT esc.uuid AS assignment_uuid, sc.name, sc.type, sc.is_percentage, esc.amount
     FROM employee_salary_components esc
     JOIN salary_components sc ON sc.id = esc.salary_component_id
     WHERE esc.employee_uuid=? AND sc.organization_id=? AND esc.is_active=1 AND sc.is_active=1`,
    [employeeUuid, orgId]
  );

  // Month-specific variable items (bonuses and one-off deductions, etc.).
  // These are separate from recurring employee assignments and are included only
  // for the exact payroll period being previewed/generated.
  const [monthlyVariables] = await conn.query(
    `SELECT label, type, amount
       FROM monthly_salary_variables
      WHERE organization_id=? AND employee_uuid=? AND month=? AND year=?
      ORDER BY id`,
    [orgId, employeeUuid, m, y],
  );
  let overtimeAmount = overtimeAmountOverride;
  if (overtimeAmount === undefined) {
    const [[overtimeRow]] = await conn.query(
      `SELECT overtime_amount
         FROM payroll_employee_overtime
        WHERE organization_id=? AND employee_uuid=? AND month=? AND year=?`,
      [orgId, employeeUuid, m, y],
    );
    overtimeAmount = moneyField(overtimeRow?.overtime_amount ?? 0, "overtime");
  }

  const summary = await getMonthlyAttendanceAndLeaveSummary({
    employeeUuid,
    orgId,
    month: m,
    year: y,
    joiningDate,
    policy,
    scheduleOverride,
    conn,
  });

  // Overtime pay is entered as a period-specific amount by payroll staff.
  // Attendance may still report approved overtime hours, but they must not
  // create a second, automatically calculated earning.
  const automatic = computeAutomaticLines({
    summary,
    basicSalary: basic,
    policy: { ...policy, calculate_overtime: false },
  });

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

  const expenseReimbursement = expenseLine?.amount ?? 0;
  const selection = componentSelections?.[employeeUuid];
  if (selection) {
    const activeAssignments = new Map(empComponents.map((component) => [
      component.assignment_uuid,
      component.type,
    ]));
    for (const [type, uuids] of [["allowance", selection.allowance_uuids], ["deduction", selection.deduction_uuids]]) {
      for (const uuid of uuids) {
        if (activeAssignments.get(uuid) !== type) {
          throw new ApiError(400, "Selected salary components must be active assignments of the matching type for this employee.");
        }
      }
    }
  }
  const selectedComponentUuids = selection
    ? [...selection.allowance_uuids, ...selection.deduction_uuids]
    : undefined;
  const compensation = calculatePayrollAmounts({
    basicSalary: basic,
    components: empComponents,
    selectedComponentUuids,
    monthlyVariables,
    automaticLines: automatic.lines,
    overtimeAmount,
    expenseReimbursement,
  });
  const lines = [
    { label: "Basic monthly salary", type: "earning", source: "basic", amount: Number(basic), basis_value: null, basis_unit: null },
    ...compensation.lines.filter((line) => line.source !== "auto_expense"),
    ...(compensation.expenseReimbursement > 0 ? [expenseLine] : []),
  ];

  return {
    basic,
    allowances: compensation.allowances,
    deductions: compensation.deductions,
    expenseReimbursement: compensation.expenseReimbursement,
    net: compensation.net,
    lines,
    summary,
    automatic,
    overtimeAmount,
    expenseLine,
    approvedClaims,
  };
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
  const overtimeAmounts = normalizePayrollOvertimeAmounts(req.body?.overtime_amounts);
  const componentSelections = normalizePayrollComponentSelections(req.body?.component_selections);

  const conn = await pool.getConnection();
  let skipped = 0;
  const generatedEmployeeUuids = [];
  // Declared outside the transaction block because it is reported after the commit.
  let claimsPaid = 0;
  try {
    await conn.beginTransaction();
    const runInputs = await resolvePayrollRunInputs({
      orgId,
      m,
      y,
      body: req.body,
      conn,
    });

    // Normalize an optional employee selection. When `employee_uuids` is
    // provided (individual or check-box selection), only those employees are
    // generated for. Otherwise ALL employees of the org are processed.
    // Sub_admins and the org_admin are users without employee records and
    // therefore are not part of payroll.
    const selected = Array.isArray(employee_uuids) ? [...new Set(employee_uuids.filter(Boolean))] : [];
    const scopeFilter = employeeScopeCondition(req, "payroll", "e");
    const scopeSql = scopeFilter ? ` AND ${scopeFilter.sql}` : "";
    let employees = [];

    if (selected.length) {
      const placeholders = selected.map(() => "?").join(",");
      [employees] = await conn.query(
        `SELECT e.uuid, e.joining_date FROM employees e WHERE e.organization_id=? AND e.uuid IN (${placeholders})${scopeSql}`,
        [orgId, ...selected, ...(scopeFilter?.params ?? [])]
      );
      if (employees.length !== selected.length) {
        throw new ApiError(404, "One or more selected employees are unavailable in your permitted data scope");
      }
    } else {
      [employees] = await conn.query(
        `SELECT e.uuid, e.joining_date FROM employees e WHERE e.organization_id=?${scopeSql}`,
        [orgId, ...(scopeFilter?.params ?? [])]
      );
      if (!employees.length) throw new ApiError(404, "No employees in your permitted data scope to process");
    }
    assertPayrollOvertimeEmployees(overtimeAmounts, employees);
    assertPayrollComponentSelectionEmployees(componentSelections, employees);

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
       * Paid claims have immutable payment-history rows with a restrictive foreign
       * key to the salary record. Refuse regeneration rather than orphaning or
       * silently rewriting a real disbursement.
       */
      const [doomedRecords] = await conn.query(
        `SELECT uuid, employee_uuid FROM salary_records
          WHERE organization_id=? AND month=? AND year=? AND employee_uuid IN (${placeholders})
          FOR UPDATE`,
        [orgId, m, y, ...employees.map((e) => e.uuid)]
      );
      await expenses.assertNoExpensePaymentsForSalaryRecords({
        conn,
        salaryRecordUuids: doomedRecords.map((r) => r.uuid),
      });

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
    const performedByUuid = req.user?.uuid ?? null;

    for (const emp of employees) {
      const overtimeAmount = overtimeAmounts.get(emp.uuid);
      if (overtimeAmount !== undefined) {
        await conn.query(
          `INSERT INTO payroll_employee_overtime
             (organization_id, employee_uuid, month, year, overtime_amount, updated_by_uuid)
           VALUES (?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE overtime_amount=VALUES(overtime_amount),
             updated_by_uuid=VALUES(updated_by_uuid)`,
          [orgId, emp.uuid, m, y, overtimeAmount, req.user?.uuid ?? null],
        );
      }
      const computed = await computeEmployeePayroll({
        employeeUuid: emp.uuid,
        orgId,
        m,
        y,
        joiningDate: emp.joining_date,
        policy: runInputs.policy,
        scheduleOverride: runInputs.schedule,
        overtimeAmount,
        componentSelections,
        conn,
      });
      if (computed.automatic.skipReason === "no_basic_salary") {
        throw new ApiError(409, `Payroll setup is incomplete for employee ${emp.uuid}: no positive effective basic salary exists for ${MONTHS[m - 1]} ${y}. Add an effective salary record, then preview again.`);
      }

      // Counted across the run so the response can say how many claims were
      // disbursed. Zero is the normal case and is worth stating explicitly,
      // because "no expense claims paid" is an answer to a question people ask.
      const paidForEmployee = computed.approvedClaims.length;
      claimsPaid += paidForEmployee;

      // The record's own uuid is generated here rather than by the table, because
      // salary_record_lines has to point at it and the two are written in the same
      // transaction. UUID() inside the INSERT would return the value to nobody.
      const recordUuid = randomUUID();
      generatedEmployeeUuids.push(emp.uuid);
      const expenseReimbursement = moneyField(computed.expenseReimbursement, "expense reimbursement");
      const netSalary = moneyField(computed.net, "net salary");

      await conn.query(
        `INSERT INTO salary_records
           (uuid, employee_uuid, organization_id, month, year, basic_salary,
            allowances, deductions, expense_reimbursement, net_salary, payroll_policy_snapshot,
            payroll_schedule_snapshot, notes, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [
          recordUuid,
          emp.uuid,
          orgId,
          m,
          y,
          computed.basic,
          computed.allowances,
          computed.deductions,
          expenseReimbursement,
          netSalary,
          JSON.stringify(runInputs.policySnapshot),
          JSON.stringify({
            days: runInputs.scheduleSnapshot,
            leave_calculation: computed.summary.leaveCalculation,
          }),
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
          performedByUuid,
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
            e.linked_user_uuid AS employee_user_uuid,
            dg.name AS designation, o.name AS organization_name
     FROM salary_records sr
     JOIN employees e ON e.uuid = sr.employee_uuid
     LEFT JOIN designations dg ON dg.id = e.designation_id
     JOIN organizations o ON o.id = sr.organization_id
     WHERE sr.organization_id=? AND sr.month=? AND sr.year=?
     ORDER BY e.full_name`,
    [orgId, m, y]
  );

  try {
    const generated = new Set(generatedEmployeeUuids);
    const period = `${MONTHS[m - 1]} ${y}`;
    const employeeEmails = rows.filter((row) => generated.has(row.employee_uuid) && row.employee_user_uuid);
    const notificationJobs = employeeEmails.map((row) => queueNotificationEmail({
      category: "payroll",
      eventKey: `payroll:${row.uuid}:payslip-ready`,
      userUuid: row.employee_user_uuid,
      subject: `Your ${period} payslip is ready`,
      title: `Your ${period} payslip is ready`,
      message: `Your payslip for ${period} has been generated. Sign in to Dverif to view it securely. Salary details are not included in this email.`,
      actionUrl: notificationActionUrl("/payroll"),
    }));
    if (generatedEmployeeUuids.length) {
      const [admins] = await pool.query(
        `SELECT uuid FROM users WHERE organization=? AND status='active' AND deleted_at IS NULL
          AND org_role IN ('org_admin','sub_admin')`,
        [orgId]
      );
      notificationJobs.push(...admins.map((admin) => queueNotificationEmail({
        category: "payroll",
        eventKey: `payroll:${orgId}:${y}-${m}:completed:${admin.uuid}`,
        userUuid: admin.uuid,
        subject: `${period} payroll generated`,
        title: "Payroll generation complete",
        message: `Payroll for ${period} was generated for ${generatedEmployeeUuids.length} employee(s). ${skipped} selected employee(s) were skipped because a record already existed. Review the payroll in Dverif.`,
        actionUrl: notificationActionUrl("/org/payroll"),
      })));
    }
    await Promise.allSettled(notificationJobs);
  } catch (error) {
    console.error("Payroll email enqueue failed:", error?.message);
  }

  const generatedEmployees = new Set(generatedEmployeeUuids);
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
      manual_overtime_amounts_saved: [...overtimeAmounts]
        .filter(([employeeUuid]) => generatedEmployees.has(employeeUuid))
        .map(([employeeUuid, amount]) => ({ employee_uuid: employeeUuid, amount })),
    },
    req,
  });

  return ok(res, { items: rows, month: m, year: y, count: rows.length, skipped, expense_claims_paid: claimsPaid }, "Payroll generated from salary history, components, leave, attendance, manual overtime and expense claims");
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
  const overtimeAmounts = normalizePayrollOvertimeAmounts(req.body?.overtime_amounts);
  const componentSelections = normalizePayrollComponentSelections(req.body?.component_selections);
  const runInputs = await resolvePayrollRunInputs({
    orgId,
    m,
    y,
    body: req.body,
    conn: pool,
  });

  const selected = Array.isArray(employee_uuids) ? [...new Set(employee_uuids.filter(Boolean))] : [];
  const scopeFilter = employeeScopeCondition(req, "payroll", "e");
  const scopeSql = scopeFilter ? ` AND ${scopeFilter.sql}` : "";
  let employees;
  if (selected.length) {
    const placeholders = selected.map(() => "?").join(",");
    [employees] = await pool.query(
      `SELECT e.uuid, e.full_name, e.joining_date FROM employees e WHERE e.organization_id=? AND e.uuid IN (${placeholders})${scopeSql}
        ORDER BY e.full_name`,
      [orgId, ...selected, ...(scopeFilter?.params ?? [])]
    );
    if (employees.length !== selected.length) {
      throw new ApiError(404, "One or more selected employees are unavailable in your permitted data scope");
    }
  } else {
    [employees] = await pool.query(
      `SELECT e.uuid, e.full_name, e.joining_date FROM employees e WHERE e.organization_id=?${scopeSql} ORDER BY e.full_name`,
      [orgId, ...(scopeFilter?.params ?? [])]
    );
  }
  assertPayrollOvertimeEmployees(overtimeAmounts, employees);
  assertPayrollComponentSelectionEmployees(componentSelections, employees);

  const items = [];
  for (const emp of employees) {
    const computed = await computeEmployeePayroll({
      employeeUuid: emp.uuid,
      orgId,
      m,
      y,
      joiningDate: emp.joining_date,
      policy: runInputs.policy,
      scheduleOverride: runInputs.schedule,
      overtimeAmount: overtimeAmounts.get(emp.uuid),
      componentSelections,
      conn: pool,
    });
    items.push({
      employee_uuid: emp.uuid,
      employee_name: emp.full_name,
      basic_salary: computed.basic,
      allowances: computed.allowances,
      deductions: computed.deductions,
      expense_reimbursement: computed.expenseReimbursement,
      net_salary: computed.net,
      lines: computed.lines,
      attendance: {
        working_days: computed.summary.monthWorkingDays ?? computed.summary.workingDays,
        calendar_days: computed.summary.calendarDays,
        elapsed_working_days: computed.summary.elapsedWorkingDays,
        attended_days: computed.summary.attendedDays,
        worked_hours: computed.summary.workedHours,
        expected_working_hours: computed.automatic.expectedHours,
        actual_overtime_hours: computed.summary.actualOvertimeHours,
        absent_days: computed.summary.absentDays,
        late_count: computed.summary.lateCount,
        paid_leave_days: computed.summary.paidLeaveDays,
        unpaid_leave_days: computed.summary.unpaidLeaveDays,
        leave_attendance_conflicts: computed.summary.leaveAttendanceConflicts,
        leave_calculation: computed.summary.leaveCalculation,
        approved_overtime_hours: computed.summary.approvedOvertimeHours,
        holidays_in_month: computed.summary.holidayCount,
      },
      rates: {
        per_day: computed.automatic.perDayRate,
        hourly: computed.automatic.hourlyRate,
        skip_reason: computed.automatic.skipReason,
        divisor: computed.automatic.divisor,
        salary_calculation_method: computed.summary.policy.salary_calculation_method,
        salary_calculation_policy: computed.automatic.payrollPolicy,
        expected_hours: computed.automatic.expectedHours,
        worked_hours: computed.automatic.workedHours,
        payable_ratio: computed.automatic.payableRatio,
        currency: computed.summary.policy.currency,
      },
      /**
       * Expense reimbursement, broken out rather than folded into the allowances
       * total. It is money the employee is owed back for their own spending, and
       * an approver looking at a payslip deserves to see that it came from four
       * taxi claims rather than from a component nobody can name.
       *
       * The NUMERIC total is `expense_reimbursement` above, which is what the
       * totals reducer and the preview dialog read. This detailed object used to
       * also be called `expense_reimbursement`, and because it came second in the
       * literal it silently replaced the number with an object. Every preview
       * then crashed in the totals reducer ("expense reimbursement must be a
       * non-negative number"), because Number(object) is NaN. One name per shape:
       * the number keeps the field the client already expects, the breakdown gets
       * its own key.
       */
      expense_reimbursement_details: {
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
      expense_reimbursement: moneyField(
        acc.expense_reimbursement + Number(i.expense_reimbursement),
        "expense reimbursement",
      ),
      net: moneyField(acc.net + Number(i.net_salary), "net"),
    }),
    { basic: 0, allowances: 0, deductions: 0, expense_reimbursement: 0, net: 0 },
  );

  return ok(res, { month: m, year: y, items, totals, count: items.length }, "Payroll preview");
}

/** Current recurring compensation for the organization's employee roster. */
export async function listPayrollEmployees(req, res) {
  const { page, limit, offset } = parsePagination(req.query, { maxLimit: 1000 });
  const orgId = req.scopeOrgId;
  if ((req.query.month === undefined) !== (req.query.year === undefined)) {
    throw new ApiError(400, "month and year must be supplied together");
  }
  const currentDate = new Date();
  const { m, y } = req.query.month === undefined && req.query.year === undefined
    ? { m: currentDate.getMonth() + 1, y: currentDate.getFullYear() }
    : payrollService.assertMonthYear(req.query.month, req.query.year);
  const employeeScope = employeeScopeCondition(req, "payroll", "e");
  const employeeWhere = `WHERE e.organization_id=? AND e.status IN ('current_employee', 'active')${employeeScope ? ` AND ${employeeScope.sql}` : ""}`;
  const employeeParams = [orgId, ...(employeeScope?.params ?? [])];

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM employees e ${employeeWhere}`,
    employeeParams,
  );
  const [employees] = await pool.query(
    `SELECT e.uuid, e.full_name, e.email, dg.name AS designation, dp.name AS department,
            (SELECT h.basic_salary FROM employee_salary_history h
             WHERE h.employee_uuid=e.uuid AND h.effective_to IS NULL
             ORDER BY h.effective_from DESC LIMIT 1) AS basic_salary,
            COALESCE((SELECT po.overtime_amount FROM payroll_employee_overtime po
              WHERE po.organization_id=e.organization_id AND po.employee_uuid=e.uuid
                AND po.month=? AND po.year=? LIMIT 1), 0) AS overtime_amount
       FROM employees e
       LEFT JOIN designations dg ON dg.id=e.designation_id
       LEFT JOIN departments dp ON dp.id=e.department_id
      ${employeeWhere}
      ORDER BY e.created_at DESC LIMIT ? OFFSET ?`,
    [m, y, ...employeeParams, limit, offset],
  );

  const compensation = new Map(
    employees.map((employee) => [
      employee.uuid,
      { allowances: [], deductions: [] },
    ]),
  );
  const employeesByUuid = new Map(employees.map((employee) => [employee.uuid, employee]));
  if (employees.length > 0) {
    const placeholders = employees.map(() => "?").join(", ");
    const [components] = await pool.query(
      `SELECT esc.uuid AS assignment_uuid, esc.employee_uuid, esc.amount, sc.name, sc.type, sc.is_percentage
         FROM employee_salary_components esc
         JOIN salary_components sc
           ON sc.id=esc.salary_component_id AND sc.organization_id=? AND sc.is_active=1
        WHERE esc.employee_uuid IN (${placeholders}) AND esc.is_active=1`,
      [orgId, ...employees.map((employee) => employee.uuid)],
    );

    for (const component of components) {
      const employee = employeesByUuid.get(component.employee_uuid);
      if (!employee) continue;
      const details = compensation.get(component.employee_uuid);
      const entries = component.type === "deduction" ? details.deductions : details.allowances;
      entries.push(component);
    }
  }

  const items = employees.map((employee) => {
    const details = compensation.get(employee.uuid);
    const amounts = calculatePayrollAmounts({
      basicSalary: Number(employee.basic_salary ?? 0),
      components: [...details.allowances, ...details.deductions],
      overtimeAmount: moneyField(employee.overtime_amount, "overtime"),
    });
    return {
      ...employee,
      allowance_items: amounts.lines
        .filter((line) => line.source === "component" && line.type === "earning")
        .map((line) => ({ uuid: line.assignment_uuid, name: line.label, amount: line.amount })),
      deduction_items: amounts.lines
        .filter((line) => line.source === "component" && line.type === "deduction")
        .map((line) => ({ uuid: line.assignment_uuid, name: line.label, amount: line.amount })),
      allowances: amounts.allowances,
      deductions: amounts.deductions,
      overtime_amount: moneyField(employee.overtime_amount, "overtime"),
      net_salary: amounts.net,
    };
  });
  return ok(res, paginatedResponse(items, total, page, limit), "Payroll employees");
}

/** Payroll settings and monthly working/off-day calendar. */
export async function getPayrollSettings(req, res) {
  const month = req.query.month === undefined ? null : Number(req.query.month);
  const year = req.query.year === undefined ? null : Number(req.query.year);
  if ((month === null) !== (year === null)) {
    throw new ApiError(400, "month and year must be supplied together");
  }
  const { m, y } = month === null ? { m: null, y: null } : payrollService.assertMonthYear(month, year);
  let rows = [];
  if (m !== null) {
    [rows] = await pool.query(
      "SELECT salary_calculation_method, salary_calculation_policy, calculate_overtime, shift_start_time, shift_end_time, overtime_multiplier, deduct_salary_for_late_arrivals, late_arrival_threshold, late_grace_minutes FROM organization_monthly_payroll_settings WHERE organization_id=? AND month=? AND year=?",
      [req.scopeOrgId, m, y],
    );
  }
  if (!rows.length) {
    [rows] = await pool.query(
      "SELECT salary_calculation_method, salary_calculation_policy, calculate_overtime, shift_start_time, shift_end_time, overtime_multiplier, deduct_salary_for_late_arrivals, late_arrival_threshold, late_grace_minutes FROM organization_payroll_settings WHERE organization_id=?",
      [req.scopeOrgId],
    );
  }
  const settings = rows[0] ? {
    ...rows[0],
    salary_calculation_policy: payrollService.normalizePayrollPolicy(
      rows[0].salary_calculation_policy,
      rows[0].salary_calculation_method,
    ),
    salary_calculation_method: payrollService.payrollAttendanceBasis(
      payrollService.normalizePayrollPolicy(rows[0].salary_calculation_policy, rows[0].salary_calculation_method),
    ),
    calculate_overtime: Number(rows[0].calculate_overtime) === 1,
    deduct_salary_for_late_arrivals: Number(rows[0].deduct_salary_for_late_arrivals) === 1,
    late_arrival_threshold: Number(rows[0].late_arrival_threshold ?? 1),
    late_grace_minutes: Number(rows[0].late_grace_minutes ?? 10),
  } : null;
  return ok(res, { settings, month: m, year: y }, "Payroll settings");
}

export async function updatePayrollSettings(req, res) {
  const body = req.body ?? {};
  const isOrganizationDefault = body.scope === "organization";
  const { m, y } = isOrganizationDefault
    ? { m: null, y: null }
    : payrollService.assertMonthYear(body.month, body.year);
  if (body.scope !== undefined && body.scope !== "organization" && body.scope !== "month") {
    throw new ApiError(400, "scope must be 'organization' or 'month'.");
  }
  const settings = normalizePayrollRunPolicy(body);
  const normalizedLateArrivalThreshold = settings.late_arrival_threshold;
  const table = isOrganizationDefault ? "organization_payroll_settings" : "organization_monthly_payroll_settings";
  const periodColumns = isOrganizationDefault ? "" : "month, year, ";
  const periodValues = isOrganizationDefault ? "" : "?, ?, ";
  const periodParams = isOrganizationDefault ? [] : [m, y];
  await pool.query(
    `INSERT INTO ${table}
       (organization_id, ${periodColumns}salary_calculation_method, salary_calculation_policy, calculate_overtime, shift_start_time, shift_end_time, overtime_multiplier, deduct_salary_for_late_arrivals, late_arrival_threshold, late_grace_minutes, updated_by_uuid)
     VALUES (?, ${periodValues}?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE salary_calculation_method=VALUES(salary_calculation_method),
       salary_calculation_policy=VALUES(salary_calculation_policy),
       calculate_overtime=VALUES(calculate_overtime), shift_start_time=VALUES(shift_start_time),
       shift_end_time=VALUES(shift_end_time), overtime_multiplier=VALUES(overtime_multiplier),
       deduct_salary_for_late_arrivals=VALUES(deduct_salary_for_late_arrivals),
       late_arrival_threshold=VALUES(late_arrival_threshold),
       late_grace_minutes=VALUES(late_grace_minutes),
       updated_by_uuid=VALUES(updated_by_uuid)`,
    [
      req.scopeOrgId, ...periodParams, settings.salary_calculation_method, settings.salary_calculation_policy,
      settings.calculate_overtime ? 1 : 0, settings.shift_start_time, settings.shift_end_time,
      settings.overtime_multiplier, settings.deduct_salary_for_late_arrivals ? 1 : 0,
      normalizedLateArrivalThreshold, settings.late_grace_minutes, req.user?.uuid ?? null,
    ],
  );
  return getPayrollSettings({
    ...req,
    query: isOrganizationDefault ? {} : { month: m, year: y },
  }, res);
}

export async function getMonthlyWorkSchedule(req, res) {
  const month = Number(req.query.month);
  const year = Number(req.query.year);
  const { m, y } = payrollService.assertMonthYear(month, year);
  const [rows] = await pool.query(
    "SELECT schedule_date, day_type FROM organization_monthly_work_schedules WHERE organization_id=? AND MONTH(schedule_date)=? AND YEAR(schedule_date)=? ORDER BY schedule_date",
    [req.scopeOrgId, m, y],
  );
  // DATE columns arrive as a JS Date at LOCAL midnight; serialising that to JSON
  // converts it to UTC and, east of Greenwich, moves it to the previous day. The
  // editor then shows (and re-saves) a schedule shifted by one day, so a Saturday
  // marked working reappeared as an off Friday. Return the calendar date as text.
  const days = rows.map((row) => ({ schedule_date: isoDate(row.schedule_date), day_type: row.day_type }));
  return ok(res, { month: m, year: y, days }, "Monthly working schedule");
}

export async function saveMonthlyWorkSchedule(req, res) {
  const month = Number(req.body?.month);
  const year = Number(req.body?.year);
  const { m, y } = payrollService.assertMonthYear(month, year);
  const days = req.body?.days;
  const total = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (!Array.isArray(days) || days.length !== total) throw new ApiError(400, "Select every date in the month as either a working day or an off day.");
  const seen = new Set();
  for (const item of days) {
    if (!item || !/^\d{4}-\d{2}-\d{2}$/.test(String(item.date)) || !["working", "off"].includes(item.day_type)) throw new ApiError(400, "Each schedule day needs a valid date and working/off selection.");
    const date = String(item.date);
    if (date.slice(0, 7) !== `${y}-${String(m).padStart(2, "0")}` || seen.has(date)) throw new ApiError(400, "Schedule dates must be unique and belong to the selected month.");
    seen.add(date);
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query("DELETE FROM organization_monthly_work_schedules WHERE organization_id=? AND YEAR(schedule_date)=? AND MONTH(schedule_date)=?", [req.scopeOrgId, y, m]);
    for (const item of days) {
      await conn.query(
        "INSERT INTO organization_monthly_work_schedules (organization_id, schedule_date, day_type, updated_by_uuid) VALUES (?, ?, ?, ?)",
        [req.scopeOrgId, item.date, item.day_type, req.user?.uuid ?? null],
      );
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
  return getMonthlyWorkSchedule({ ...req, query: { month: m, year: y } }, res);
}

// ---------------------------------------------------------------------------
// Delete an entire generated payroll period (regeneratable)
// ---------------------------------------------------------------------------

export async function deleteSalaryPeriod(req, res) {
  const orgId = req.scopeOrgId;
  const { m, y } = monthYearFields(req.params.month, req.params.year);

  const conn = await pool.getConnection();
  let result;
  try {
    await conn.beginTransaction();
    const [records] = await conn.query(
      "SELECT uuid FROM salary_records WHERE organization_id=? AND month=? AND year=? FOR UPDATE",
      [orgId, m, y],
    );
    await expenses.assertNoExpensePaymentsForSalaryRecords({
      conn,
      salaryRecordUuids: records.map((record) => record.uuid),
    });
    [result] = await conn.query(
      "DELETE FROM salary_records WHERE organization_id=? AND month=? AND year=?",
      [orgId, m, y],
    );
    await conn.commit();
  } catch (error) {
    try {
      await conn.rollback();
    } catch {
      // Preserve the payroll deletion error.
    }
    throw error;
  } finally {
    conn.release();
  }

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

  const conn = await pool.getConnection();
  let result;
  try {
    await conn.beginTransaction();
    const [records] = await conn.query(
      "SELECT uuid FROM salary_records WHERE uuid=? AND organization_id=? FOR UPDATE",
      [req.params.uuid, orgId],
    );
    if (!records.length) throw new ApiError(404, "Salary record not found");
    await expenses.assertNoExpensePaymentsForSalaryRecords({
      conn,
      salaryRecordUuids: [records[0].uuid],
    });
    [result] = await conn.query(
      "DELETE FROM salary_records WHERE uuid=? AND organization_id=?",
      [req.params.uuid, orgId],
    );
    if (!result.affectedRows) throw new ApiError(404, "Salary record not found");
    await conn.commit();
  } catch (error) {
    try {
      await conn.rollback();
    } catch {
      // Preserve the payroll deletion error.
    }
    throw error;
  } finally {
    conn.release();
  }

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
  const department = typeof req.query.department === "string" ? req.query.department.trim() : "";

  let whereClause = "WHERE sr.organization_id = ?";
  const params = [orgId];
  const employeeScope = employeeScopeCondition(req, "payroll", "e");
  if (employeeScope) {
    whereClause += ` AND ${employeeScope.sql}`;
    params.push(...employeeScope.params);
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
  if (department) {
    whereClause += " AND EXISTS (SELECT 1 FROM departments dp WHERE dp.id=e.department_id AND dp.organization_id=e.organization_id AND dp.name=?)";
    params.push(department);
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
            sr.allowances, sr.deductions, sr.expense_reimbursement, sr.net_salary, sr.notes, sr.created_at,
            sr.payroll_policy_snapshot, sr.payroll_schedule_snapshot,
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
  const recordUuids = rows.map((row) => row.uuid);
  if (recordUuids.length) {
    const [lineRows] = await pool.query(
      `SELECT salary_record_uuid, label, type, source, amount, basis_value, basis_unit
         FROM salary_record_lines
        WHERE salary_record_uuid IN (?)
        ORDER BY salary_record_uuid, FIELD(type, 'earning', 'deduction'), id`,
      [recordUuids],
    );
    const linesByRecord = new Map();
    for (const line of lineRows) {
      if (!linesByRecord.has(line.salary_record_uuid)) {
        linesByRecord.set(line.salary_record_uuid, []);
      }
      linesByRecord.get(line.salary_record_uuid).push(line);
    }
    for (const row of rows) {
      row.lines = linesByRecord.get(row.uuid) ?? [];
    }
  }
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
            sr.allowances, sr.deductions, sr.expense_reimbursement, sr.net_salary, sr.notes, sr.created_at,
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
  const record = rows[0];

  /*
   * THE ITEMISED LINES, from the table the payroll generator already writes.
   *
   * `salary_record_lines` has held every earning and deduction since payroll
   * auto-computation was introduced — basic, each component, each
   * attendance-derived line, the expense reimbursement — and the payslip has been
   * showing only the two rollups from `salary_records` anyway. So the data was
   * already itemised and the document was the part that was not.
   *
   * Scoped by organization as well as record: these rows are employee-level
   * financial detail, and the parent select above joins on
   * `sr.organization_id` only in the non-admin branch, so the line query has to
   * stand on its own rather than assume the parent was org-filtered.
   *
   * `id` ordering is not cosmetic — it is the order the generator inserted the
   * lines in, which is basic, then components, then automatic, then expense.
   * Re-sorting alphabetically would move "Overtime" above "Basic salary".
   */
  const [lines] = await pool.query(
    `SELECT uuid, label, type, source, amount, basis_value, basis_unit
       FROM salary_record_lines
      WHERE salary_record_uuid = ? AND organization_id = ?
      ORDER BY FIELD(type, 'earning', 'deduction'), id`,
    [uuid, record.organization_id]
  );
  record.lines = lines;
  return record;
}

/**
 * Render the payslip and send it, as either a download or an inline preview.
 *
 * The `inline` mode exists because a payslip is a document people READ before
 * they keep: the previous behaviour opened a file chooser for a filename nobody
 * cared about, and the only way to see what the button produced was to save it
 * somewhere first. `Content-Disposition: inline` lets the browser's PDF viewer
 * show it in a new tab, and the download path still exists as the action beside
 * it for people who want the file.
 *
 * BOTH MODES RENDER FROM THE SAME RECORD. One function, one query, one PDF. If
 * the preview and the download were produced by two code paths they would
 * eventually disagree, and the number a recruiter signs off on would not be the
 * number the employee is handed.
 */
export async function downloadPayslip(req, res) {
  const isAdmin = Boolean(req.admin);
  const orgId = isAdmin ? null : req.scopeOrgId;
  const record = await getSalaryRecordForPayslip(req.params.uuid, orgId, isAdmin);
  if (!isAdmin) await assertEmployeeInDataScope(req, "payroll", record.employee_uuid);

  const pdf = await generatePayslipPdf({
    record,
    employeeName: record.employee_name,
    organizationName: record.organization_name,
  });

  const filename = `dverif-payslip-${record.uuid.slice(0, 8)}.pdf`;
  const dispositionType = req.query.disposition === "inline" ? "inline" : "attachment";
  res.setHeader("Content-Type", "application/pdf");
  const disposition = req.query?.view === "inline" ? "inline" : "attachment";
  res.setHeader("Content-Disposition", `${disposition}; filename="${filename}"`);
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
  const employeeScope = employeeScopeCondition(req, "payroll", "e");
  if (employeeScope) {
    whereClause += ` AND ${employeeScope.sql}`;
    params.push(...employeeScope.params);
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

  const [rows] = await pool.query(
    `SELECT sr.employee_uuid, sr.month, sr.year, sr.basic_salary,
            sr.allowances, sr.deductions, sr.expense_reimbursement, sr.net_salary, sr.notes, sr.created_at,
            e.full_name AS employee_name, e.email AS employee_email, dg.name AS designation
     FROM salary_records sr
     JOIN employees e ON e.uuid = sr.employee_uuid
     LEFT JOIN designations dg ON dg.id = e.designation_id
     ${whereClause}
     ORDER BY sr.year DESC, sr.month DESC, e.full_name`,
    params
  );

  const header = "Employee,Email,Designation,Month,Year,Basic Salary,Allowances,Expense Reimbursement,Deductions,Net Salary,Notes";
  const lines = rows.map((r) => [
    r.employee_name,
    r.employee_email,
    r.designation,
    MONTHS[r.month - 1] ?? r.month,
    r.year,
    r.basic_salary,
    r.allowances,
    r.expense_reimbursement,
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
            sr.allowances, sr.deductions, sr.expense_reimbursement, sr.net_salary, sr.notes, sr.created_at,
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

  /*
   * THE ITEMISED LINES, for the on-screen payslip dialog.
   *
   * The dialog used to show four numbers — basic, allowances, deductions, net —
   * which is a summary an employee has no way to act on. "What am I actually
   * paid for, and why is this taken off?" was answerable only as a total.
   * `salary_record_lines` already holds the answer, so this fetches it.
   *
   * One query for the whole page rather than one per row: the page is at most
   * `limit` records and the alternative is N round trips for a page that was
   * already being fetched in one. Scoped by employee, which the `whereClause`
   * already established.
   */
  const uuids = rows.map((r) => r.uuid);
  if (uuids.length) {
    const [lineRows] = await pool.query(
      `SELECT salary_record_uuid, label, type, source, amount, basis_value, basis_unit
         FROM salary_record_lines
        WHERE salary_record_uuid IN (?)
        ORDER BY salary_record_uuid, FIELD(type, 'earning', 'deduction'), id`,
      [uuids]
    );
    const byRecord = new Map();
    for (const line of lineRows) {
      const key = line.salary_record_uuid;
      if (!byRecord.has(key)) byRecord.set(key, []);
      byRecord.get(key).push(line);
    }
    for (const row of rows) row.lines = byRecord.get(row.uuid) ?? [];
  }

  return ok(res, paginatedResponse(rows, total, page, limit), "Salary records");
}
