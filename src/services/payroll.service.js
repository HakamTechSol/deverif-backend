import ApiError from "../utils/ApiError.js";
import { pool } from "../config/db.js";
import { assertUuid } from "../utils/publicResponse.js";

/**
 * Payroll's view of what actually happened in a month.
 *
 * Payroll used to be a manual ledger: it read a basic salary and a list of
 * allowance/deduction components and stopped there. Leave and attendance were
 * fully built and never connected to money, so an employee could take unpaid
 * leave, never clock in, and work overtime and still be paid identically to a
 * colleague who did none of it. This module is the join.
 *
 * EVERY NUMBER HERE IS DERIVED FROM A DAY COUNT, WHICH MEANS THE DENOMINATOR IS
 * THE WHOLE GAME. The per-day rate is basic / working_days, and working_days is
 * the only thing standing between "you were 4 days short" and "you lost two days
 * of pay every week because the schema has no holiday calendar". So the working
 * day count is computed from the org's own configured week and holiday table,
 * never from a hardcoded 30 and never from raw calendar days.
 */

/** Default week when an organization has no work_week_config row: Mon-Fri. */
const DEFAULT_WEEK = { mon: 1, tue: 1, wed: 1, thu: 1, fri: 1, sat: 0, sun: 0 };

const WEEK_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/** JS getDay(): 0=Sunday. Maps onto the work_week_config column names. */
const DAY_KEY = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/**
 * Late arrival cutoff, in minutes past midnight.
 *
 * Matches the existing definition in orgDashboardAnalytics.controller.js, which
 * counts a check-in after 09:30 as late. Two different answers to "was this
 * person late" would make the dashboard and the payslip disagree about the same
 * day, which is worse than either number being wrong.
 */
const LATE_AFTER_MINUTES = 9 * 60 + 30;

/** Every 3 late arrivals costs half a day's pay. */
const LATES_PER_HALF_DAY = 3;

/** Overtime is paid at this multiple of the hourly rate derived from basic. */
const OVERTIME_RATE_MULTIPLIER = 1.5;

export const PAYROLL_RULES = {
  LATE_AFTER_MINUTES,
  LATES_PER_HALF_DAY,
  OVERTIME_RATE_MULTIPLIER,
  OVERTIME_RATE_LABEL: `${OVERTIME_RATE_MULTIPLIER}x`,
  DEFAULT_WORK_WEEK: "mon-fri",
};

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
 * This organization's working week, falling back to Mon-Fri.
 *
 * A missing row resolves to the default rather than to "no working days", because
 * a zero denominator would make the per-day rate infinite and the whole payroll
 * for the employee meaningless. Failing closed to zero here would be the single
 * worst possible default for a payroll feature.
 */
