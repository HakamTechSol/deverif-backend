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
 * Monthly payroll uses the organization's explicit per-date working/off-day calendar,
 * actual attendance timestamps, shift timings, and final approved leave treatment.
 */

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
/**
 * Basic salary earned in a month when one or more salary periods overlap it.
 * Each monthly salary is prorated by the number of calendar days it was effective.
 * This keeps a 1 November increment out of October payroll and splits a mid-month
 * increment fairly across the old and new rates.
 */
export function prorateSalaryPeriods({ salaryPeriods, month, year, joiningDate = null }) {
  const { m, y } = assertMonthYear(month, year);
  const { firstDay, lastDay } = monthBounds(m, y);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const dayNumber = (iso) => Date.parse(`${iso}T00:00:00Z`) / 86400000;
  let total = 0;

  for (const period of salaryPeriods ?? []) {
    const start = isoDate(period.effective_from);
    const end = period.effective_to == null ? lastDay : isoDate(period.effective_to);
    const employmentStart = joiningDate ? isoDate(joiningDate) : firstDay;
    const monthStart = start > firstDay ? start : firstDay;
    const overlapStart = monthStart > employmentStart ? monthStart : employmentStart;
    const overlapEnd = end < lastDay ? end : lastDay;
    if (overlapStart > overlapEnd) continue;

    const days = dayNumber(overlapEnd) - dayNumber(overlapStart) + 1;
    total += Number(period.basic_salary) * (days / daysInMonth);
  }

  return money(total);
}

/** Keep only working dates that have occurred as of the payroll run date. */
export function filterWorkingDatesFrom(workingDates, startDate) {
  if (!startDate) return [...(workingDates ?? [])];
  const firstEligibleDate = isoDate(startDate);
  return (workingDates ?? []).filter((date) => date >= firstEligibleDate);
}

export function filterWorkingDatesThrough(workingDates, asOfDate) {
  return (workingDates ?? []).filter((date) => date <= asOfDate);
}

/** Current calendar date in the organization's Pakistan business timezone. */
function payrollAsOfDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Karachi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

/** Return the calendar-day prorated basic salary for a payroll month. */
export async function proratedBasicForMonth({ employeeUuid, month, year, joiningDate = null, conn = pool }) {
  const { m, y } = assertMonthYear(month, year);
  const { firstDay, lastDay } = monthBounds(m, y);
  const [salaryPeriods] = await conn.query(
    `SELECT basic_salary, effective_from, effective_to
       FROM employee_salary_history
      WHERE employee_uuid=?
        AND effective_from <= ?
        AND (effective_to IS NULL OR effective_to >= ?)
      ORDER BY effective_from ASC`,
    [employeeUuid, lastDay, firstDay],
  );
  return prorateSalaryPeriods({ salaryPeriods, month: m, year: y, joiningDate });
}

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

