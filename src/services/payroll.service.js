import ApiError from "../utils/ApiError.js";
import { pool } from "../config/db.js";
import { assertUuid } from "../utils/publicResponse.js";
import { isoDate as normaliseIsoDate } from "../utils/dateRange.js";
import { CURRENCY } from "../utils/currency.js";

/**
 * Payroll's view of what actually happened in a month.
 *
 * Payroll used to be a manual ledger: it read a basic salary and a list of
 * allowance/deduction components and stopped there. Leave and attendance were
 * fully built and never connected to money, so an employee could take unpaid
 * leave, never clock in, and work overtime and still be paid identically to a
 * colleague who did none of it. This module is the join.
 *
 * Every deduction rate uses an organization-selected divisor. Working-day counts
 * use the configured week and holiday table; calendar-day and fixed-30 bases are
 * explicit alternatives selected in payroll policy rather than implicit defaults.
 */

const WEEK_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/** JS getDay(): 0=Sunday. Maps onto the work_week_config column names. */
const DAY_KEY = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/**
 * Late arrival cutoff is configured per organization. Payroll never assumes a
 * company shift start or grace period.
 */
const LATE_AFTER_MINUTES = null;

/** Every 3 late arrivals costs half a day's pay. */
const LATES_PER_HALF_DAY = null;

/** Overtime is paid at this multiple of the hourly rate derived from basic. */
const OVERTIME_RATE_MULTIPLIER = null;

/**
 * The effective basic salary for a given month.
 *
 * Matched on the month's LAST day against each period's [effective_from,
 * effective_to] range, newest period first.
 *
 * Lives here, not in the salary controller, because two features now need it and
 * must not be able to disagree: monthly payroll, and the Full & Final settlement
 * that pays out unused leave at a per-day rate. A second implementation of "the
 * employee's salary that month" would let FnF quote a different daily rate from
 * the payslip it sits beside, with no error anywhere - just a number nobody can
 * reconcile.
 */
export async function effectiveBasicForMonth({ employeeUuid, orgId, month, year, conn = pool }) {
  const { m, y } = assertMonthYear(month, year);
  const { lastDay } = monthBounds(m, y);
  const [rows] = await conn.query(
    `SELECT basic_salary
       FROM employee_salary_history
      WHERE employee_uuid=?
        AND effective_from <= ?
        AND (effective_to IS NULL OR effective_to >= ?)
      ORDER BY effective_from DESC
      LIMIT 1`,
    [employeeUuid, lastDay, lastDay],
  );
  return rows.length ? rows[0].basic_salary : 0;
}

export const PAYROLL_RULES = {
  LATE_AFTER_MINUTES,
  LATES_PER_HALF_DAY,
  OVERTIME_RATE_MULTIPLIER,
  OVERTIME_RATE_LABEL: null,
  DEFAULT_WORK_WEEK: null,
};

// `currency` is NOT one of these. It was, when administrators could type a
// three-letter code, and its absence here is the point: a currency is no longer
// something an administrator confirms, so a NULL left over from before this
// change must not keep blocking payroll. CURRENCY is applied below instead.
const REQUIRED_POLICY_FIELDS = ["pay_frequency", "daily_rate_basis", "hours_per_workday", "shift_start_time", "late_grace_minutes", "late_arrivals_per_penalty", "late_penalty_days", "overtime_multiplier", "deduct_unpaid_leave", "deduct_absences", "deduct_late_arrivals", "pay_approved_overtime"];

export async function getConfiguredPayrollPolicy(orgId, conn = pool) {
  const [rows] = await conn.query("SELECT * FROM organization_payroll_policies WHERE organization_id=? AND is_configured=1", [orgId]);
  const policy = rows[0];
  if (!policy || REQUIRED_POLICY_FIELDS.some((field) => policy[field] === null || policy[field] === undefined)) {
    throw new ApiError(409, "Payroll policy is not configured. An organization administrator must confirm the work week, pay frequency and deduction/overtime rules before preview or payroll generation.");
  }
  // Normalized on read rather than trusted from the row, so every downstream
  // consumer of the policy — payslips, salary lines, the preview response —
  // reports the same currency even if a pre-PKR row is still in the table.
  return { ...policy, currency: CURRENCY };
}