export async function getWorkWeek(orgId, conn = pool) {
  const [rows] = await conn.query(
    "SELECT mon,tue,wed,thu,fri,sat,sun FROM work_week_config WHERE organization_id=?",
    [orgId],
  );
  if (!rows.length) return { ...DEFAULT_WEEK };
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
 * mysql2 hands DATE columns back as a JS Date at LOCAL midnight - '2026-10-01'
 * on a UTC+5 server arrives as 2026-09-30T19:00:00Z. Calling toISOString() on
 * that converts to UTC and silently shifts the calendar day BACKWARDS by one,
 * which in this module is not cosmetic: a holiday stored as 1 October stops
 * matching, leave lands on the wrong days, and attendance rows attach to the
 * wrong date. Every one of those produces a wrong pay figure rather than an
 * error, so the reading has to be local.
 *
 * DATETIME columns are unaffected: they carry a real time of day and nothing
 * here normalises them.
 */
function isoDate(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  // A string (dateStrings, or a driver configured otherwise) is already ISO.
  return String(value).slice(0, 10);
}

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
export async function getAttendanceForMonth({ employeeUuid, month, year, workingDates, excludedDates, conn = pool }) {
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
    if (minutesPastMidnight(r.check_in_at) > LATE_AFTER_MINUTES) lateCount += 1;
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
export async function getMonthlyAttendanceAndLeaveSummary({ employeeUuid, orgId, month, year, conn = pool }) {
  const { m, y } = assertMonthYear(month, year);
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
    conn,
  });

  const overtime = await getApprovedOvertimeForMonth({ employeeUuid, month: m, year: y, conn });

  return {
    month: m,
    year: y,
    workingDays: calendar.workingDays,
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
export function computeAutomaticLines({ summary, basicSalary }) {
  const basic = Number(basicSalary) || 0;
  const workingDays = Number(summary.workingDays) || 0;
  const lines = [];

  if (workingDays <= 0 || basic <= 0) {
    return {
      lines: [],
      perDayRate: 0,
      hourlyRate: 0,
      totalDeduction: 0,
      totalAddition: 0,
      workingDays,
      skipReason: workingDays <= 0 ? "no_working_days" : "no_basic_salary",
    };
  }

  const perDayRate = money(basic / workingDays);
  // Hours per working day is a payroll policy constant. 8 is stated rather than
  // derived because nothing in the schema records a shift length, and inventing
  // one from the attendance logs would make the overtime rate depend on whether
  // someone remembered to clock out on time.
  const perDayHours = 8;
  const hourlyRate = money(perDayRate / perDayHours);

  // --- 1. Unpaid leave and absence, at the same per-day rate -------------------
  //
  // Combined deliberately: an unpaid day and an unexplained absence cost the
  // company exactly the same amount of work, and keeping them as one figure is
  // what lets the payslip state the rule rather than two rules. The summary keeps
  // them separate so the breakdown can still explain WHICH it was.
  const unpaidDayCount = Number(summary.unpaidLeaveDays || 0) + Number(summary.absentDays || 0);
  if (unpaidDayCount > 0) {
    lines.push({
      label: `Unpaid leave & absence (${unpaidDayCount} day${unpaidDayCount === 1 ? "" : "s"})`,
      type: "deduction",
      source: Number(summary.unpaidLeaveDays) > 0 ? "auto_unpaid_leave" : "auto_absenteeism",
      amount: money(perDayRate * unpaidDayCount),
      basis_value: unpaidDayCount,
      basis_unit: "days",
    });
  }

  // --- 2. Late arrival penalty: every 3 lates = half a day ----------------------
  //
  // Whole half-days only. Rounding a partial set of lates to the nearest half
  // would let two lates cost nearly half a day and three cost exactly half,
  // which is a penalty that gets CHEAPER by being late more often.
  const halfDayUnits = Math.floor(Number(summary.lateCount || 0) / LATES_PER_HALF_DAY);
  if (halfDayUnits > 0) {
    lines.push({
      label: `Late arrival penalty (${summary.lateCount} late${summary.lateCount === 1 ? "" : "s"})`,
      type: "deduction",
      source: "auto_late",
      amount: money(perDayRate * 0.5 * halfDayUnits),
      basis_value: Number(summary.lateCount),
      basis_unit: "late_arrivals",
    });
  }

  // --- 3. Approved overtime ----------------------------------------------------
  const overtimeHours = Number(summary.approvedOvertimeHours || 0);
  if (overtimeHours > 0) {
    lines.push({
      label: `Overtime (${overtimeHours} hr @ ${PAYROLL_RULES.OVERTIME_RATE_LABEL} hourly)`,
      type: "earning",
      source: "auto_overtime",
      amount: money(hourlyRate * OVERTIME_RATE_MULTIPLIER * overtimeHours),
      basis_value: overtimeHours,
      basis_unit: "hours",
    });
  }

  const totalDeduction = money(lines.filter((l) => l.type === "deduction").reduce((s, l) => s + l.amount, 0));
  const totalAddition = money(lines.filter((l) => l.type === "earning").reduce((s, l) => s + l.amount, 0));

  return {
    lines,
    perDayRate,
    hourlyRate,
    perDayHours,
    totalDeduction,
    totalAddition,
    workingDays,
    skipReason: null,
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