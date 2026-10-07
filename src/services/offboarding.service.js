import { randomUUID } from "node:crypto";
import ApiError from "../utils/ApiError.js";
import { pool } from "../config/db.js";
import { assertUuid } from "../utils/publicResponse.js";
import { getWorkingDaysForMonth, effectiveBasicForMonth } from "./payroll.service.js";
import { isoDate as normaliseIsoDate } from "../utils/dateRange.js";

/**
 * Offboarding: an employee leaving, what they still hold, and what they are owed.
 *
 * Until this existed, a departure was a one-line status change on employees. That
 * produced four silent failures, none of which raised anything:
 *
 *   - a laptop went home and no record said the company still owned it,
 *   - unused annual leave was never paid out, because no one computed it,
 *   - three days of notice against a thirty-day contract paid a full month,
 *   - "who authorised this, and on what grounds" had no answer.
 *
 * Three tables carry the lifecycle. exit_requests is the spine, the checklist is
 * what each department must clear, and final_settlements is the money.
 *
 * THE ORDERING HERE IS NOT ARBITRARY. Money cannot move while a laptop is still
 * in a car park: the settlement cannot be processed, and the exit cannot be
 * completed, until every open assignment is returned. That guard is the reason
 * this module is worth having, and it is enforced in the database-facing helpers
 * below rather than left to the UI.
 */

/**
 * The baseline every exit starts from.
 *
 * Seeded on request creation rather than left to whoever opens the dialog, so two
 * departures never produce two different checklists. Four departments because
 * four teams each hold something: IT revokes access, Finance confirms no dues,
 * Assets recovers hardware, HR closes the record.
 */
export const CHECKLIST_TEMPLATE = [
  { department: "IT", task_name: "Revoke system access, email and portal accounts" },
  { department: "IT", task_name: "Collect company laptop, badge and other devices" },
  { department: "Finance", task_name: "Confirm no outstanding advances or loans" },
  { department: "Finance", task_name: "Confirm final payroll has been processed" },
  { department: "Assets", task_name: "Recover all company assets in the employee's custody" },
  { department: "Assets", task_name: "Verify returned assets against custody history" },
  { department: "HR", task_name: "Confirm exit interview completed" },
  { department: "HR", task_name: "Issue experience letter and final salary certificate" },
  { department: "HR", task_name: "Remove employee from roster and settle accounts" },
];

/** Statuses that count as "still in flight" - the generated guard mirrors this. */
export const OPEN_EXIT_STATUSES = ["pending", "approved"];

function money(n) {
  const v = Math.round(Number(n) * 100) / 100;
  // Normalise negative zero. `Math.round(-0 * 100) / 100` is -0, which JSON
  // serialises as `-0` and which Object.is distinguishes from 0 - so an
  // adjustment of "nothing" reaches the client as a signed value that reads like
  // a number with a direction.
  return v === 0 ? 0 : v;
}

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ""))) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime());
}

/**
 * Normalise a DATE column to YYYY-MM-DD.
 *
 * The shared helper, not a local copy. It matters more here than anywhere else:
 * last_working_day is the pivot for the whole settlement, so reading it a day
 * early moves the notice calculation, the encashment month and the working-day
 * count all at once, and every one of those numbers still looks reasonable.
 */
const isoDate = (value) => normaliseIsoDate(value);

/** Inclusive calendar-day count, matching the leave module's convention. */
function inclusiveDays(fromIso, toIso) {
  const from = new Date(`${fromIso}T00:00:00Z`).getTime();
  const to = new Date(`${toIso}T00:00:00Z`).getTime();
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.max(0, Math.round((to - from) / 86400000) + 1);
}