export function assertMonthYear(month, year) {
  const m = parseInt(month, 10);
  if (Number.isNaN(m) || m < 1 || m > 12) throw new ApiError(400, "month must be between 1 and 12");
  const y = parseInt(year, 10);
  if (Number.isNaN(y) || y < 2000 || y > 2100) throw new ApiError(400, "year is invalid");
  return { m, y };
}

/** Inclusive first/last calendar day of a month, as YYYY-MM-DD. */
function monthBounds(month, year) {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const last = new Date(Date.UTC(year, month, 0));
  return {
    firstDay: first.toISOString().slice(0, 10),
    lastDay: last.toISOString().slice(0, 10),
  };
}

/** Round to 2dp. DECIMAL arrives from mysql2 as a string and must not concat. */
function money(n) {
  return Math.round(Number(n) * 100) / 100;
}

/**
 * This organization's explicitly configured working week. No calendar is
 * inferred: payroll must stop until an administrator confirms the schedule.
 */
export async function getWorkWeek(orgId, conn = pool) {
  const [rows] = await conn.query(
    "SELECT mon,tue,wed,thu,fri,sat,sun FROM work_week_config WHERE organization_id=?",
    [orgId],
  );
  if (!rows.length) throw new ApiError(409, "Payroll work week is not configured. Set the organization's working days before payroll calculation.");
  if (!WEEK_KEYS.some((k) => Number(rows[0][k]) === 1)) throw new ApiError(409, "Payroll work week has no working days. Configure at least one working day.");
  const row = rows[0];
  const week = {};
  for (const k of WEEK_KEYS) week[k] = row[k] ? 1 : 0;
  return week;
}

/**
 * Working days in a month: the org's configured weekdays, minus holidays.
 *
 * Returned with the set of non-working dates so callers can subtract leave and
 * absence without re-deriving it.
 */
