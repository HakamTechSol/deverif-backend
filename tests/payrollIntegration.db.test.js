import { describe, it, expect, beforeAll, afterAll } from "vitest";
import dotenv from "dotenv";
import mysql from "mysql2/promise";
import {
  computeAutomaticLines,
  getMonthlyAttendanceAndLeaveSummary,
  PAYROLL_RULES,
} from "../src/services/payroll.service.js";

/**
 * THE INTEGRATION THIS MODULE EXISTS FOR.
 *
 * Leave and attendance were both fully built and neither was connected to money.
 * An employee could take four days of unpaid leave, never clock in for a week and
 * work forty overtime hours, and POST /org/payroll/generate would pay them exactly
 * as it paid a colleague who did none of it — because generatePayroll read three
 * tables (employees, employee_salary_history, employee_salary_components) and
 * never mentioned leave or attendance.
 *
 * WHY THIS IS A REAL DATABASE TEST AND NOT A MOCKED ONE.
 *
 * The whole feature turns on arithmetic that is correct in JS and wrong in SQL:
 *
 *  - The per-day rate is basic / WORKING DAYS, and working days comes from the
 *    org's configured week minus its holidays. Get that wrong and every figure is
 *    wrong, so the tests must exercise the org's actual configuration rather than a
 *    fixture that happens to be Mon-Fri.
 *
 *  - A DATE column comes back from mysql2 as a Date at LOCAL midnight. On this
 *    server (UTC+5) '2026-10-01' arrives as 2026-09-30T19:00:00Z, so reading it
 *    with toISOString() shifts the calendar day backwards. That single mistake
 *    makes a holiday silently stop matching and leaves every number plausible and
 *    wrong. A mocked pool cannot catch it, because a mock has no timezone.
 *
 * EVERY TEST GETS ITS OWN EMPLOYEE. An earlier version shared one employee across
 * the file, which made the assertions order-dependent: the unpaid-leave test saw
 * an absence count that the attendance tests had already changed, and every
 * failure after the first looked like a payroll bug when it was a fixture bug.
 * Isolation is what makes "2 unpaid leave days cost 2 days' pay" a statement
 * about payroll rather than about test ordering.
 *
 * Skipped, not failed, when no database is reachable.
 */

const HAS_DB = await (async () => {
  try {
    const c = await mysql.createConnection(readDbConfig());
    await c.query("SELECT 1");
    await c.end();
    return true;
  } catch {
    return false;
  }
})();

dotenv.config({ quiet: true });

function readDbConfig() {
  return {
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || process.env.DB_PASS || "",
    database: process.env.DB_NAME,
  };
}

const cfg = readDbConfig();

const MONTH = 10;
const YEAR = 2026;
const BASIC = 31000;
/** October 2026 has 22 weekdays under the default Mon-Fri week with no holidays. */
const WORKING_DAYS = 22;
const PER_DAY = Math.round((BASIC / WORKING_DAYS) * 100) / 100;
const HOURLY = Math.round((PER_DAY / 8) * 100) / 100;

let db;
let orgId;
let unpaidTypeId;
let paidTypeId;
const employeeUuids = [];

beforeAll(async () => {
  if (!HAS_DB) return;
  db = await mysql.createConnection(cfg);

  const [org] = await db.query("INSERT INTO organizations (uuid, name) VALUES (UUID(), ?)", [
    `Payroll Integration ${Date.now()}`,
  ]);
  orgId = org.insertId;
  await db.query("INSERT INTO work_week_config (organization_id) VALUES (?)", [orgId]);

  // The paid/unpaid split the whole deduction rule depends on. Both types exist
  // because the interesting assertion is that only ONE of them costs the employee
  // anything.
  const [unpaid] = await db.query(
    `INSERT INTO leave_types (organization_id, name, days_allowed_per_year, is_paid)
     VALUES (?, 'Unpaid Leave', 0, 'no')`,
    [orgId],
  );
  unpaidTypeId = unpaid.insertId;

  const [paid] = await db.query(
    `INSERT INTO leave_types (organization_id, name, days_allowed_per_year, is_paid)
     VALUES (?, 'Sick Leave', 0, 'yes')`,
    [orgId],
  );
  paidTypeId = paid.insertId;
});