function addDaysIso(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Employee resolution
// ---------------------------------------------------------------------------

/**
 * The employee must exist, belong to this org, and still be on the roster.
 *
 * Ex-employees are rejected rather than returned, because an exit request for
 * someone who already left is either a duplicate or a mistake, and in both cases
 * the correct answer is to refuse rather than to create a second open exit.
 */
export async function employeeOnRoster(orgId, employeeUuid, conn = pool) {
  assertUuid(employeeUuid, "Employee UUID");
  const [rows] = await conn.query(
    `SELECT e.uuid, e.full_name, e.status, e.joining_date,
            dg.name AS designation
       FROM employees e
       LEFT JOIN designations dg ON dg.id = e.designation_id
      WHERE e.uuid = ? AND e.organization_id = ?`,
    [employeeUuid, orgId],
  );
  if (!rows.length) throw new ApiError(404, "Employee not found in this organization");

  const employee = rows[0];
  if (employee.status === "ex_employee") {
    throw new ApiError(409, "This employee has already left the organization");
  }
  // 'inactive' means deactivated but still on the roster, so an exit is legal -
  // arguably more legal than for an active employee, since they are already off.
  // Deliberately not an error.
  return employee;
}

/** True when the employee already has an exit in flight. */
export async function hasOpenExit(employeeUuid, conn = pool) {
  const [rows] = await conn.query(
    `SELECT uuid, status FROM exit_requests
      WHERE employee_uuid = ? AND status IN (?, ?)`,
    [employeeUuid, ...OPEN_EXIT_STATUSES],
  );
  return rows.length ? rows[0] : null;
}

// ---------------------------------------------------------------------------
// Exit requests
// ---------------------------------------------------------------------------

/**
 * Create an exit request and seed its checklist.
 *
 * Checklist seeding and the request are written in ONE transaction. A request
 * whose checklist failed to insert would show an empty clearance list, which
 * reads as "nothing to clear" rather than "something went wrong", and the FnF
 * guard that depends on it would then pass on a false negative.
 */
export async function createExitRequest({
  orgId,
  actorUuid,
  employeeUuid,
  requestType = "resignation",
  noticePeriodDays = 0,
  lastWorkingDay,
  reason,
  hrNotes,
  status = "pending",
  decidedBy = null,
  conn = pool,
}) {
  if (!["resignation", "termination"].includes(requestType)) {
    throw new ApiError(400, "request_type must be resignation or termination");
  }
  if (!isValidDate(lastWorkingDay)) {
    throw new ApiError(400, "last_working_day must be a valid YYYY-MM-DD date");
  }
  const notice = Number(noticePeriodDays);
  if (!Number.isInteger(notice) || notice < 0) {
    throw new ApiError(400, "notice_period_days must be a non-negative whole number");
  }

  const own = conn === pool;
  const db = own ? await pool.getConnection() : conn;
  if (own) await db.beginTransaction();
  try {
    const employee = await employeeOnRoster(orgId, employeeUuid, db);

    const existing = await hasOpenExit(employeeUuid, db);
    if (existing) {
      throw new ApiError(
        409,
        `This employee already has a ${existing.status} exit request. Resolve it before opening another.`,
      );
    }

    const uuid = randomUUID();
    await db.query(
      `INSERT INTO exit_requests
         (uuid, organization_id, employee_uuid, employee_name, designation, request_type,
          notice_period_days, last_working_day, reason, status, decided_by, decided_at, hr_notes,
          created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        uuid,
        orgId,
        employee.uuid,
        employee.full_name,
        employee.designation ?? null,
        requestType,
        notice,
        lastWorkingDay,
        reason ? String(reason).trim() : null,
        status,
        decidedBy,
        status === "pending" ? null : new Date(),
        hrNotes ? String(hrNotes).trim() : null,
        actorUuid ?? null,
      ],
    );

    for (const item of CHECKLIST_TEMPLATE) {
      await db.query(
        `INSERT INTO offboarding_checklists
           (uuid, organization_id, exit_request_uuid, department, task_name, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', NOW(), NOW())`,
        [randomUUID(), orgId, uuid, item.department, item.task_name],
      );
    }

    if (own) await db.commit();
    return { uuid, employeeUuid: employee.uuid, checklistTasks: CHECKLIST_TEMPLATE.length };
  } catch (e) {
    if (own) await db.rollback();
    // The generated column enforces this too; translating the driver's error
    // keeps the message about exits rather than about a unique index.
    if (e.code === "ER_DUP_ENTRY") {
      throw new ApiError(409, "This employee already has an exit request in progress");
    }
    throw e;
  } finally {
    if (own) db.release();
  }
}

/** One exit request with its checklist and settlement, or null. */
export async function getExitRequest({ orgId, exitUuid, conn = pool }) {
  assertUuid(exitUuid, "Exit request UUID");
  const [rows] = await conn.query(
    `SELECT er.*, u.full_name AS decided_by_name
       FROM exit_requests er
       LEFT JOIN users u ON u.uuid = er.decided_by
      WHERE er.uuid = ? AND er.organization_id = ?`,
    [exitUuid, orgId],
  );
  if (!rows.length) throw new ApiError(404, "Exit request not found");

  const [checklist] = await conn.query(
    `SELECT uuid, department, task_name, status, cleared_by_uuid, cleared_at, notes
       FROM offboarding_checklists
      WHERE exit_request_uuid = ?
      ORDER BY FIELD(department,'IT','Finance','Assets','HR'), id`,
    [exitUuid],
  );

  const [settlements] = await conn.query(
    "SELECT uuid, status, net_fnf_amount, leave_encashment_amount, asset_deductions, unreturned_asset_count FROM final_settlements WHERE exit_request_uuid = ?",
    [exitUuid],
  );

  return {
    ...rows[0],
    last_working_day: isoDate(rows[0].last_working_day),
    checklist,
    settlement: settlements[0] ?? null,
    checklistSummary: summariseChecklist(checklist),
  };
}

/**
 * Progress counts, per department and overall.
 *
 * Returned on every read of an exit because "is it done yet" is the only question
 * anybody opens this page to ask, and making them count rows themselves is how a
 * half-cleared exit gets signed off.
 */
export function summariseChecklist(checklist) {
  const byDepartment = {};
  let cleared = 0;
  for (const row of checklist) {
    const bucket = (byDepartment[row.department] ??= { pending: 0, cleared: 0 });
    if (row.status === "cleared") {
      bucket.cleared += 1;
      cleared += 1;
    } else {
      bucket.pending += 1;
    }
  }
  const total = checklist.length;
  return {
    total,
    cleared,
    pending: total - cleared,
    // A number rather than a fraction: "7 of 9" is answerable, "0.78" is not.
    complete: total > 0 && cleared === total,
    byDepartment,
  };
}

/**
 * Approve or reject an exit.
 *
 * Approval is the point at which the notice period is agreed, which is why the
 * decision may set it even if submission proposed something else. The submitted
 * value is a guess by an employee; the approved value is the contract.
 */
export async function decideExitRequest({
  orgId,
  actorUuid,
  exitUuid,
  decision,
  noticePeriodDays,
  lastWorkingDay,
  decisionNotes,
  conn = pool,
}) {
  if (!["approved", "rejected"].includes(decision)) {
    throw new ApiError(400, "decision must be approved or rejected");
  }

  const [rows] = await conn.query(
    "SELECT uuid, status, notice_period_days, last_working_day FROM exit_requests WHERE uuid=? AND organization_id=?",
    [exitUuid, orgId],
  );
  if (!rows.length) throw new ApiError(404, "Exit request not found");
  const existing = rows[0];

  if (existing.status !== "pending") {
    // Re-deciding is how an approved resignation quietly becomes a rejected one
    // with no record that anyone ever approved it.
    throw new ApiError(409, `This exit request was already ${existing.status}`);
  }

  let notice = Number(noticePeriodDays);
  if (noticePeriodDays === undefined || noticePeriodDays === null) notice = existing.notice_period_days;
  if (!Number.isInteger(notice) || notice < 0) {
    throw new ApiError(400, "notice_period_days must be a non-negative whole number");
  }

  let lwd = lastWorkingDay ? lastWorkingDay : isoDate(existing.last_working_day);
  if (!isValidDate(lwd)) throw new ApiError(400, "last_working_day must be a valid YYYY-MM-DD date");

  await conn.query(
    `UPDATE exit_requests
        SET status=?, notice_period_days=?, last_working_day=?, decision_notes=?,
            decided_by=?, decided_at=NOW(), updated_at=NOW()
      WHERE uuid=? AND organization_id=?`,
    [decision, notice, lwd, decisionNotes ? String(decisionNotes).trim() : null, actorUuid ?? null, exitUuid, orgId],
  );

  return getExitRequest({ orgId, exitUuid, conn });
}

/** Mark one checklist task cleared. Cleared once; never silently un-cleared. */
export async function clearChecklistItem({ orgId, actorUuid, exitUuid, checklistUuid, notes, conn = pool }) {
  assertUuid(checklistUuid, "Checklist item UUID");
  const [rows] = await conn.query(
    `SELECT c.uuid, c.status, er.status AS exit_status
       FROM offboarding_checklists c
       JOIN exit_requests er ON er.uuid = c.exit_request_uuid
      WHERE c.uuid = ? AND c.exit_request_uuid = ? AND c.organization_id = ?`,
    [checklistUuid, exitUuid, orgId],
  );
  if (!rows.length) throw new ApiError(404, "Checklist item not found on this exit request");

  if (rows[0].exit_status !== "approved" && rows[0].exit_status !== "completed") {
    // Clearing work against an exit nobody approved would let the checklist read
    // complete on a request that may still be rejected.
    throw new ApiError(409, "This exit request must be approved before clearance can be recorded");
  }
  if (rows[0].status === "cleared") {
    throw new ApiError(409, "This task is already cleared");
  }

  await conn.query(
    `UPDATE offboarding_checklists
        SET status='cleared', cleared_by_uuid=?, cleared_at=NOW(), notes=?, updated_at=NOW()
      WHERE uuid=? AND organization_id=?`,
    [actorUuid ?? null, notes ? String(notes).trim() : null, checklistUuid, orgId],
  );

  return getExitRequest({ orgId, exitUuid, conn });
}

// ---------------------------------------------------------------------------
// Asset clearance - the cross-module integration
// ---------------------------------------------------------------------------

/**
 * Every asset the employee is still holding.
 *
 * Reads asset_assignments exactly as the assets module writes them: an open
 * assignment is one with returned_at IS NULL. That is the same predicate
 * listAssets uses to find the current holder, so this list cannot drift from what
 * the asset register shows - the two disagreeing would mean HR believes a laptop
 * was returned while the register says it is still out.
 *
 * Recovery cost is the asset's purchase_cost, NOT an estimate of depreciation.
 * A company that wrote off a three-year-old laptop's original price as a debt
 * against its holder is not recovering money, it is confiscing.
 */
export async function getOutstandingAssets({ orgId, employeeUuid, conn = pool }) {
  assertUuid(employeeUuid, "Employee UUID");
  const [rows] = await conn.query(
    `SELECT a.uuid AS asset_uuid, a.asset_tag, a.name, a.category_uuid, c.name AS category_name,
            a.status AS asset_status, a.purchase_cost, a.serial_number,
            g.uuid AS assignment_uuid, g.assigned_at
       FROM asset_assignments g
       JOIN assets a ON a.uuid = g.asset_uuid
       LEFT JOIN asset_categories c ON c.uuid = a.category_uuid
      WHERE g.organization_id = ?
        AND g.employee_uuid = ?
        AND g.returned_at IS NULL
      ORDER BY a.asset_tag`,
    [orgId, employeeUuid],
  );

  const items = rows.map((r) => ({
    asset_uuid: r.asset_uuid,
    asset_tag: r.asset_tag,
    name: r.name,
    category_name: r.category_name ?? null,
    serial_number: r.serial_number ?? null,
    asset_status: r.asset_status,
    purchase_cost: r.purchase_cost === null ? null : Number(r.purchase_cost),
    assigned_at: isoDate(r.assigned_at),
    assignment_uuid: r.assignment_uuid,
  }));

  return {
    items,
    count: items.length,
    // Assets with no recorded purchase cost cannot contribute to a recovery, but
    // they are still outstanding hardware and must still block completion - hence
    // two separate figures.
    exposure: money(items.reduce((sum, i) => sum + (i.purchase_cost ?? 0), 0)),
    uncosted: items.filter((i) => i.purchase_cost === null).length,
  };
}

// ---------------------------------------------------------------------------
// Full & Final settlement
// ---------------------------------------------------------------------------

/**
 * Unused PAID leave, in days.
 *
 * PAID only, and that filter is the whole point of the query. Leaving without
 * deducting unused UNPAID leave would pay cash for days the employee was never
 * entitled to be paid for, which is a real payment made out of the company's
 * money for nothing.
 *
 * remaining_days can go negative if someone took more leave than allocated, so it
 * is clamped at zero rather than floored later: a negative encashment is money
 * owed BY the employee, which is a recovery question, not an encashment one, and
 * conflating the two produces a settlement that silently subtracts twice.
 */
export async function getEncashableLeaveDays({ orgId, employeeUuid, year, conn = pool }) {
  assertUuid(employeeUuid, "Employee UUID");
  const [rows] = await conn.query(
    `SELECT ela.leave_type_id, lt.name AS leave_type, lt.is_paid,
            ela.allocated_days, ela.used_days, ela.remaining_days
       FROM employee_leave_allocations ela
       JOIN leave_types lt ON lt.id = ela.leave_type_id
      WHERE ela.employee_uuid = ?
        AND ela.year = ?
        AND lt.organization_id = ?`,
    [employeeUuid, year, orgId],
  );

  const breakdown = rows.map((r) => ({
    leave_type: r.leave_type,
    is_paid: r.is_paid,
    allocated_days: Number(r.allocated_days),
    used_days: Number(r.used_days),
    remaining_days: Number(r.remaining_days),
    // Only a non-negative balance is encashable. Over-drawn leave is handled as a
    // recovery, if at all, and never as a negative payout.
    encashable_days: String(r.is_paid) === "no" ? 0 : Math.max(0, Number(r.remaining_days)),
  }));

  return {
    rows: breakdown,
    encashable_days: money(breakdown.reduce((s, r) => s + r.encashable_days, 0)),
  };
}

/**
 * Notice days actually served, from the date notice was given to the last day.
 *
 * Measured in CALENDAR days, not working days, and capped at the contractual
 * notice. Two reasons: a notice period is a contractual duration, and converting
 * it to working days would make serving it depend on how many weekends fell in
 * the window. The cap is what stops an employee who stayed three months past
 * their notice from generating a large positive recovery.
 */
export function noticeDaysServed({ noticeGivenOn, lastWorkingDay, noticePeriodDays }) {
  const served = inclusiveDays(noticeGivenOn, lastWorkingDay);
  return Math.min(Math.max(0, served), Math.max(0, Number(noticePeriodDays) || 0));
}

/**
 * Calculate the Full & Final settlement, without writing it.
 *
 * The order of the arithmetic is the whole design:
 *
 *   gross            = unused PAID leave x per-day rate
 *   notice_recovery  = (notice contracted - notice served) x per-day rate, only
 *                      when the employee UNDER-SERVED
 *   asset_deduction  = value of assets still held, CAPPED at the gross payable
 *   net              = max(0, gross - notice_recovery - asset_deduction)
 *
 * Two of those deserve defending.
 *
 * The asset cap is the difference between a settlement and a wage garnishment. A
 * laptop can easily be worth more than a month's salary, and subtracting its
 * purchase price from final pay produces a large negative number that no payroll
 * system can pay. Capping at the gross payable means the employee is made whole
 * up to what they are actually owed, and the uncapped exposure is returned
 * alongside as asset_deductions_exposure - the debt survives the cap, it is not
 * written off.
 *
 * Under-serving is a recovery; OVER-serving is not a bonus. An employee who
 * stayed six weeks past a four-week notice has not earned six weeks of extra pay,
 * and a calculation that returned a positive adjustment would be paying for
 * goodwill in a figure that then has to be taxed and withheld.
 *
 * The per-day rate comes from the payroll service rather than a second
 * implementation, so the rate quoted here is the same one the last payslip used.
 */
export async function calculateSettlement({ orgId, exitUuid, conn = pool }) {
  assertUuid(exitUuid, "Exit request UUID");

  const [rows] = await conn.query(
    `SELECT er.*, e.joining_date
       FROM exit_requests er
       LEFT JOIN employees e ON e.uuid = er.employee_uuid
      WHERE er.uuid = ? AND er.organization_id = ?`,
    [exitUuid, orgId],
  );
  if (!rows.length) throw new ApiError(404, "Exit request not found");
  const exit = rows[0];

  const lastWorkingDay = isoDate(exit.last_working_day);
  const exitYear = Number(lastWorkingDay.slice(0, 4));
  const exitMonth = Number(lastWorkingDay.slice(5, 7));

  const basic = Number(
    await effectiveBasicForMonth({
      employeeUuid: exit.employee_uuid,
      orgId,
      month: exitMonth,
      year: exitYear,
      conn,
    }),
  );

  // Working days of the LAST month, not of the notice period: a person leaving on
  // the 3rd spent most of the month working, and pricing their last fortnight
  // against a full 31-day month would understate a day of leave by half.
  const calendar = await getWorkingDaysForMonth({ orgId, month: exitMonth, year: exitYear, conn });
  const workingDays = calendar.workingDays;
  const perDayRate = workingDays > 0 ? money(basic / workingDays) : 0;

  const leave = await getEncashableLeaveDays({
    orgId,
    employeeUuid: exit.employee_uuid,
    year: exitYear,
    conn,
  });
  const leaveEncashment = money(perDayRate * leave.encashable_days);

  const noticeGivenOn = isoDate(exit.created_at);
  const served = noticeDaysServed({
    noticeGivenOn,
    lastWorkingDay,
    noticePeriodDays: exit.notice_period_days,
  });
  const shortfallDays = Math.max(0, Number(exit.notice_period_days) - served);
  const noticeRecovery = money(perDayRate * shortfallDays);
  // Negative, because it reduces the payout. The column is named
  // notice_pay_adjustment because it is an adjustment either way; the sign is what
  // carries the direction.
  const noticePayAdjustment = money(-noticeRecovery);

  const assets = await getOutstandingAssets({ orgId, employeeUuid: exit.employee_uuid, conn });
  const exposure = assets.exposure;

  const gross = leaveEncashment;
  const availableForAssets = Math.max(0, gross - noticeRecovery);
  // Capped. See the note above - this is the difference between a settlement and a
  // deduction that nobody can honour.
  const assetDeduction = money(Math.min(exposure, availableForAssets));
  const net = money(Math.max(0, gross - noticeRecovery - assetDeduction));

  return {
    exit_request_uuid: exitUuid,
    employee_uuid: exit.employee_uuid,
    employee_name: exit.employee_name,
    last_working_day: lastWorkingDay,
    basic_salary: money(basic),
    working_days_in_month: workingDays,
    per_day_rate: perDayRate,
    leave: { ...leave, amount: leaveEncashment },
    notice: {
      notice_period_days: Number(exit.notice_period_days),
      notice_days_served: served,
      shortfall_days: shortfallDays,
      recovery: noticeRecovery,
      adjustment: noticePayAdjustment,
      notice_given_on: noticeGivenOn,
    },
    assets: {
      count: assets.count,
      uncosted: assets.uncosted,
      items: assets.items,
      exposure,
      // The amount actually taken out of the settlement, which may be less than the
      // exposure when the employee is not owed enough for the laptop to come out of
      // their final pay.
      applied: assetDeduction,
      capped: assetDeduction < exposure,
      withheld_amount: money(exposure - assetDeduction),
    },
    gross,
    net_fnf_amount: net,
  };
}

/**
 * Persist a settlement as a draft.
 *
 * A draft rather than an immediate payout, because the numbers are derived from
 * three other modules and somebody has to read them before money moves. The
 * calculation is recomputed on write, never taken from the request body: a client
 * that can post its own FnF figure is a client that can post a large one.
 */
export async function saveSettlement({ orgId, actorUuid, exitUuid, notes, conn = pool }) {
  assertUuid(exitUuid, "Exit request UUID");

  const [exitRows] = await conn.query(
    "SELECT uuid, status, employee_uuid FROM exit_requests WHERE uuid=? AND organization_id=?",
    [exitUuid, orgId],
  );
  if (!exitRows.length) throw new ApiError(404, "Exit request not found");
  const exit = exitRows[0];
  if (exit.status !== "approved") {
    throw new ApiError(409, "A settlement can only be drafted for an approved exit request");
  }

  const [existing] = await conn.query(
    "SELECT uuid, status FROM final_settlements WHERE exit_request_uuid=? AND organization_id=?",
    [exitUuid, orgId],
  );
  if (existing.length) {
    // Re-drafting is a reset, which is a distinct and deliberate act: the
    // settlement goes back to draft, and anything already processed has to be
    // reverted by hand first.
    if (existing[0].status !== "draft") {
      throw new ApiError(409, `This settlement is already ${existing[0].status} and cannot be recalculated`);
    }
    throw new ApiError(409, "A draft settlement already exists for this exit request");
  }

  const calc = await calculateSettlement({ orgId, exitUuid, conn });
  const uuid = randomUUID();

  await conn.query(
    `INSERT INTO final_settlements
       (uuid, organization_id, exit_request_uuid, employee_uuid, basic_salary,
        working_days_in_month, per_day_rate, leave_encashment_days, leave_encashment_amount,
        notice_period_days, notice_days_served, notice_pay_adjustment,
        asset_deductions, asset_deductions_exposure, unreturned_asset_count,
        net_fnf_amount, status, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, NOW(), NOW())`,
    [
      uuid,
      orgId,
      exitUuid,
      calc.employee_uuid,
      calc.basic_salary,
      calc.working_days_in_month,
      calc.per_day_rate,
      calc.leave.encashable_days,
      calc.leave.amount,
      calc.notice.notice_period_days,
      calc.notice.notice_days_served,
      calc.notice.adjustment,
      calc.assets.applied,
      calc.assets.exposure,
      calc.assets.count,
      calc.net_fnf_amount,
      notes ? String(notes).trim() : null,
    ],
  );

  return { uuid, ...calc, status: "draft" };
}

/**
 * Mark a settlement processed, or paid.
 *
 * The guard is the module's reason to exist: PROCESSED is refused while the
 * employee still holds company property. Everything else in this feature is
 * reporting; this is the one place a missing check costs a laptop.
 *
 * The asset check is re-run here rather than trusted from the draft, because the
 * draft may be weeks old and an asset can have been assigned in the meantime.
 */
export async function processSettlement({ orgId, actorUuid, exitUuid, target = "processed", paymentReference, conn = pool }) {
  if (!["processed", "paid"].includes(target)) {
    throw new ApiError(400, "target must be processed or paid");
  }

  const [rows] = await conn.query(
    `SELECT s.*, er.status AS exit_status, er.employee_uuid
       FROM final_settlements s
       JOIN exit_requests er ON er.uuid = s.exit_request_uuid
      WHERE s.exit_request_uuid=? AND s.organization_id=?`,
    [exitUuid, orgId],
  );
  if (!rows.length) throw new ApiError(404, "No settlement found for this exit request");
  const settlement = rows[0];

  if (settlement.exit_status !== "approved") {
    throw new ApiError(409, `The exit request must be approved before the settlement is ${target}`);
  }

  if (settlement.status === "paid") {
    throw new ApiError(409, "This settlement has already been paid");
  }
  if (target === "processed" && settlement.status === "processed") {
    throw new ApiError(409, "This settlement has already been processed");
  }

  const assets = await getOutstandingAssets({ orgId, employeeUuid: settlement.employee_uuid, conn });
  if (assets.count > 0) {
    // Named explicitly. "There is an issue with the checklist" sends someone
    // hunting; the asset tag sends them to the car park.
    throw new ApiError(
      409,
      `Cannot ${target} the settlement: ${assets.count} company asset(s) are still in the employee's custody (${assets.items
        .map((a) => a.asset_tag)
        .join(", ")}). Return them first.`,
    );
  }

  if (target === "paid" && settlement.status !== "processed") {
    throw new ApiError(409, "A settlement must be processed before it can be paid");
  }

  await conn.query(
    `UPDATE final_settlements
        SET status=?, processed_by=COALESCE(processed_by, ?), processed_at=COALESCE(processed_at, NOW()),
            paid_at=?, payment_reference=?, updated_at=NOW()
      WHERE uuid=? AND organization_id=?`,
    [
      target,
      actorUuid ?? null,
      target === "paid" ? new Date() : null,
      target === "paid" ? paymentReference ? String(paymentReference).trim() : null : null,
      settlement.uuid,
      orgId,
    ],
  );

  const [updated] = await conn.query("SELECT * FROM final_settlements WHERE uuid=?", [settlement.uuid]);
  return updated[0];
}

/**
 * Close the exit: flip the employee to ex_employee.
 *
 * Refused while any asset is outstanding or the checklist is incomplete, and
 * refused without a processed settlement. The employee must end up as
 * ex_employee rather than deleted: the payslips, custody history and this exit
 * record all reference them, and a person who leaves has a history, not a hole.
 */
export async function completeExit({ orgId, actorUuid, exitUuid, hrNotes, conn = pool }) {
  assertUuid(exitUuid, "Exit request UUID");

  const [rows] = await conn.query(
    "SELECT uuid, status, employee_uuid, hr_notes FROM exit_requests WHERE uuid=? AND organization_id=?",
    [exitUuid, orgId],
  );
  if (!rows.length) throw new ApiError(404, "Exit request not found");
  const exit = rows[0];

  if (exit.status === "completed") throw new ApiError(409, "This exit is already completed");
  if (exit.status !== "approved") {
    throw new ApiError(409, `This exit request must be approved before it can be completed (currently ${exit.status})`);
  }

  const assets = await getOutstandingAssets({ orgId, employeeUuid: exit.employee_uuid, conn });
  if (assets.count > 0) {
    throw new ApiError(
      409,
      `Cannot complete the exit: ${assets.count} company asset(s) are still in the employee's custody (${assets.items
        .map((a) => a.asset_tag)
        .join(", ")}). Return them first.`,
    );
  }

  const checklist = await conn.query(
    "SELECT department, status FROM offboarding_checklists WHERE exit_request_uuid=?",
    [exitUuid],
  );
  const [checklistRows] = checklist;
  const summary = summariseChecklist(checklistRows);
  if (!summary.complete) {
    throw new ApiError(
      409,
      `Cannot complete the exit: ${summary.pending} of ${summary.total} clearance task(s) are still outstanding.`,
    );
  }

  const [settlements] = await conn.query(
    "SELECT uuid, status, net_fnf_amount FROM final_settlements WHERE exit_request_uuid=?",
    [exitUuid],
  );
  if (!settlements.length) {
    throw new ApiError(409, "Cannot complete the exit: no Full & Final settlement has been calculated");
  }
  if (settlements[0].status === "draft") {
    throw new ApiError(409, "Cannot complete the exit: the Full & Final settlement is still a draft");
  }

  await conn.query(
    `UPDATE exit_requests
        SET status='completed', completed_at=NOW(),
            hr_notes=COALESCE(?, hr_notes), updated_at=NOW()
      WHERE uuid=? AND organization_id=?`,
    [hrNotes ? String(hrNotes).trim() : null, exitUuid, orgId],
  );

  // 'ex_employee' and not a delete: the payslips, the asset custody history and
  // this exit record all point at this employee.
  await conn.query("UPDATE employees SET status='ex_employee' WHERE uuid=? AND organization_id=?", [
    exit.employee_uuid,
    orgId,
  ]);

  return getExitRequest({ orgId, exitUuid, conn });
}

/**
 * The employee's own exit view.
 *
 * Scoped to a single employee rather than paginated, because there is at most one
 * open exit at a time and the employee is looking at one thing.
 *
 * `on_roster` and `employee_status` are here because the page cannot know them any
 * other way, and guessing wrong is how a person who has already LEFT ends up being
 * offered a resignation form: the server would refuse it with "this employee has
 * already left the organization", which is a dead end with no explanation on the
 * page that produced it. Someone may be ex_employee with no exit record at all -
 * they left before this module existed, or HR set the status by hand - and the
 * form has to stay hidden for them too.
 */
export async function getMyExit({ orgId, employeeUuid, conn = pool }) {
  const [empRows] = await conn.query(
    "SELECT uuid, status FROM employees WHERE uuid=? AND organization_id=?",
    [employeeUuid, orgId],
  );
  const employeeStatus = empRows[0]?.status ?? null;
  const onRoster = employeeStatus === "current_employee" || employeeStatus === "active";

  const [rows] = await conn.query(
    `SELECT er.uuid, er.status, er.request_type, er.notice_period_days, er.last_working_day,
            er.reason, er.decision_notes, er.created_at, er.decided_at, er.completed_at
       FROM exit_requests er
      WHERE er.employee_uuid = ? AND er.organization_id = ?
      ORDER BY er.created_at DESC
      LIMIT 1`,
    [employeeUuid, orgId],
  );
  if (!rows.length) {
    return {
      on_roster: onRoster,
      employee_status: employeeStatus,
      exit_request: null,
      checklist: [],
      checklistSummary: null,
      settlement: null,
      outstanding_assets: (await getOutstandingAssets({ orgId, employeeUuid, conn })).count,
    };
  }

  const exit = rows[0];
  const full = await getExitRequest({ orgId, exitUuid: exit.uuid, conn });

  const [settlement] = await conn.query(
    `SELECT status, leave_encashment_days, leave_encashment_amount, notice_pay_adjustment,
            net_fnf_amount, unreturned_asset_count
       FROM final_settlements WHERE exit_request_uuid = ?`,
    [exit.uuid],
  );

  return {
    // A COMPLETED exit means the employee is gone, so the roster answer comes from
    // the exit record rather than from the roster, which may not have been flipped
    // yet by whoever completed it manually.
    on_roster: full.status === "completed" ? false : onRoster,
    employee_status: full.status === "completed" ? "ex_employee" : employeeStatus,
    exit_request: {
      uuid: full.uuid,
      status: full.status,
      request_type: full.request_type,
      notice_period_days: full.notice_period_days,
      last_working_day: full.last_working_day,
      reason: full.reason,
      decision_notes: full.decision_notes,
      decision: full.decided_at ? full.status : null,
      created_at: full.created_at,
      decided_at: full.decided_at,
      completed_at: full.completed_at,
    },
    checklist: full.checklist,
    checklistSummary: full.checklistSummary,
    // The settlement figure is visible to the employee, but NOT the asset
    // deduction arithmetic: showing someone a number partly derived from the price
    // of the laptop they are holding, before Assets has agreed what is owed,
    // invites an argument that HR is not in a position to settle.
    settlement: settlement[0]
      ? {
          status: settlement[0].status,
          leave_encashment_days: Number(settlement[0].leave_encashment_days),
          leave_encashment_amount: settlement[0].leave_encashment_amount,
          net_fnf_amount: settlement[0].net_fnf_amount,
        }
      : null,
    outstanding_assets: (await getOutstandingAssets({ orgId, employeeUuid, conn })).count,
  };
}