export async function getWorkingDaysForMonth({ orgId, month, year, conn = pool }) {
  const { m, y } = assertMonthYear(month, year);
  const { firstDay, lastDay } = monthBounds(m, y);
  const week = await getWorkWeek(orgId, conn);

  const [holidayRows] = await conn.query(
    "SELECT date FROM holidays WHERE organization_id=? AND date BETWEEN ? AND ?",
    [orgId, firstDay, lastDay],
  );
  const holidays = new Set(holidayRows.map((r) => isoDate(r.date)));

  const days = [];
  const nonWorkingDates = new Set();
  const cursor = new Date(`${firstDay}T00:00:00Z`);
  const last = `${lastDay}T00:00:00Z`;

  while (cursor.toISOString().slice(0, 10) <= lastDay) {
    const iso = cursor.toISOString().slice(0, 10);
    const isWeekend = !week[DAY_KEY[cursor.getUTCDay()]];
    const isHoliday = holidays.has(iso);
    if (!isWeekend && !isHoliday) days.push(iso);
    else nonWorkingDates.add(iso);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return { workingDays: days.length, workingDates: days, nonWorkingDates, week, holidays };
}

/**
 * Normalise a DATE column to YYYY-MM-DD.
 *
 * Delegates to the shared helper in utils/leaveBalance.js, which is where this
 * logic belongs and where it was WRONG until Phase 4: it read the UTC calendar
 * fields of a value mysql2 had built at LOCAL midnight, so on this server (UTC+5)
 * a stored 2026-10-01 came back as 2026-09-30. Holidays stopped matching, leave
 * attached to the wrong days, and a 2-day leave request was charged 3.
 *
 * This function previously carried its own corrected copy, which is how the same
 * bug existed in two places - one fixed, one live. One definition now, imported,
 * because a payroll figure and a leave day count that disagree by a day are both
 * wrong and neither reports an error.
 *
 * DATETIME columns are unaffected: they carry a real time of day and nothing here
 * normalises them.
 */
const isoDate = (value) => normaliseIsoDate(value);

/**
 * Approved leave in the month, split by whether it is paid.
 *
 * The span is CLIPPED to the month, because a request from 28 Feb to 4 Mar must
 * not charge all seven days to February. This is the same LEAST/GREATEST clip the
 * dashboard analytics query uses, applied in JS so the two agree.
 *
 * Only working days inside the span count. Counting the Saturday inside an
 * approved absence as leave AND then also counting it as absent would double-count
 * it, and a payroll deduction is not something to apply twice for the same day.
 */
export async function getApprovedLeaveForMonth({ employeeUuid, month, year, workingDates, conn = pool }) {
  const { m, y } = assertMonthYear(month, year);
  const { firstDay, lastDay } = monthBounds(m, y);
  assertUuid(employeeUuid, "Employee UUID");

  const [rows] = await conn.query(
    `SELECT lr.start_date, lr.end_date, lt.name AS leave_type, lt.is_paid
       FROM leave_requests lr
       JOIN leave_types lt ON lt.id = lr.leave_type_id
      WHERE lr.employee_uuid=?
        AND lr.status='approved'
        AND lr.start_date <= ?
        AND lr.end_date >= ?`,
    [employeeUuid, lastDay, firstDay],
  );

  const working = new Set(workingDates);
  const paidDays = new Set();
  const unpaidDays = new Set();

  for (const r of rows) {
    const target = String(r.is_paid) === "no" ? unpaidDays : paidDays;
    // Clamp the request to the month, then step through it inclusively.
    let d = isoDate(r.start_date) < firstDay ? firstDay : isoDate(r.start_date);
    const end = isoDate(r.end_date) > lastDay ? lastDay : isoDate(r.end_date);
    const cursor = new Date(`${d}T00:00:00Z`);
    const stop = `${end}T00:00:00Z`;
    while (cursor.toISOString().slice(0, 10) <= stop) {
      const iso = cursor.toISOString().slice(0, 10);
      if (working.has(iso)) target.add(iso);
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  }

  // A day cannot be both paid and unpaid leave. Paid wins, because the more
  // expensive reading (a deduction) must never come from two overlapping rows.
  for (const d of paidDays) unpaidDays.delete(d);

  return {
    paidLeaveDays: paidDays.size,
    unpaidLeaveDays: unpaidDays.size,
    paidDates: [...paidDays].sort(),
    unpaidDates: [...unpaidDays].sort(),
    requests: rows.length,
  };
}

/**
 * Attendance in the month: days worked, late arrivals, absences.
 *
 * Absence is implicit in this schema — attendance_records has one row per
 * employee per day and its status is only checked_in/checked_out, so a day with
 * no row is simply a day with no record. So absence is DERIVED, and it must be
 * derived against working days minus leave, or every weekend in the month reads
 * as unpaid absence. An employee on approved leave has no attendance row either,
 * which is the other half of the same double-count.
 */
export async function getAttendanceForMonth({ employeeUuid, month, year, workingDates, excludedDates, lateCutoffMinutes = null, conn = pool }) {
  const { m, y } = assertMonthYear(month, year);
  const { firstDay, lastDay } = monthBounds(m, y);
  assertUuid(employeeUuid, "Employee UUID");

  const [rows] = await conn.query(
    `SELECT date, check_in_at, check_out_at, is_manual
       FROM attendance_records
      WHERE employee_uuid=? AND date BETWEEN ? AND ?`,
    [employeeUuid, firstDay, lastDay],
  );

  const working = new Set(workingDates);
  const excused = new Set(excludedDates ?? []);

  const presentDates = new Set();
  let lateCount = 0;

  for (const r of rows) {
    const iso = isoDate(r.date);
    if (!working.has(iso)) continue;
    // An attendance row on a day the employee was on approved leave means the
    // leave record and the log disagree. The log is the stronger evidence that
    // they worked, so it counts as present — otherwise the day is deducted as
    // unpaid leave AND counted as an absence.
    if (excused.has(iso)) continue;
    presentDates.add(iso);
    if (lateCutoffMinutes !== null && minutesPastMidnight(r.check_in_at) > Number(lateCutoffMinutes)) lateCount += 1;
  }

  // Absence = working days, less days with a record, less days excused by leave.
  // Never negative: a manually entered attendance row can otherwise push this
  // below zero and then a negative day count becomes a negative deduction, which
  // reads as a pay rise.
  const excusedCount = [...excused].filter((d) => working.has(d)).length;
  const absentDays = Math.max(0, working.size - presentDates.size - excusedCount);

  return {
    attendedDays: presentDates.size,
    absentDays,
    lateCount,
    presentDates: [...presentDates].sort(),
  };
}

function minutesPastMidnight(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  // check_in_at is stored local wall-clock and read back in server-local time,
  // so local accessors are the ones that match what the employee saw on the
  // clock. Using UTC here would shift every check-in by the server's offset and
  // make the 09:30 cutoff fire at the wrong hour.
  return d.getHours() * 60 + d.getMinutes();
}

/** Approved overtime hours in the month.
 *
 * Only `approved_hours` is ever paid, never `requested_hours`. The two columns
 * exist precisely so the amount a manager allowed can differ from the amount
 * claimed; reading the requested figure is how unapproved hours get paid.
 */
export async function getApprovedOvertimeForMonth({ employeeUuid, month, year, conn = pool }) {
  const { m, y } = assertMonthYear(month, year);
  const { firstDay, lastDay } = monthBounds(m, y);
  assertUuid(employeeUuid, "Employee UUID");

  const [rows] = await conn.query(
    `SELECT work_date, requested_hours, approved_hours
       FROM overtime_requests
      WHERE employee_uuid=?
        AND status='approved'
        AND work_date BETWEEN ? AND ?`,
    [employeeUuid, firstDay, lastDay],
  );

  let approved = 0;
  let requested = 0;
  for (const r of rows) {
    approved += Number(r.approved_hours);
    requested += Number(r.requested_hours);
  }

  return {
    approvedOvertimeHours: money(approved),
    requestedOvertimeHours: money(requested),
    requests: rows.length,
  };
}

/**
 * Everything payroll needs to know about one employee's month.
 *
 * The single entry point the caller should use: it derives the working-day set
 * once and threads it through, because the three sub-queries all depend on the
 * same definition of "a working day" and computing it three times is how they end
 * up disagreeing.
 */
export async function getMonthlyAttendanceAndLeaveSummary({ employeeUuid, orgId, month, year, policy = null, conn = pool }) {
  const { m, y } = assertMonthYear(month, year);
  const activePolicy = policy ?? await getConfiguredPayrollPolicy(orgId, conn);
  const calendar = await getWorkingDaysForMonth({ orgId, month: m, year: y, conn });

  const leave = await getApprovedLeaveForMonth({
    employeeUuid,
    month: m,
    year: y,
    workingDates: calendar.workingDates,
    conn,
  });

  const attendance = await getAttendanceForMonth({
    employeeUuid,
    month: m,
    year: y,
    workingDates: calendar.workingDates,
    // BOTH kinds of leave excuse the day. Paid leave is not a deduction, but the
    // employee still did not clock in, so without this a paid sick-leave day is
    // counted as an absence and docked. That is the bug this argument prevents.
    excludedDates: [...leave.paidDates, ...leave.unpaidDates],
    lateCutoffMinutes: timeToMinutes(activePolicy.shift_start_time) + Number(activePolicy.late_grace_minutes),
    conn,
  });

  const overtime = await getApprovedOvertimeForMonth({ employeeUuid, month: m, year: y, conn });

  return {
    month: m,
    year: y,
    workingDays: calendar.workingDays,
    calendarDays: new Date(Date.UTC(y, m, 0)).getUTCDate(),
    policy: activePolicy,
    holidayCount: calendar.holidays.size,
    week: calendar.week,
    attendedDays: attendance.attendedDays,
    absentDays: attendance.absentDays,
    lateCount: attendance.lateCount,
    paidLeaveDays: leave.paidLeaveDays,
    unpaidLeaveDays: leave.unpaidLeaveDays,
    approvedOvertimeHours: overtime.approvedOvertimeHours,
    requestedOvertimeHours: overtime.requestedOvertimeHours,
    overtimeRequests: overtime.requests,
  };
}

/**
 * Turn a monthly summary into the automatic line items payroll adds.
 *
 * Line keys are snake_case (`basis_value`, `basis_unit`) so one shape serves the
 * database insert, the API response and the TypeScript type. They started as
 * camelCase and the response then disagreed with the declared type: the client
 * read `basis_value`, got undefined, and the payslip rendered "22 days" in the
 * label with an empty basis next to it.
 *
 * A zero working-day count is not an error the caller should have to handle: an
 * employee who joined and left mid-month, or an org that worked zero days, would
 * otherwise divide by zero and produce Infinity, which becomes NaN in the SQL
 * parameter and a corrupt salary row. There is simply nothing to prorate against,
 * so no automatic line is produced and `workingDays: 0` is returned so the
 * payslip can say why it is empty rather than silently showing nothing.
 */
export function computeAutomaticLines({ summary, basicSalary, policy = summary?.policy }) {
  if (!policy) throw new ApiError(409, "Payroll policy is not configured. Configure and confirm the organization's payroll policy first.");
  const basic = Number(basicSalary) || 0;
  const workingDays = Number(summary.workingDays) || 0;
  const lines = [];
  const divisor = policy.daily_rate_basis === "calendar_days" ? Number(summary.calendarDays) :
    policy.daily_rate_basis === "fixed_30" ? 30 : workingDays;
  if (divisor <= 0 || basic <= 0) return {
    lines, perDayRate: 0, hourlyRate: 0, totalDeduction: 0, totalAddition: 0,
    workingDays, divisor, skipReason: divisor <= 0 ? "no_working_days" : "no_basic_salary",
  };
  const perDayRate = money(basic / divisor);
  const perDayHours = Number(policy.hours_per_workday);
  const hourlyRate = perDayHours > 0 ? money(perDayRate / perDayHours) : 0;
  const unpaid = Number(summary.unpaidLeaveDays || 0);
  const absent = Number(summary.absentDays || 0);
  if (Number(policy.deduct_unpaid_leave) === 1 && unpaid > 0) lines.push({
    label: `Unpaid leave (${unpaid} day${unpaid === 1 ? "" : "s"} x ${perDayRate} per ${policy.daily_rate_basis} day)`,
    type: "deduction", source: "auto_unpaid_leave", amount: money(perDayRate * unpaid), basis_value: unpaid, basis_unit: "days",
  });
  if (Number(policy.deduct_absences) === 1 && absent > 0) lines.push({
    label: `Absence (${absent} day${absent === 1 ? "" : "s"} x ${perDayRate} per ${policy.daily_rate_basis} day)`,
    type: "deduction", source: "auto_absenteeism", amount: money(perDayRate * absent), basis_value: absent, basis_unit: "days",
  });
  const threshold = Number(policy.late_arrivals_per_penalty);
  const lateUnits = threshold > 0 ? Math.floor(Number(summary.lateCount || 0) / threshold) : 0;
  const penaltyDays = Number(policy.late_penalty_days);
  if (Number(policy.deduct_late_arrivals) === 1 && lateUnits > 0 && penaltyDays > 0) lines.push({
    label: `Late arrivals (${summary.lateCount} arrivals; ${penaltyDays} day per ${threshold} arrivals)`,
    type: "deduction", source: "auto_late", amount: money(perDayRate * penaltyDays * lateUnits), basis_value: Number(summary.lateCount), basis_unit: "late_arrivals",
  });
  const overtimeHours = Number(policy.pay_approved_overtime) === 1 ? Number(summary.approvedOvertimeHours || 0) : 0;
  const multiplier = Number(policy.overtime_multiplier);
  if (overtimeHours > 0 && multiplier > 0) lines.push({
    label: `Approved overtime (${overtimeHours} hr x ${multiplier} x ${hourlyRate}/hr)`,
    type: "earning", source: "auto_overtime", amount: money(hourlyRate * multiplier * overtimeHours), basis_value: overtimeHours, basis_unit: "hours",
  });
  const totalDeduction = money(lines.filter((l) => l.type === "deduction").reduce((sum, line) => sum + line.amount, 0));
  const totalAddition = money(lines.filter((l) => l.type === "earning").reduce((sum, line) => sum + line.amount, 0));
  return { lines, perDayRate, hourlyRate, perDayHours, totalDeduction, totalAddition, workingDays, divisor, skipReason: null };
}

/** Persist the automatic lines against a just-inserted salary record. */
export async function insertSalaryRecordLines({ conn, recordUuid, orgId, employeeUuid, month, year, lines }) {
  for (const line of lines) {
    await conn.query(
      `INSERT INTO salary_record_lines
         (uuid, salary_record_uuid, organization_id, employee_uuid, month, year,
          label, type, source, amount, basis_value, basis_unit, created_at)
       VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        recordUuid,
        orgId,
        employeeUuid,
        month,
        year,
        line.label,
        line.type,
        line.source,
        line.amount,
        line.basis_value ?? null,
        line.basis_unit ?? null,
      ],
    );
  }
}

function timeToMinutes(value) {
  const match = String(value ?? "").match(/^(\d{2}):(\d{2})(?::\d{2})?$/);
  if (!match) throw new ApiError(409, "Payroll policy has no valid shift start time. An organization administrator must configure it before payroll preview or generation.");
  return Number(match[1]) * 60 + Number(match[2]);
}