afterAll(async () => {
  if (!db) return;
  for (const uuid of employeeUuids) {
    await db.query("DELETE FROM employees WHERE uuid=?", [uuid]);
  }
  // Left behind, this probe org would appear in an org-admin's organization
  // picker, and its leave types would look like real company configuration.
  await db.query("DELETE FROM organizations WHERE id=?", [orgId]);
  await db.end();
});

/** A fresh employee with a salary, and nothing else. No shared state. */
async function newEmployee(name = "Probe") {
  const [emp] = await db.query(
    `INSERT INTO employees (uuid, full_name, organization_id, status)
     VALUES (UUID(), ?, ?, 'current_employee')`,
    [`${name} ${employeeUuids.length}`, orgId],
  );
  const [row] = await db.query("SELECT uuid FROM employees WHERE id=?", [emp.insertId]);
  const uuid = row[0].uuid;
  employeeUuids.push(uuid);
  await db.query(
    `INSERT INTO employee_salary_history (uuid, employee_uuid, year, basic_salary, effective_from, effective_to)
     VALUES (UUID(), ?, ?, ?, '2026-01-01', NULL)`,
    [uuid, YEAR, BASIC],
  );
  return uuid;
}

const summarise = (uuid) =>
  getMonthlyAttendanceAndLeaveSummary({ employeeUuid: uuid, orgId, month: MONTH, year: YEAR, conn: db });

const compute = (summary) => computeAutomaticLines({ summary, basicSalary: BASIC });

/**
 * Every working weekday in October 2026, derived rather than typed.
 *
 * The first version of this file hardcoded the list and got 19 of 22. A test that
 * quietly under-counts the working week makes every money assertion in the file
 * wrong by a factor, and the failure surfaces as a payroll bug rather than as a
 * bad fixture. Computed from the same rule the service uses.
 */
function workingWeekdays() {
  const out = [];
  for (let d = 1; d <= 31; d += 1) {
    const date = new Date(Date.UTC(YEAR, MONTH - 1, d));
    const dow = date.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(`2026-10-${String(d).padStart(2, "0")}`);
  }
  return out;
}

const WEEKDAYS = workingWeekdays();

/**
 * Clock in on every working day except `skip`.
 *
 * Without this, an employee who took two days of unpaid leave is also absent on
 * the other twenty, and the deduction is dominated by absence - so "unpaid leave
 * costs two days' pay" cannot be asserted, only "the total is large". Attending
 * the rest of the month is what isolates the variable under test.
 */
async function attendAll(uuid, skip = []) {
  const skipped = new Set(skip);
  for (const date of WEEKDAYS) {
    if (skipped.has(date)) continue;
    await clockIn(uuid, date, `${date} 08:55:00`);
  }
}

async function approveLeave(uuid, leaveTypeId, start, end) {
  await db.query(
    `INSERT INTO leave_requests (uuid, employee_uuid, leave_type_id, start_date, end_date, status, approved_at)
     VALUES (UUID(), ?, ?, ?, ?, 'approved', NOW())`,
    [uuid, leaveTypeId, start, end],
  );
}

async function clockIn(uuid, date, time) {
  await db.query(
    `INSERT INTO attendance_records (uuid, employee_uuid, organization_id, date, check_in_at, status, is_manual, created_at)
     VALUES (UUID(), ?, ?, ?, ?, 'checked_in', 'no', NOW())`,
    [uuid, orgId, date, time],
  );
}

async function addOvertime(uuid, date, requested, approved, status) {
  await db.query(
    `INSERT INTO overtime_requests
       (uuid, employee_uuid, organization_id, work_date, requested_hours, approved_hours, status, decided_at, created_at, updated_at)
     VALUES (UUID(), ?, ?, ?, ?, ?, ?, NOW(), NOW(), NOW())`,
    [uuid, orgId, date, requested, approved, status],
  );
}