// `currency` is NOT one of these. It was, when administrators could type a
// three-letter code, and its absence here is the point: a currency is no longer
// something an administrator confirms, so a NULL left over from before this
// change must not keep blocking payroll. CURRENCY is applied below instead.
export async function getPayrollSettings(orgId, conn = pool, month = null, year = null) {
  let rows = [];
  if (month !== null && year !== null) {
    [rows] = await conn.query(
      "SELECT * FROM organization_monthly_payroll_settings WHERE organization_id=? AND month=? AND year=?",
      [orgId, month, year],
    );
  }
  if (!rows.length) {
    [rows] = await conn.query(
      "SELECT * FROM organization_payroll_settings WHERE organization_id=?",
      [orgId],
    );
  }
  if (!rows.length) throw new ApiError(409, "Payroll settings are not configured. Select a salary calculation method and configure the organization shift times.");
  const settings = rows[0];
  const salaryCalculationPolicy = normalizePayrollPolicy(
    settings.salary_calculation_policy,
    settings.salary_calculation_method,
  );
  const start = timeToMinutes(settings.shift_start_time);
  const end = timeToMinutes(settings.shift_end_time);
  const shiftHours = end > start ? (end - start) / 60 : 0;
  if (shiftHours <= 0) throw new ApiError(409, "Organization check-out time must be later than shift start time.");
  return {
    ...settings,
    salary_calculation_policy: salaryCalculationPolicy,
    salary_calculation_method: payrollAttendanceBasis(salaryCalculationPolicy),
    hours_per_workday: shiftHours,
    currency: CURRENCY,
  };
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
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

const MAX_PAYROLL_AMOUNT = 999999999999.99;

export const PAYROLL_POLICIES = Object.freeze([
  "working_days_only",
  "working_days_and_hours",
  "number_of_days_only",
  "number_of_days_and_hours",
]);

export function normalizePayrollPolicy(policy, legacyMethod = "days") {
  if (PAYROLL_POLICIES.includes(policy)) return policy;
  if (policy !== undefined && policy !== null) {
    throw new ApiError(400, "Select one of the four supported payroll policies.");
  }
  if (legacyMethod === "hours") return "working_days_and_hours";
  if (legacyMethod === "days") return "working_days_only";
  throw new ApiError(400, "Select one of the four supported payroll policies.");
}

export function payrollAttendanceBasis(policy) {
  return policy.endsWith("_hours") ? "hours" : "days";
}

/** Shared component and net-pay calculation used by payroll previews and runs. */
export function calculatePayrollAmounts({
  basicSalary,
  components = [],
  monthlyVariables = [],
  automaticLines = [],
  overtimeAmount = 0,
  expenseReimbursement = 0,
  selectedComponentUuids,
}) {
  const basic = Number(basicSalary);
  if (!Number.isFinite(basic) || basic < 0 || basic > MAX_PAYROLL_AMOUNT) {
    throw new ApiError(409, "Basic salary must be a finite non-negative amount.");
  }
  const selected = selectedComponentUuids === undefined
    ? null
    : new Set(selectedComponentUuids);
  const available = new Set(components.map((component) => component.assignment_uuid));
  if (selected && [...selected].some((uuid) => !available.has(uuid))) {
    throw new ApiError(400, "Selected salary components must be active assignments for this employee.");
  }

  const lines = [];
  let allowanceTotal = 0;
  let deductionTotal = 0;
  const addLine = (line, label) => {
    const amount = Number(line.amount);
    if (!Number.isFinite(amount) || amount < 0 || amount > MAX_PAYROLL_AMOUNT) {
      throw new ApiError(409, `${label} must be a finite non-negative amount.`);
    }
    if (line.type !== "allowance" && line.type !== "deduction") {
      throw new ApiError(409, `${label} has an invalid salary component type.`);
    }
    const rounded = money(amount);
    const normalized = {
      label: String(line.label ?? label),
      type: line.type === "deduction" ? "deduction" : "earning",
      source: line.source,
      amount: rounded,
      basis_value: line.basis_value ?? null,
      basis_unit: line.basis_unit ?? null,
      ...(line.assignment_uuid ? { assignment_uuid: line.assignment_uuid } : {}),
    };
    lines.push(normalized);
    if (line.type === "deduction") deductionTotal += rounded;
    else allowanceTotal += rounded;
  };

  for (const component of components) {
    if (selected && !selected.has(component.assignment_uuid)) continue;
    if (typeof component.assignment_uuid !== "string" || !component.assignment_uuid) {
      throw new ApiError(409, "An assigned salary component is missing its assignment identifier.");
    }
    if (component.type !== "allowance" && component.type !== "deduction") {
      throw new ApiError(409, "An assigned salary component has an invalid type.");
    }
    const amount = Number(component.amount);
    if (!Number.isFinite(amount) || amount < 0) {
      throw new ApiError(409, `Salary component "${component.name}" has an invalid amount.`);
    }
    const percentage = component.is_percentage === true
      || component.is_percentage === 1
      || component.is_percentage === "1";
    if (![true, false, 0, 1, "0", "1"].includes(component.is_percentage)) {
      throw new ApiError(409, `Salary component "${component.name}" has an invalid calculation type.`);
    }
    addLine({
      label: component.name,
      type: component.type,
      source: "component",
      amount: percentage ? basic * amount / 100 : amount,
      assignment_uuid: component.assignment_uuid,
    }, component.name);
  }

  for (const variable of monthlyVariables) {
    addLine({
      label: variable.label,
      type: variable.type,
      source: "monthly_variable",
      amount: variable.amount,
    }, variable.label);
  }
  for (const line of automaticLines) {
    const type = line.type === "deduction" ? "deduction" : line.type === "earning" ? "allowance" : null;
    if (!type) throw new ApiError(409, "An automatic payroll line has an invalid type.");
    addLine({ ...line, type }, line.label);
  }

  const overtime = Number(overtimeAmount);
  const reimbursement = Number(expenseReimbursement);
  if (!Number.isFinite(overtime) || overtime < 0 || overtime > MAX_PAYROLL_AMOUNT) {
    throw new ApiError(400, "Overtime amount must be a finite non-negative amount.");
  }
  if (!Number.isFinite(reimbursement) || reimbursement < 0 || reimbursement > MAX_PAYROLL_AMOUNT) {
    throw new ApiError(409, "Expense reimbursement must be a finite non-negative amount.");
  }
  if (overtime > 0) addLine({
    label: "Overtime",
    type: "allowance",
    source: "manual_overtime",
    amount: overtime,
  }, "Overtime");
  if (reimbursement > 0) addLine({
    label: "Expense reimbursement",
    type: "allowance",
    source: "auto_expense",
    amount: reimbursement,
  }, "Expense reimbursement");

  const allowances = money(allowanceTotal);
  const deductions = money(deductionTotal);
  const expense = money(reimbursement);
  const net = money(basic + allowances - deductions);
  if ([allowances, deductions, expense, net].some((amount) => amount > MAX_PAYROLL_AMOUNT)) {
    throw new ApiError(409, "Calculated payroll exceeds the maximum supported money amount.");
  }
  if (net < 0) {
    throw new ApiError(409, `Calculated net salary is negative (${net.toFixed(2)}). Review the salary components and deductions.`);
  }
  return { allowances: money(allowances - expense), deductions, expenseReimbursement: expense, net, lines };
}

/**
 * Working days in a month: the org's configured weekdays, minus holidays.
 *
 * Returned with the set of non-working dates so callers can subtract leave and
 * absence without re-deriving it.
 */
export async function getWorkingDaysForMonth({ orgId, month, year, scheduleOverride, conn = pool }) {
  const { m, y } = assertMonthYear(month, year);
  const { firstDay, lastDay } = monthBounds(m, y);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (scheduleOverride !== undefined) {
    const schedule = normalizePayrollRunSchedule(scheduleOverride, m, y);
    const workingDates = schedule.filter((day) => day.day_type === "working").map((day) => day.date);
    const nonWorkingDates = new Set(schedule.filter((day) => day.day_type === "off").map((day) => day.date));
    return { workingDays: workingDates.length, workingDates, nonWorkingDates, week: null, holidays: new Set() };
  }
  const [rows] = await conn.query(
    "SELECT schedule_date, day_type FROM organization_monthly_work_schedules WHERE organization_id=? AND schedule_date BETWEEN ? AND ?",
    [orgId, firstDay, lastDay],
  );
  if (rows.length !== daysInMonth) {
    const configured = new Set(rows.map((row) => isoDate(row.schedule_date)));
    const missingDates = Array.from({ length: daysInMonth }, (_, index) =>
      `${y}-${String(m).padStart(2, "0")}-${String(index + 1).padStart(2, "0")}`,
    ).filter((date) => !configured.has(date));
    throw new ApiError(
      409,
      `Monthly working schedule is incomplete for ${y}-${String(m).padStart(2, "0")}. Missing date(s): ${missingDates.slice(0, 10).join(", ")}${missingDates.length > 10 ? ", ..." : ""}. Configure every date as a working day or off day.`,
    );
  }
  const days = rows.filter((r) => r.day_type === "working").map((r) => isoDate(r.schedule_date));
  const nonWorkingDates = new Set(rows.filter((r) => r.day_type === "off").map((r) => isoDate(r.schedule_date)));
  return { workingDays: days.length, workingDates: days, nonWorkingDates, week: null, holidays: new Set() };
}

export async function getWorkingDatesBetween({ orgId, startDate, endDate, conn = pool }) {
  const workingDates = new Set();
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  if (
    typeof startDate !== "string"
    || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)
    || typeof endDate !== "string"
    || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)
    || Number.isNaN(start.getTime())
    || Number.isNaN(end.getTime())
    || start.toISOString().slice(0, 10) !== startDate
    || end.toISOString().slice(0, 10) !== endDate
    || startDate > endDate
  ) {
    throw new ApiError(400, "A valid working-date range is required.");
  }
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  while (cursor <= end) {
    const calendar = await getWorkingDaysForMonth({
      orgId,
      month: cursor.getUTCMonth() + 1,
      year: cursor.getUTCFullYear(),
      conn,
    });
    for (const date of calendar.workingDates) {
      if (date >= startDate && date <= endDate) workingDates.add(date);
    }
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return [...workingDates].sort();
}

export function normalizePayrollRunSchedule(days, month, year) {
  const { m, y } = assertMonthYear(month, year);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (!Array.isArray(days) || days.length !== daysInMonth) {
    throw new ApiError(400, "Select every date in the month as either a working day or an off day.");
  }
  const expectedDates = Array.from({ length: daysInMonth }, (_, index) =>
    `${y}-${String(m).padStart(2, "0")}-${String(index + 1).padStart(2, "0")}`,
  );
  const expected = new Set(expectedDates);
  const byDate = new Map();
  for (const item of days) {
    if (
      !item ||
      typeof item.date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(item.date) ||
      !["working", "off"].includes(item.day_type)
    ) {
      throw new ApiError(400, "Each schedule day needs a valid date and working/off selection.");
    }
    if (!expected.has(item.date) || byDate.has(item.date)) {
      throw new ApiError(400, "Schedule dates must be unique and belong to the selected month.");
    }
    byDate.set(item.date, item.day_type);
  }
  return expectedDates.map((date) => ({ date, day_type: byDate.get(date) }));
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
    `SELECT lr.uuid, lr.start_date, lr.end_date, lr.day_portion, lr.approved_days,
            lt.name AS leave_type,
            COALESCE(lr.approved_treatment, lr.requested_treatment, 'unpaid') AS treatment
       FROM leave_requests lr
       JOIN leave_types lt ON lt.id = lr.leave_type_id
      WHERE lr.employee_uuid=?
        AND lr.status='approved'
        AND lr.start_date <= ?
        AND lr.end_date >= ?`,
    [employeeUuid, lastDay, firstDay],
  );

  const working = new Set(workingDates);
  const paidDays = new Map();
  const unpaidDays = new Map();
  const calculationRequests = [];

  for (const r of rows) {
    const target = String(r.treatment) === "unpaid" ? unpaidDays : paidDays;
    const start = isoDate(r.start_date) < firstDay ? firstDay : isoDate(r.start_date);
    const end = isoDate(r.end_date) > lastDay ? lastDay : isoDate(r.end_date);
    const cursor = new Date(`${start}T00:00:00Z`);
    const stop = new Date(`${end}T00:00:00Z`);
    let requestDays = 0;
    while (cursor <= stop) {
      const iso = cursor.toISOString().slice(0, 10);
      if (working.has(iso)) {
        const fraction = r.day_portion === "full" ? 1 : 0.5;
        target.set(iso, Math.min(1, (target.get(iso) || 0) + fraction));
        requestDays += fraction;
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    calculationRequests.push({
      uuid: r.uuid,
      leave_type: r.leave_type,
      treatment: r.treatment,
      start_date: isoDate(r.start_date),
      end_date: isoDate(r.end_date),
      day_portion: r.day_portion || "full",
      days_in_period: requestDays,
    });
  }

  // Paid leave takes precedence for legacy overlapping rows so a single
  // scheduled day can never receive both a leave credit and a deduction.
  for (const date of paidDays.keys()) unpaidDays.delete(date);

  return {
    paidLeaveDays: [...paidDays.values()].reduce((sum, days) => sum + days, 0),
    unpaidLeaveDays: [...unpaidDays.values()].reduce((sum, days) => sum + days, 0),
    paidDates: [...paidDays.keys()].sort(),
    unpaidDates: [...unpaidDays.keys()].sort(),
    excludedDayFractions: Object.fromEntries([...paidDays, ...unpaidDays]),
    paidDaysByDate: Object.fromEntries(paidDays),
    unpaidDaysByDate: Object.fromEntries(unpaidDays),
    calculationRequests,
    requests: rows,
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
export async function getAttendanceForMonth({ employeeUuid, month, year, workingDates, excludedDates, excludedDayFractions = null, lateCutoffMinutes = null, overtimeCutoffMinutes = null, excludeOvertimeFromRegularHours = false, conn = pool }) {
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
  const excusedFractions = excludedDayFractions ?? Object.fromEntries([...excused].map((date) => [date, 1]));

  const presentDates = new Set();
  const recordDates = new Set();
  let lateCount = 0;
  let workedHours = 0;
  let actualOvertimeHours = 0;
  const actualOvertimeByDate = {};

  for (const r of rows) {
    const iso = isoDate(r.date);
    if (!working.has(iso)) continue;
    recordDates.add(iso);
    // A workday is complete only when both clock-in and clock-out exist.
    // If a completed attendance record overlaps approved leave, the attendance
    // record wins: the day is treated as worked, not as leave or absence.
    // A check-in-only row must not be treated as a full paid day in days mode.
    if (!r.check_in_at || !r.check_out_at) continue;
    const start = new Date(r.check_in_at).getTime();
    const end = new Date(r.check_out_at).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    presentDates.add(iso);
    const elapsedHours = (end - start) / 3600000;
    let overtimeForDate = 0;
    if (overtimeCutoffMinutes !== null) {
      const checkout = minutesPastMidnight(r.check_out_at);
      if (checkout !== null && checkout > Number(overtimeCutoffMinutes)) {
        overtimeForDate = (checkout - Number(overtimeCutoffMinutes)) / 60;
        actualOvertimeHours += overtimeForDate;
        actualOvertimeByDate[iso] = overtimeForDate;
      }
    }
    // Overtime is a separate earning only when enabled; otherwise all elapsed
    // attendance hours remain part of the working-hours salary calculation.
    workedHours += Math.max(0, elapsedHours - (excludeOvertimeFromRegularHours ? overtimeForDate : 0));
    if (lateCutoffMinutes !== null && minutesPastMidnight(r.check_in_at) > Number(lateCutoffMinutes)) lateCount += 1;
  }

  // Absence = working days, less days with a record, less days excused by leave.
  // Never negative: a manually entered attendance row can otherwise push this
  // below zero and then a negative day count becomes a negative deduction, which
  // reads as a pay rise.
  const excusedCount = [...excused].reduce((sum, date) => {
    if (!working.has(date) || presentDates.has(date)) return sum;
    return sum + Math.min(1, Math.max(0, Number(excusedFractions[date]) || 0));
  }, 0);
  const absentDays = Math.max(0, working.size - presentDates.size - excusedCount);

  return {
    attendedDays: presentDates.size,
    workedHours: Math.round(workedHours * 100) / 100,
    actualOvertimeHours: Math.round(actualOvertimeHours * 100) / 100,
    actualOvertimeByDate,
    absentDays,
    lateCount,
    presentDates: [...presentDates].sort(),
    recordDates: [...recordDates].sort(),
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
    requests: rows,
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
export async function getMonthlyAttendanceAndLeaveSummary({ employeeUuid, orgId, month, year, joiningDate = null, policy = null, scheduleOverride, conn = pool }) {
  const { m, y } = assertMonthYear(month, year);
  const activePolicy = policy ?? await getPayrollSettings(orgId, conn, m, y);
  const calendar = await getWorkingDaysForMonth({ orgId, month: m, year: y, scheduleOverride, conn });
  // A new employee is not eligible for scheduled days before their joining date.
  // Clamp the employee-specific payroll calendar without changing the org's
  // shared monthly schedule, then exclude future dates from absence/hour checks.
  const eligibleWorkingDates = filterWorkingDatesFrom(calendar.workingDates, joiningDate);
  const elapsedWorkingDates = filterWorkingDatesThrough(eligibleWorkingDates, payrollAsOfDate());

  const leave = await getApprovedLeaveForMonth({
    employeeUuid,
    month: m,
    year: y,
    workingDates: elapsedWorkingDates,
    conn,
  });

  const attendance = await getAttendanceForMonth({
    employeeUuid,
    month: m,
    year: y,
    workingDates: elapsedWorkingDates,
    // BOTH kinds of leave excuse the day. Paid leave is not a deduction, but the
    // employee still did not clock in, so without this a paid sick-leave day is
    // counted as an absence and docked. That is the bug this argument prevents.
    excludedDates: [...leave.paidDates, ...leave.unpaidDates],
    excludedDayFractions: leave.excludedDayFractions,
    lateCutoffMinutes:
      timeToMinutes(activePolicy.shift_start_time) + Number(activePolicy.late_grace_minutes ?? 10),
    overtimeCutoffMinutes: timeToMinutes(activePolicy.shift_end_time),
    excludeOvertimeFromRegularHours: Number(activePolicy.calculate_overtime) === 1,
    conn,
  });

  const overtime = await getApprovedOvertimeForMonth({ employeeUuid, month: m, year: y, conn });
  const attended = new Set(attendance.presentDates);
  const paidLeaveDays = Object.entries(leave.paidDaysByDate)
    .filter(([date]) => !attended.has(date))
    .reduce((sum, [, days]) => sum + Number(days), 0);
  const unpaidLeaveDays = Object.entries(leave.unpaidDaysByDate)
    .filter(([date]) => !attended.has(date))
    .reduce((sum, [, days]) => sum + Number(days), 0);
  const recorded = new Set(attendance.recordDates);
  const { firstDay, lastDay } = monthBounds(m, y);
  const workingDateSet = new Set(elapsedWorkingDates);
  const leaveAttendanceConflicts = leave.calculationRequests.flatMap((request) => {
    const dates = [];
    const start = request.start_date < firstDay ? firstDay : request.start_date;
    const end = request.end_date > lastDay ? lastDay : request.end_date;
    const cursor = new Date(`${start}T00:00:00Z`);
    const stop = new Date(`${end}T00:00:00Z`);
    while (cursor <= stop) {
      const date = cursor.toISOString().slice(0, 10);
      if (recorded.has(date) && workingDateSet.has(date)) dates.push(date);
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return dates.map((date) => ({
      date,
      leave_request_uuid: request.uuid,
      leave_type: request.leave_type,
      treatment: request.treatment,
      day_portion: request.day_portion,
      resolution: attended.has(date) ? "attendance_takes_precedence" : "attendance_record_present",
    }));
  });

  return {
    month: m,
    year: y,
    workingDays: eligibleWorkingDates.length,
    // The org's scheduled working days for the WHOLE month. Kept separate from
    // `workingDays`, which is clamped to the employee's joining date and is what
    // the daily/hourly rate and deductions are based on.
    monthWorkingDays: calendar.workingDays,
    elapsedWorkingDays: elapsedWorkingDates.length,
    calendarDays: new Date(Date.UTC(y, m, 0)).getUTCDate(),
    joiningDate: joiningDate ? isoDate(joiningDate) : null,
    policy: activePolicy,
    holidayCount: calendar.holidays.size,
    week: calendar.week,
    attendedDays: attendance.attendedDays,
    workedHours: attendance.workedHours,
    absentDays: attendance.absentDays,
    lateCount: attendance.lateCount,
    paidLeaveDays,
    unpaidLeaveDays,
    leaveAttendanceConflicts,
    leaveCalculation: {
      paid_leave_days: paidLeaveDays,
      unpaid_leave_days: unpaidLeaveDays,
      requests: leave.calculationRequests,
      attendance_conflicts: leaveAttendanceConflicts,
    },
    approvedOvertimeHours: money(overtime.requests.reduce((sum, request) => {
      const date = isoDate(request.work_date);
      return sum + Math.min(Number(request.approved_hours) || 0, Number(attendance.actualOvertimeByDate[date]) || 0);
    }, 0)),
    actualOvertimeHours: attendance.actualOvertimeHours,
    requestedOvertimeHours: overtime.requestedOvertimeHours,
    overtimeRequests: overtime.requests.length,
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
 * A zero selected salary denominator or zero shift duration is rejected before
 * rate calculation, rather than producing Infinity/NaN or a plausible-looking
 * zero-pay line.
 */
export function computeAutomaticLines({ summary, basicSalary, policy = summary?.policy }) {
  if (!policy) throw new ApiError(409, "Payroll settings are not configured.");
  const basic = Number(basicSalary);
  if (!Number.isFinite(basic) || basic < 0) throw new ApiError(409, "Basic salary must be a finite non-negative amount.");
  const workingDays = Number(summary.workingDays) || 0;
  const scheduledWorkingDays = Number(summary.monthWorkingDays ?? workingDays) || 0;
  const calendarDays = Number(summary.calendarDays) || 0;
  const shiftHours = Number(policy.hours_per_workday) || 0;
  const expectedHours = workingDays * shiftHours;
  const elapsedWorkingDays = Math.min(
    workingDays,
    Math.max(0, Number(summary.elapsedWorkingDays ?? workingDays) || 0),
  );
  const elapsedExpectedHours = elapsedWorkingDays * shiftHours;
  const paidLeaveDays = Number(summary.paidLeaveDays) || 0;
  const unpaidLeaveDays = Number(summary.unpaidLeaveDays) || 0;
  const attendedDays = Number(summary.attendedDays) || 0;
  const absentDays = Number(summary.absentDays) || 0;
  const lateCount = Number(summary.lateCount) || 0;
  const payrollPolicy = normalizePayrollPolicy(
    policy.salary_calculation_policy,
    policy.salary_calculation_method || "days",
  );
  const method = payrollAttendanceBasis(payrollPolicy);
  const calendarBased = payrollPolicy.startsWith("number_of_days_");
  const salaryDayDivisor = calendarBased ? calendarDays : scheduledWorkingDays;
  if (salaryDayDivisor <= 0 && !calendarBased) {
    throw new ApiError(409, "Payroll cannot be calculated because the monthly schedule has no working days.");
  }
  if (calendarBased && calendarDays <= 0) {
    throw new ApiError(409, "Payroll cannot be calculated because the selected month has no calendar days.");
  }
  if (method === "hours" && shiftHours <= 0) {
    throw new ApiError(409, "Payroll cannot be calculated because the configured shift duration is zero.");
  }
  const lines = [];
  if (basic <= 0) return {
    lines, perDayRate: 0, hourlyRate: 0, perDayHours: shiftHours,
    totalDeduction: 0, totalAddition: 0, workingDays, divisor: salaryDayDivisor,
    payableRatio: 0, skipReason: "no_basic_salary",
    method, payrollPolicy, expectedHours, workedHours: Number(summary.workedHours || 0),
  };

  const perDayRate = money(basic / salaryDayDivisor);
  const hourlyRate = shiftHours > 0 ? money(basic / salaryDayDivisor / shiftHours) : 0;
  let payableRatio = 1;

  if (method === "days") {
    const payableDays = Math.min(elapsedWorkingDays, attendedDays + paidLeaveDays);
    payableRatio = elapsedWorkingDays > 0 ? payableDays / elapsedWorkingDays : 1;
    if (unpaidLeaveDays > 0) lines.push({
      label: `Unpaid leave (${unpaidLeaveDays} day(s))`,
      type: "deduction", source: "auto_unpaid_leave",
      amount: money(perDayRate * unpaidLeaveDays), basis_value: unpaidLeaveDays, basis_unit: "days",
    });
    if (absentDays > 0) lines.push({
      label: `Absence (${absentDays} day(s) x ${perDayRate})`,
      type: "deduction", source: "auto_absenteeism",
      amount: money(perDayRate * absentDays), basis_value: absentDays, basis_unit: "days",
    });
  } else {
    const workedHours = Number(summary.workedHours || 0);
    const creditedHours = workedHours + paidLeaveDays * shiftHours;
    payableRatio = elapsedExpectedHours > 0
      ? Math.min(1, creditedHours / elapsedExpectedHours)
      : 1;
    const unpaidAmount = money(hourlyRate * shiftHours * unpaidLeaveDays);
    const absenceAmount = money(hourlyRate * shiftHours * absentDays);
    if (unpaidAmount > 0) lines.push({
      label: `Unpaid leave (${unpaidLeaveDays} day(s), ${unpaidLeaveDays * shiftHours} hours)`,
      type: "deduction", source: "auto_unpaid_leave",
      amount: unpaidAmount, basis_value: unpaidLeaveDays * shiftHours, basis_unit: "hours",
    });
    if (absenceAmount > 0) lines.push({
      label: `Absence (${absentDays} day(s), ${absentDays * shiftHours} hours)`,
      type: "deduction", source: "auto_absenteeism",
      amount: absenceAmount, basis_value: absentDays * shiftHours, basis_unit: "hours",
    });
    // Future scheduled hours are not absences or short-hours. The hourly rate
    // still uses the FULL month divisor; only the shortfall window stops at today.
    const shortHours = Math.max(0, elapsedExpectedHours - creditedHours - unpaidLeaveDays * shiftHours - absentDays * shiftHours);
    if (shortHours > 0) lines.push({
      label: `Short working hours (${money(shortHours)} hours)`,
      type: "deduction", source: "auto_short_hours",
      amount: money(hourlyRate * shortHours), basis_value: money(shortHours), basis_unit: "hours",
    });
  }

  const lateArrivalThreshold = Number(policy.late_arrival_threshold ?? 1);
  if (
    (policy.deduct_salary_for_late_arrivals === true || Number(policy.deduct_salary_for_late_arrivals) === 1)
    && Number.isInteger(lateArrivalThreshold)
    && lateArrivalThreshold > 0
    && lateCount >= lateArrivalThreshold
  ) {
    lines.push({
      label: `Late arrivals (${lateCount})`,
      type: "deduction",
      source: "auto_late",
      amount: perDayRate,
      basis_value: lateCount,
      basis_unit: "late_arrivals",
    });
  }

  const overtimeHours = Number(policy.calculate_overtime) === 1 ? Number(summary.approvedOvertimeHours || 0) : 0;
  const multiplier = Number(policy.overtime_multiplier || 1.5);
  if (overtimeHours > 0 && hourlyRate > 0) lines.push({
    label: `Approved overtime (${overtimeHours} hr x ${multiplier} x ${hourlyRate}/hr)`,
    type: "earning", source: "auto_overtime", amount: money(hourlyRate * multiplier * overtimeHours),
    basis_value: overtimeHours, basis_unit: "hours",
  });
  const totalDeduction = money(lines.filter((l) => l.type === "deduction").reduce((sum, line) => sum + line.amount, 0));
  const totalAddition = money(lines.filter((l) => l.type === "earning").reduce((sum, line) => sum + line.amount, 0));
  return {
    lines, perDayRate, hourlyRate, perDayHours: shiftHours, totalDeduction, totalAddition,
    workingDays,
    divisor: method === "hours" ? salaryDayDivisor * shiftHours : salaryDayDivisor,
    payableRatio, skipReason: null, method, payrollPolicy, expectedHours,
    workedHours: Number(summary.workedHours || 0),
  };
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
  if (!match) throw new ApiError(409, "Organization settings have no valid shift start time. An organization administrator must configure it before payroll preview or generation.");
  return Number(match[1]) * 60 + Number(match[2]);
}