describe.runIf(HAS_DB)("payroll auto-computation reads leave and attendance", () => {
  it("derives the per-day rate from real working days, not 30", async () => {
    const uuid = await newEmployee("Rate");
    const summary = await summarise(uuid);
    expect(summary.workingDays).toBe(WORKING_DAYS);

    const c = compute(summary);
    expect(c.perDayRate).toBe(PER_DAY);
    // A hardcoded 30 would give 1033.33 and quietly wrong money all month.
    expect(c.perDayRate).not.toBe(Math.round((BASIC / 30) * 100) / 100);
  });

  it("charges nothing for an employee who worked every day", async () => {
    const uuid = await newEmployee("Perfect");
    await attendAll(uuid);

    const summary = await summarise(uuid);
    expect(WEEKDAYS).toHaveLength(WORKING_DAYS);
    expect(summary.attendedDays).toBe(WORKING_DAYS);
    expect(summary.absentDays).toBe(0);
    expect(summary.lateCount).toBe(0);

    const c = compute(summary);
    expect(c.lines).toEqual([]);
    expect(c.totalDeduction).toBe(0);
    expect(c.totalAddition).toBe(0);
  });

  it("an APPROVED UNPAID LEAVE day reduces the pay, as its own deduction line", async () => {
    const uuid = await newEmployee("UnpaidLeave");
    // Attends the whole month except the two days on unpaid leave, so the ONLY
    // thing being measured is the leave.
    await attendAll(uuid, ["2026-10-06", "2026-10-07"]);
    await approveLeave(uuid, unpaidTypeId, "2026-10-06", "2026-10-07"); // Tue + Wed

    const summary = await summarise(uuid);
    expect(summary.unpaidLeaveDays).toBe(2);
    // Those two days are leave, not absence, so they are charged exactly once.
    expect(summary.absentDays).toBe(0);

    const c = compute(summary);
    const line = c.lines.find((l) => l.source === "auto_unpaid_leave");
    expect(line).toBeTruthy();
    expect(line.type).toBe("deduction");
    expect(Number(line.amount)).toBeCloseTo(PER_DAY * 2, 2);
    expect(line.basis_value).toBe(2);
    expect(line.basis_unit).toBe("days");
    expect(c.totalDeduction).toBeCloseTo(PER_DAY * 2, 2);
  });

  it("an APPROVED PAID LEAVE day costs the employee nothing", async () => {
    const uuid = await newEmployee("PaidLeave");
    await attendAll(uuid);
    const before = compute(await summarise(uuid));
    expect(before.totalDeduction).toBe(0);

    await approveLeave(uuid, paidTypeId, "2026-10-12", "2026-10-12"); // a Monday already worked

    const summary = await summarise(uuid);
    expect(summary.paidLeaveDays).toBe(1);

    const after = compute(summary);
    // Charged as unpaid leave would be one day; charged as absence would be one
    // day; correctly it is nothing.
    expect(after.lines.some((l) => l.source === "auto_unpaid_leave")).toBe(false);
    expect(after.totalDeduction).toBe(0);
  });

  it("a paid leave day is excused from ABSENCE, not charged as unpaid", async () => {
    const uuid = await newEmployee("PaidExcuses");
    // Worked nothing at all, and took one day of paid leave. The paid day must be
    // excused: an employee on paid sick leave has no attendance row, so if the day
    // were not excused it would also read as an unexplained absence and be
    // docked for being ill.
    await approveLeave(uuid, paidTypeId, "2026-10-12", "2026-10-12");

    const summary = await summarise(uuid);
    expect(summary.paidLeaveDays).toBe(1);
    expect(summary.absentDays).toBe(WORKING_DAYS - 1);

    const c = compute(summary);
    // Exactly the 21 unexplained days are charged. If the paid day were not
    // excused this would be 22; if paid leave were charged as unpaid it would be
    // 22 as well but for a different and much worse reason.
    expect(c.totalDeduction).toBeCloseTo(PER_DAY * (WORKING_DAYS - 1), 2);
    expect(c.lines.some((l) => l.source === "auto_unpaid_leave")).toBe(false);
  });

  it("an unexplained absence on a working day is charged as a day", async () => {
    const uuid = await newEmployee("Absentee");
    const summary = await summarise(uuid);
    // No attendance rows and no leave: every working day is unexplained.
    expect(summary.attendedDays).toBe(0);
    expect(summary.absentDays).toBe(WORKING_DAYS);

    const c = compute(summary);
    expect(c.lines).toHaveLength(1);
    expect(c.lines[0].source).toBe("auto_absenteeism");
    expect(c.lines[0].basis_value).toBe(WORKING_DAYS);
    expect(c.totalDeduction).toBeCloseTo(PER_DAY * WORKING_DAYS, 2);
  });

  it("clocking in on one day removes exactly one day of absence", async () => {
    const uuid = await newEmployee("OneShift");
    const before = await summarise(uuid);
    await clockIn(uuid, "2026-10-05", "2026-10-05 08:55:00"); // a Monday, on time
    const after = await summarise(uuid);

    expect(after.attendedDays).toBe(1);
    expect(after.absentDays).toBe(before.absentDays - 1);
    expect(after.lateCount).toBe(0);
    expect(compute(after).totalDeduction).toBeCloseTo(PER_DAY * (before.absentDays - 1), 2);
  });

  it("a check-in after the cutoff is LATE, and on time is not", async () => {
    const uuid = await newEmployee("Lateness");
    await clockIn(uuid, "2026-10-05", "2026-10-05 08:59:00"); // one minute before
    await clockIn(uuid, "2026-10-06", "2026-10-06 09:31:00"); // one minute after

    const summary = await summarise(uuid);
    expect(summary.lateCount).toBe(1);
    expect(summary.attendedDays).toBe(2);
  });

  it("two lates cost NOTHING, and three cost exactly half a day", async () => {
    const two = await newEmployee("TwoLates");
    await clockIn(two, "2026-10-05", "2026-10-05 09:45:00");
    await clockIn(two, "2026-10-06", "2026-10-06 10:15:00");

    const twoSummary = await summarise(two);
    expect(twoSummary.lateCount).toBe(2);
    const twoComputed = compute(twoSummary);
    // Prorating here would make the penalty CHEAPER as the employee became
    // latelier: 2 lates at 0.33 of a day and 3 at exactly 0.5 means committing
    // to a third late arrival reduces the penalty.
    expect(twoComputed.lines.some((l) => l.source === "auto_late")).toBe(false);

    const three = await newEmployee("ThreeLates");
    await clockIn(three, "2026-10-05", "2026-10-05 09:45:00");
    await clockIn(three, "2026-10-06", "2026-10-06 10:15:00");
    await clockIn(three, "2026-10-07", "2026-10-07 11:30:00");

    const threeSummary = await summarise(three);
    expect(threeSummary.lateCount).toBe(3);
    const line = compute(threeSummary).lines.find((l) => l.source === "auto_late");
    expect(line).toBeTruthy();
    expect(Number(line.amount)).toBeCloseTo(PER_DAY * 0.5, 2);
    expect(line.basis_unit).toBe("late_arrivals");
    expect(PAYROLL_RULES.LATES_PER_HALF_DAY).toBe(3);
  });

  it("APPROVED overtime hours are paid; requested-but-REJECTED hours are not", async () => {
    const uuid = await newEmployee("Overtime");
    await addOvertime(uuid, "2026-10-20", 8, 6, "approved");
    await addOvertime(uuid, "2026-10-21", 10, 0, "rejected");
    await addOvertime(uuid, "2026-10-22", 4, 0, "pending");

    const summary = await summarise(uuid);
    // Of the approved request, 8h were claimed and 6h allowed. Paying the claimed
    // figure instead would pay 2 hours nobody approved.
    expect(summary.approvedOvertimeHours).toBe(6);
    expect(summary.requestedOvertimeHours).toBe(8);

    const c = compute(summary);
    const line = c.lines.find((l) => l.source === "auto_overtime");
    expect(line).toBeTruthy();
    expect(line.type).toBe("earning");
    expect(line.basis_value).toBe(6);
    expect(Number(line.amount)).toBeCloseTo(HOURLY * 1.5 * 6, 2);
    expect(c.totalAddition).toBeCloseTo(HOURLY * 1.5 * 6, 2);
  });

  it("a PENDING overtime request pays nothing until it is approved", async () => {
    const uuid = await newEmployee("PendingOT");
    await addOvertime(uuid, "2026-10-20", 6, 0, "pending");

    const summary = await summarise(uuid);
    expect(summary.approvedOvertimeHours).toBe(0);
    expect(compute(summary).totalAddition).toBe(0);
  });

  it("overtime and deductions stay on separate lines and never net each other away", async () => {
    // The classic integration bug: fold the overtime addition into the allowance
    // total and the leave deduction into the deduction total, then net them. Both
    // disappear from the payslip and an employee cannot see what they were.
    const uuid = await newEmployee("BothWays");
    await approveLeave(uuid, unpaidTypeId, "2026-10-06", "2026-10-07");
    await addOvertime(uuid, "2026-10-20", 6, 6, "approved");

    const c = compute(await summarise(uuid));
    const earnings = c.lines.filter((l) => l.type === "earning");
    const deductions = c.lines.filter((l) => l.type === "deduction");

    expect(earnings).toHaveLength(1);
    expect(earnings[0].source).toBe("auto_overtime");
    expect(deductions.length).toBeGreaterThanOrEqual(1);
    expect(deductions[0].source).toBe("auto_unpaid_leave");
    expect(c.totalAddition).toBeGreaterThan(0);
    expect(c.totalDeduction).toBeGreaterThan(0);
    // Each is its own total, not one signed sum.
    expect(c.totalAddition).not.toBe(c.totalDeduction - c.totalAddition);
  });

  it("a holiday is not a working day, so it is not an absence either", async () => {
    // The bug this table exists to prevent: with no calendar, a public holiday has
    // no attendance row, so "no row" reads as absent and a day's pay is docked for
    // a day nobody was expected to work.
    const uuid = await newEmployee("Holiday");
    const [holiday] = await db.query(
      "INSERT INTO holidays (uuid, organization_id, name, date) VALUES (UUID(), ?, 'Integration Holiday', '2026-10-19')",
      [orgId],
    );

    try {
      const summary = await summarise(uuid);
      expect(summary.workingDays).toBe(WORKING_DAYS - 1);
      expect(summary.holidayCount).toBeGreaterThanOrEqual(1);
      // One fewer working day to be absent from, and the employee is absent on
      // all of them, so absence drops by one rather than the deduction rising.
      expect(summary.absentDays).toBe(WORKING_DAYS - 1);

      const c = compute(summary);
      expect(c.workingDays).toBe(WORKING_DAYS - 1);
      // The denominator dropped too, so each remaining day costs slightly MORE -
      // but the total must still be less than paying for a full month.
      expect(c.totalDeduction).toBeLessThan(BASIC);
    } finally {
      // Holidays are ORG-scoped, so leaving one behind shifts the working-day
      // count for every later test in this file and turns a real payroll bug into
      // an unexplained number.
      await db.query("DELETE FROM holidays WHERE id=?", [holiday.insertId]);
    }
  });

  it("a weekend day is never an absence", async () => {
    // 2026-10-03 is a Saturday and 2026-10-04 a Sunday. If weekends leaked into
    // the absence count every employee would lose two days of pay every month.
    const uuid = await newEmployee("Weekend");
    const summary = await summarise(uuid);
    expect(summary.absentDays).toBe(WORKING_DAYS);
    expect(summary.workingDays).toBe(WORKING_DAYS);
    // 22 working days + 9 weekend days in October 2026 = 31 calendar days.
    expect(summary.absentDays + 9).toBe(31);
  });

  it("an employee with no basic salary produces no line and no divide-by-zero", async () => {
    const summary = await summarise(await newEmployee("NoSalary"));
    const c = computeAutomaticLines({ summary, basicSalary: 0 });
    expect(c.lines).toEqual([]);
    expect(Number.isFinite(c.perDayRate)).toBe(true);
    expect(c.skipReason).toBe("no_basic_salary");
  });

  it("zero working days is reported, not silently divided by", async () => {
    const summary = await summarise(await newEmployee("NoDays"));
    const c = computeAutomaticLines({ summary: { ...summary, workingDays: 0 }, basicSalary: BASIC });
    expect(c.lines).toEqual([]);
    expect(c.skipReason).toBe("no_working_days");
    // Infinity here becomes NaN in the SQL parameter and a corrupt salary row.
    expect(Number.isFinite(c.perDayRate)).toBe(true);
  });
});