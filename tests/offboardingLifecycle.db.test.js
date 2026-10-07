import { describe, it, expect, beforeAll, afterAll } from "vitest";
import dotenv from "dotenv";
import mysql from "mysql2/promise";
import { randomUUID } from "node:crypto";
import {
  createExitRequest,
  getExitRequest,
  decideExitRequest,
  clearChecklistItem,
  getOutstandingAssets,
  getEncashableLeaveDays,
  calculateSettlement,
  saveSettlement,
  processSettlement,
  completeExit,
  getMyExit,
  noticeDaysServed,
  summariseChecklist,
  CHECKLIST_TEMPLATE,
} from "../src/services/offboarding.service.js";

/**
 * THE LIFECYCLE THIS MODULE EXISTS FOR:
 *   resignation -> asset clearance -> FnF calculation -> completion.
 *
 * DB-backed, not mocked, for the same reason the payroll integration test is: the
 * guard that makes this module worth having is a DATABASE guard. `open_exit_guard`
 * is a generated column, so "one open exit per employee" is enforced by MySQL and
 * a mocked pool cannot see it. A test with a mocked pool would report that the
 * rule works, having never asked the database anything.
 *
 * The second reason is the calendar. Every date in here is a DATE column, and
 * mysql2 hands those back as a Date at LOCAL midnight. Reading the UTC fields
 * returns the PREVIOUS day, which shifts last_working_day, the notice arithmetic
 * and the working-day count all at once - and none of them raises an error. That
 * bug was live in the shared date helper throughout Phase 1 and is now asserted
 * directly in "a DATE column round-trips to the day it was stored".
 *
 * Every test builds its own employee in a shared org, so nothing leaks between
 * them: an employee with an asset still held cannot be reused by the FnF tests.
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

const BASIC = 31000;
const MONTH = 10;
const YEAR = 2026;
/** October 2026 has 22 weekdays under the default Mon-Fri week. */
const WORKING_DAYS = 22;
const PER_DAY = Math.round((BASIC / WORKING_DAYS) * 100) / 100;
const LAST_WORKING_DAY = "2026-10-31";

let db;
let orgId;
let paidTypeId;
let unpaidTypeId;
let categoryId;
const employeeUuids = [];

beforeAll(async () => {
  if (!HAS_DB) return;
  db = await mysql.createConnection(cfg);

  const [org] = await db.query("INSERT INTO organizations (uuid, name) VALUES (UUID(), ?)", [
    `Offboarding Test ${Date.now()}`,
  ]);
  orgId = org.insertId;
  await db.query("INSERT INTO work_week_config (organization_id) VALUES (?)", [orgId]);

  const [paid] = await db.query(
    `INSERT INTO leave_types (organization_id, name, days_allowed_per_year, is_paid) VALUES (?, 'Annual', 0, 'yes')`,
    [orgId],
  );
  paidTypeId = paid.insertId;

  const [unpaid] = await db.query(
    `INSERT INTO leave_types (organization_id, name, days_allowed_per_year, is_paid) VALUES (?, 'Unpaid', 0, 'no')`,
    [orgId],
  );
  unpaidTypeId = unpaid.insertId;

  const [cat] = await db.query(
    "INSERT INTO asset_categories (uuid, organization_id, name) VALUES (UUID(), ?, 'Laptops')",
    [orgId],
  );
  categoryId = (await db.query("SELECT uuid FROM asset_categories WHERE id=?", [cat.insertId]))[0][0].uuid;
});

afterAll(async () => {
  if (!db) return;
  for (const uuid of employeeUuids) await db.query("DELETE FROM employees WHERE uuid=?", [uuid]);
  await db.query("DELETE FROM organizations WHERE id=?", [orgId]);
  await db.end();
});

/** A fresh employee with a salary. No shared state between tests. */
async function newEmployee(name = "Leaver") {
  const [emp] = await db.query(
    `INSERT INTO employees (uuid, full_name, organization_id, status, joining_date)
     VALUES (UUID(), ?, ?, 'current_employee', '2024-01-01')`,
    [`${name} ${employeeUuids.length}`, orgId],
  );
  const uuid = (await db.query("SELECT uuid FROM employees WHERE id=?", [emp.insertId]))[0][0].uuid;
  employeeUuids.push(uuid);
  await db.query(
    `INSERT INTO employee_salary_history (uuid, employee_uuid, year, basic_salary, effective_from, effective_to)
     VALUES (UUID(), ?, ?, ?, '2024-01-01', NULL)`,
    [uuid, YEAR, BASIC],
  );
  return uuid;
}

/** Allocate leave for the exit year. */
async function allocateLeave(employeeUuid, { typeId, allocated, used }) {
  await db.query(
    `INSERT INTO employee_leave_allocations (uuid, employee_uuid, leave_type_id, year, allocated_days, used_days, remaining_days)
     VALUES (UUID(), ?, ?, ?, ?, ?, ?)`,
    [employeeUuid, typeId, YEAR, allocated, used, allocated - used],
  );
}

/** Create an asset and hand it to the employee, open (never returned). */
async function assignAsset(employeeUuid, { cost, tag }) {
  await db.query(
    `INSERT INTO assets (uuid, organization_id, category_uuid, asset_tag, name, purchase_cost, status, created_at)
     VALUES (UUID(), ?, ?, ?, 'Test Asset', ?, 'assigned', NOW())`,
    [orgId, categoryId, tag ?? `AST-${Math.random().toString(36).slice(2, 8).toUpperCase()}`, cost],
  );
  const assetUuid = (
    await db.query("SELECT uuid FROM assets WHERE organization_id=? AND asset_tag=?", [orgId, tag])
  )[0][0].uuid;
  await db.query(
    `INSERT INTO asset_assignments (uuid, organization_id, asset_uuid, employee_uuid, assigned_at, created_at)
     VALUES (UUID(), ?, ?, ?, NOW(), NOW())`,
    [orgId, assetUuid, employeeUuid],
  );
  return assetUuid;
}

/** Force the date notice was given, so notice arithmetic is deterministic. */
async function setNoticeGivenOn(exitUuid, iso) {
  await db.query("UPDATE exit_requests SET created_at=? WHERE uuid=?", [`${iso} 09:00:00`, exitUuid]);
}

/**
 * Default notice_period_days is ZERO, deliberately.
 *
 * An exit created today with a 30-day notice and a last working day 25 days out
 * is genuinely under-served, so a 30-day default would quietly attach a shortfall
 * recovery to every test that means to be measuring something else - the leave
 * encashment tests were losing 5 days' pay to a notice rule they never set up.
 * Tests about notice set it explicitly.
 */
const makeExit = (employeeUuid, extra = {}) =>
  createExitRequest({
    orgId,
    actorUuid: null,
    employeeUuid,
    requestType: "resignation",
    noticePeriodDays: 0,
    lastWorkingDay: LAST_WORKING_DAY,
    ...extra,
  });

// ---------------------------------------------------------------------------

describe.runIf(HAS_DB)("a DATE column round-trips to the day it was stored", () => {
  it("reads the day it was written, not the day before", async () => {
    // The regression that motivated moving isoDate into one place. mysql2 builds a
    // DATE at local midnight; on this server (UTC+5) a stored 2026-10-01 arrives
    // as 2026-09-30T19:00:00Z, and reading UTC fields returns 30 September.
    const uuid = await newEmployee("RoundTrip");
    const { isoDate } = await import("../src/utils/dateRange.js");
    const { countLeaveDays } = await import("../src/utils/leaveBalance.js");

    await db.query(
      `INSERT INTO leave_requests (uuid, employee_uuid, leave_type_id, start_date, end_date, status, approved_at)
       VALUES (UUID(), ?, ?, '2026-10-01', '2026-10-02', 'approved', NOW())`,
      [uuid, paidTypeId],
    );
    const [rows] = await db.query("SELECT start_date, end_date FROM leave_requests WHERE employee_uuid=?", [uuid]);
    const raw = rows[0].start_date;

    expect(raw).toBeInstanceOf(Date);
    expect(isoDate(raw)).toBe("2026-10-01");
    // A two-day request. Reading the start as 30 September charges three days,
    // which also pushes used_days up and understates the leave encashment.
    expect(countLeaveDays(raw, rows[0].end_date)).toBe(2);
  });
});

describe.runIf(HAS_DB)("exit request lifecycle", () => {
  it("seeds a four-department checklist so two exits never differ", async () => {
    const uuid = await newEmployee("Seeded");
    const exit = await makeExit(uuid);

    const full = await getExitRequest({ orgId, exitUuid: exit.uuid });
    expect(full.status).toBe("pending");
    expect(full.employee_name).toBe(full.employee_name);
    expect(full.checklist).toHaveLength(CHECKLIST_TEMPLATE.length);

    const departments = [...new Set(full.checklist.map((c) => c.department))].sort();
    expect(departments).toEqual(["Assets", "Finance", "HR", "IT"]);
    expect(full.checklist.every((c) => c.status === "pending")).toBe(true);
    expect(full.checklistSummary.complete).toBe(false);
    expect(full.checklistSummary.pending).toBe(CHECKLIST_TEMPLATE.length);
  });

  it("refuses a second open exit for the same employee", async () => {
    const uuid = await newEmployee("Duplicate");
    await makeExit(uuid);

    // The generated open_exit_guard is what enforces this in MySQL. Asserted
    // through the service for the message, and directly below for the database.
    await expect(makeExit(uuid)).rejects.toMatchObject({ statusCode: 409 });

    const [rows] = await db.query("SELECT COUNT(*) n FROM exit_requests WHERE employee_uuid=?", [uuid]);
    expect(Number(rows[0].n)).toBe(1);
  });

  it("rejects an exit for someone who already left", async () => {
    const uuid = await newEmployee("AlreadyGone");
    await db.query("UPDATE employees SET status='ex_employee' WHERE uuid=?", [uuid]);
    await expect(makeExit(uuid)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("rejects an unusable last working day", async () => {
    const uuid = await newEmployee("BadDate");
    await expect(makeExit(uuid, { lastWorkingDay: "31/10/2026" })).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(makeExit(uuid, { lastWorkingDay: "2026-13-45" })).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("allows a rejected exit to be replaced by a fresh one", async () => {
    // History must not permanently block someone. The guard is NULL once a
    // request leaves the open states, so a rejected exit is not in the way.
    const uuid = await newEmployee("Retried");
    const first = await makeExit(uuid);
    await decideExitRequest({ orgId, actorUuid: null, exitUuid: first.uuid, decision: "rejected" });

    const second = await makeExit(uuid);
    expect(second.uuid).not.toBe(first.uuid);

    const [rows] = await db.query("SELECT COUNT(*) n FROM exit_requests WHERE employee_uuid=?", [uuid]);
    expect(Number(rows[0].n)).toBe(2);
  });
});

describe.runIf(HAS_DB)("HR review", () => {
  it("approval may set the contractual notice period the employee did not know", async () => {
    const uuid = await newEmployee("Review");
    const exit = await makeExit(uuid, { noticePeriodDays: 7 });

    const decided = await decideExitRequest({
      orgId,
      actorUuid: null,
      exitUuid: exit.uuid,
      decision: "approved",
      noticePeriodDays: 45,
      lastWorkingDay: "2026-11-30",
      decisionNotes: "Contract is 45 days",
    });

    expect(decided.status).toBe("approved");
    expect(decided.notice_period_days).toBe(45);
    expect(decided.last_working_day).toBe("2026-11-30");
    expect(decided.decided_at).toBeTruthy();
  });

  it("refuses to decide twice", async () => {
    const uuid = await newEmployee("Decided");
    const exit = await makeExit(uuid);
    await decideExitRequest({ orgId, actorUuid: null, exitUuid: exit.uuid, decision: "approved" });

    // Re-deciding is how an approved resignation quietly becomes a rejected one
    // with nothing in the record to say it was ever approved.
    await expect(
      decideExitRequest({ orgId, actorUuid: null, exitUuid: exit.uuid, decision: "rejected" }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("refuses to record clearance against an unapproved exit", async () => {
    const uuid = await newEmployee("Unapproved");
    const exit = await makeExit(uuid);
    const full = await getExitRequest({ orgId, exitUuid: exit.uuid });
    const item = full.checklist[0];

    await expect(
      clearChecklistItem({ orgId, actorUuid: null, exitUuid: exit.uuid, checklistUuid: item.uuid }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("clears every task and reports progress as counts, not a fraction", async () => {
    const uuid = await newEmployee("Cleared");
    const exit = await makeExit(uuid);
    await decideExitRequest({ orgId, actorUuid: null, exitUuid: exit.uuid, decision: "approved" });

    let full = await getExitRequest({ orgId, exitUuid: exit.uuid });
    for (const item of full.checklist) {
      full = await clearChecklistItem({
        orgId,
        actorUuid: null,
        exitUuid: exit.uuid,
        checklistUuid: item.uuid,
      });
    }

    expect(full.checklistSummary.cleared).toBe(CHECKLIST_TEMPLATE.length);
    expect(full.checklistSummary.pending).toBe(0);
    expect(full.checklistSummary.complete).toBe(true);
    expect(full.checklist.every((c) => c.cleared_at !== null)).toBe(true);
  });

  it("summariseChecklist treats an empty list as not complete", async () => {
    // Otherwise a checklist that failed to seed reads as "nothing outstanding".
    const s = summariseChecklist([]);
    expect(s.total).toBe(0);
    expect(s.complete).toBe(false);
  });
});

describe.runIf(HAS_DB)("asset clearance reads the same rows the asset register does", () => {
  it("finds assets still held, with their recovery value", async () => {
    const uuid = await newEmployee("HoldsLaptop");
    await assignAsset(uuid, { cost: 250000, tag: "AST-CLEAR-1" });

    const assets = await getOutstandingAssets({ orgId, employeeUuid: uuid });
    expect(assets.count).toBe(1);
    expect(assets.exposure).toBe(250000);
    expect(assets.items[0].asset_tag).toBe("AST-CLEAR-1");
    expect(assets.items[0].purchase_cost).toBe(250000);
  });

  it("does not report an asset that has been returned", async () => {
    const uuid = await newEmployee("Returned");
    const assetUuid = await assignAsset(uuid, { cost: 5000, tag: "AST-CLEAR-2" });
    await db.query(
      "UPDATE asset_assignments SET returned_at=NOW(), return_condition='good' WHERE asset_uuid=?",
      [assetUuid],
    );

    const assets = await getOutstandingAssets({ orgId, employeeUuid: uuid });
    expect(assets.count).toBe(0);
    expect(assets.exposure).toBe(0);
  });

  it("counts an asset with no recorded cost as outstanding but worth nothing", async () => {
    // Two different statements. "You still hold a laptop" and "you owe nothing"
    // are both true, and the clearance guard must still block on the first.
    const uuid = await newEmployee("NoCost");
    await assignAsset(uuid, { cost: null, tag: "AST-CLEAR-3" });

    const assets = await getOutstandingAssets({ orgId, employeeUuid: uuid });
    expect(assets.count).toBe(1);
    expect(assets.uncosted).toBe(1);
    expect(assets.exposure).toBe(0);
  });
});

describe.runIf(HAS_DB)("Full & Final settlement", () => {
  it("pays out unused PAID leave and ignores unused UNPAID leave", async () => {
    const uuid = await newEmployee("Encash");
    await allocateLeave(uuid, { typeId: paidTypeId, allocated: 20, used: 5 });
    await allocateLeave(uuid, { typeId: unpaidTypeId, allocated: 10, used: 2 });
    const exit = await makeExit(uuid);

    const leave = await getEncashableLeaveDays({ orgId, employeeUuid: uuid, year: YEAR });
    // 15 paid days encash. The 8 unpaid days are not: paying cash for leave the
    // employee was never entitled to be paid for is money out for nothing.
    expect(leave.encashable_days).toBe(15);

    const calc = await calculateSettlement({ orgId, exitUuid: exit.uuid });
    expect(calc.working_days_in_month).toBe(WORKING_DAYS);
    expect(calc.per_day_rate).toBe(PER_DAY);
    expect(calc.leave.amount).toBe(Math.round(PER_DAY * 15 * 100) / 100);
    expect(calc.gross).toBe(calc.leave.amount);
    expect(calc.assets.count).toBe(0);
  });

  it("never encashes a negative leave balance", async () => {
    const uuid = await newEmployee("Overdrawn");
    // used_days above allocated makes remaining_days negative, which is possible:
    // the column is maintained by the leave controller, not a CHECK constraint.
    await allocateLeave(uuid, { typeId: paidTypeId, allocated: 5, used: 9 });
    const exit = await makeExit(uuid);

    const calc = await calculateSettlement({ orgId, exitUuid: exit.uuid });
    expect(calc.leave.encashable_days).toBe(0);
    expect(calc.leave.amount).toBe(0);
    expect(calc.net_fnf_amount).toBe(0);
  });

  it("recovers pay when the employee under-served notice", async () => {
    const uuid = await newEmployee("ShortNotice");
    await allocateLeave(uuid, { typeId: paidTypeId, allocated: 20, used: 5 });
    const exit = await makeExit(uuid, { noticePeriodDays: 30 });
    await setNoticeGivenOn(exit.uuid, "2026-10-07");
    await db.query("UPDATE exit_requests SET last_working_day='2026-10-20' WHERE uuid=?", [exit.uuid]);

    const calc = await calculateSettlement({ orgId, exitUuid: exit.uuid });
    // Notice given 7 Oct, last day 20 Oct = 14 calendar days served of 30.
    expect(calc.notice.notice_days_served).toBe(14);
    expect(calc.notice.shortfall_days).toBe(16);
    expect(calc.notice.recovery).toBe(Math.round(PER_DAY * 16 * 100) / 100);
    expect(calc.notice.adjustment).toBe(-calc.notice.recovery);
    // 16 shortfall days at 1,409.09 is 22,545.44, which is MORE than the 21,136.35
    // of leave encashment. The shortfall can outrun the gross, and the settlement
    // is floored at zero rather than going negative: there is no such thing as a
    // negative final settlement to be paid, and the shortfall becomes the
    // employer's problem to recover separately, not a negative payroll line.
    expect(calc.notice.recovery).toBeGreaterThan(calc.gross);
    expect(calc.net_fnf_amount).toBe(0);
  });

  it("pays nothing EXTRA for notice over-served", async () => {
    const uuid = await newEmployee("LongNotice");
    await allocateLeave(uuid, { typeId: paidTypeId, allocated: 20, used: 5 });
    const exit = await makeExit(uuid, { noticePeriodDays: 30 });
    await setNoticeGivenOn(exit.uuid, "2026-01-05");
    await db.query("UPDATE exit_requests SET last_working_day='2026-10-31' WHERE uuid=?", [exit.uuid]);

    const calc = await calculateSettlement({ orgId, exitUuid: exit.uuid });
    // Served is capped at the contractual 30, and there is no bonus. Paying for
    // goodwill produces a figure that then has to be taxed and withheld.
    expect(calc.notice.notice_days_served).toBe(30);
    expect(calc.notice.shortfall_days).toBe(0);
    expect(calc.notice.adjustment).toBe(0);
    expect(calc.net_fnf_amount).toBe(calc.gross);
  });

  it("caps the asset deduction at the settlement and reports what it could not take", async () => {
    const uuid = await newEmployee("ExpensiveLaptop");
    await allocateLeave(uuid, { typeId: paidTypeId, allocated: 20, used: 5 });
    await assignAsset(uuid, { cost: 500000, tag: "AST-FNF-1" });
    const exit = await makeExit(uuid);

    const calc = await calculateSettlement({ orgId, exitUuid: exit.uuid });
    // A 500,000 laptop against a ~21,000 settlement. Subtracting it raw would
    // produce roughly -479,000, which no payroll system can pay.
    expect(calc.gross).toBeLessThan(500000);
    expect(calc.assets.exposure).toBe(500000);
    expect(calc.assets.applied).toBe(calc.gross);
    expect(calc.assets.capped).toBe(true);
    expect(calc.assets.withheld_amount).toBe(Math.round((500000 - calc.gross) * 100) / 100);
    // Never negative: the settlement is floored, the debt is not written off.
    expect(calc.net_fnf_amount).toBe(0);
  });

  it("takes the full asset value when the settlement covers it", async () => {
    const uuid = await newEmployee("CheapLaptop");
    await allocateLeave(uuid, { typeId: paidTypeId, allocated: 20, used: 5 });
    await assignAsset(uuid, { cost: 5000, tag: "AST-FNF-2" });
    const exit = await makeExit(uuid);

    const calc = await calculateSettlement({ orgId, exitUuid: exit.uuid });
    expect(calc.assets.applied).toBe(5000);
    expect(calc.assets.capped).toBe(false);
    expect(calc.assets.withheld_amount).toBe(0);
    expect(calc.net_fnf_amount).toBe(Math.round((calc.gross - 5000) * 100) / 100);
  });

  it("reports zero working days instead of dividing by zero", async () => {
    // An org whose month has no working days. Infinity here becomes NaN in the SQL
    // parameter and a corrupt settlement row.
    const uuid = await newEmployee("NoDays");
    await allocateLeave(uuid, { typeId: paidTypeId, allocated: 20, used: 5 });
    const exit = await makeExit(uuid);
    await db.query("UPDATE work_week_config SET mon=0,tue=0,wed=0,thu=0,fri=0,sat=0,sun=0 WHERE organization_id=?", [orgId]);

    const calc = await calculateSettlement({ orgId, exitUuid: exit.uuid });
    expect(calc.working_days_in_month).toBe(0);
    expect(calc.per_day_rate).toBe(0);
    expect(Number.isFinite(calc.net_fnf_amount)).toBe(true);
    expect(calc.net_fnf_amount).toBe(0);

    await db.query("UPDATE work_week_config SET mon=1,tue=1,wed=1,thu=1,fri=1,sat=0,sun=0 WHERE organization_id=?", [orgId]);
  });

  it("freezes the rate and the day counts, so the figures stay auditable", async () => {
    const uuid = await newEmployee("Frozen");
    await allocateLeave(uuid, { typeId: paidTypeId, allocated: 20, used: 5 });
    const exit = await makeExit(uuid);
    await decideExitRequest({ orgId, actorUuid: null, exitUuid: exit.uuid, decision: "approved" });
    await saveSettlement({ orgId, actorUuid: null, exitUuid: exit.uuid });

    const [rows] = await db.query(
      `SELECT per_day_rate, working_days_in_month, leave_encashment_days, basic_salary
         FROM final_settlements WHERE exit_request_uuid=?`,
      [exit.uuid],
    );
    const s = rows[0];
    expect(Number(s.per_day_rate)).toBe(PER_DAY);
    expect(Number(s.working_days_in_month)).toBe(WORKING_DAYS);
    expect(Number(s.leave_encashment_days)).toBe(15);

    // Raise the salary: the stored rate must NOT move. Recomputing it later from a
    // changed salary is indistinguishable from someone tampering with the payout.
    await db.query("UPDATE employee_salary_history SET basic_salary=99999 WHERE employee_uuid=?", [uuid]);
    const [after] = await db.query("SELECT per_day_rate FROM final_settlements WHERE exit_request_uuid=?", [
      exit.uuid,
    ]);
    expect(Number(after[0].per_day_rate)).toBe(PER_DAY);
  });

  it("refuses to draft a settlement for an unapproved exit, or twice", async () => {
    const uuid = await newEmployee("DraftOnce");
    const exit = await makeExit(uuid);
    await expect(saveSettlement({ orgId, actorUuid: null, exitUuid: exit.uuid })).rejects.toMatchObject({
      statusCode: 409,
    });

    await decideExitRequest({ orgId, actorUuid: null, exitUuid: exit.uuid, decision: "approved" });
    await saveSettlement({ orgId, actorUuid: null, exitUuid: exit.uuid });
    await expect(saveSettlement({ orgId, actorUuid: null, exitUuid: exit.uuid })).rejects.toMatchObject({
      statusCode: 409,
    });
  });
});

describe.runIf(HAS_DB)("the guards that make this module worth having", () => {
  it("REFUSES to process a settlement while an asset is still held", async () => {
    const uuid = await newEmployee("StillHasLaptop");
    await allocateLeave(uuid, { typeId: paidTypeId, allocated: 20, used: 5 });
    await assignAsset(uuid, { cost: 250000, tag: "AST-GUARD-1" });
    const exit = await makeExit(uuid);
    await decideExitRequest({ orgId, actorUuid: null, exitUuid: exit.uuid, decision: "approved" });
    await saveSettlement({ orgId, actorUuid: null, exitUuid: exit.uuid });

    // THE guard. Everything else here is reporting; this is the one place a
    // missing check costs a laptop.
    await expect(
      processSettlement({ orgId, actorUuid: null, exitUuid: exit.uuid, target: "processed" }),
    ).rejects.toMatchObject({ statusCode: 409 });

    // The message must name the asset, not just say "there is a problem", or the
    // reader has no idea they are looking for a car park.
    await expect(
      processSettlement({ orgId, actorUuid: null, exitUuid: exit.uuid, target: "processed" }),
    ).rejects.toThrow(/AST-GUARD-1/);

    // Returning the asset releases it.
    await db.query(
      "UPDATE asset_assignments SET returned_at=NOW(), return_condition='good' WHERE asset_uuid=(SELECT uuid FROM assets WHERE asset_tag='AST-GUARD-1')",
    );
    const done = await processSettlement({ orgId, actorUuid: null, exitUuid: exit.uuid, target: "processed" });
    expect(done.status).toBe("processed");
  });

  it("REFUSES to complete an exit while the checklist is incomplete", async () => {
    const uuid = await newEmployee("Uncleared");
    await allocateLeave(uuid, { typeId: paidTypeId, allocated: 20, used: 5 });
    const exit = await makeExit(uuid);
    await decideExitRequest({ orgId, actorUuid: null, exitUuid: exit.uuid, decision: "approved" });
    await saveSettlement({ orgId, actorUuid: null, exitUuid: exit.uuid });
    await processSettlement({ orgId, actorUuid: null, exitUuid: exit.uuid, target: "processed" });

    await expect(completeExit({ orgId, actorUuid: null, exitUuid: exit.uuid })).rejects.toMatchObject({
      statusCode: 409,
    });

    // Clearing all but one still blocks, and says how many are left.
    let full = await getExitRequest({ orgId, exitUuid: exit.uuid });
    for (const item of full.checklist.slice(1)) {
      await clearChecklistItem({ orgId, actorUuid: null, exitUuid: exit.uuid, checklistUuid: item.uuid });
    }
    await expect(completeExit({ orgId, actorUuid: null, exitUuid: exit.uuid })).rejects.toThrow(
      /1 of \d+ clearance task/,
    );
  });

  it("REFUSES to complete an exit whose settlement is still a draft", async () => {
    const uuid = await newEmployee("DraftExit");
    const exit = await makeExit(uuid);
    await decideExitRequest({ orgId, actorUuid: null, exitUuid: exit.uuid, decision: "approved" });
    await saveSettlement({ orgId, actorUuid: null, exitUuid: exit.uuid });

    let full = await getExitRequest({ orgId, exitUuid: exit.uuid });
    for (const item of full.checklist) {
      full = await clearChecklistItem({ orgId, actorUuid: null, exitUuid: exit.uuid, checklistUuid: item.uuid });
    }

    await expect(completeExit({ orgId, actorUuid: null, exitUuid: exit.uuid })).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("cannot skip straight to paid without being processed first", async () => {
    const uuid = await newEmployee("SkipPaid");
    const exit = await makeExit(uuid);
    await decideExitRequest({ orgId, actorUuid: null, exitUuid: exit.uuid, decision: "approved" });
    await saveSettlement({ orgId, actorUuid: null, exitUuid: exit.uuid });

    await expect(
      processSettlement({ orgId, actorUuid: null, exitUuid: exit.uuid, target: "paid" }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe.runIf(HAS_DB)("the full lifecycle, end to end", () => {
  it("resignation -> clearance -> FnF -> completion", async () => {
    const uuid = await newEmployee("FullLifecycle");
    await allocateLeave(uuid, { typeId: paidTypeId, allocated: 20, used: 5 });
    await allocateLeave(uuid, { typeId: unpaidTypeId, allocated: 8, used: 1 });
    const assetUuid = await assignAsset(uuid, { cost: 250000, tag: "AST-E2E-1" });

    // 1. Resignation, submitted by the employee through the ESS path.
    const exit = await makeExit(uuid);
    expect(exit.checklistTasks).toBe(CHECKLIST_TEMPLATE.length);

    // Notice given a fortnight before the last working day, so the contractual
    // 30 days are fully served. Without this the exit is legitimately under-served
    // (created today, last day in 25 days) and a shortfall recovery quietly
    // reduces the payout this test is about to assert on.
    await setNoticeGivenOn(exit.uuid, "2026-09-20");

    // 2. HR reviews and approves, setting the real contractual notice.
    await decideExitRequest({
      orgId,
      actorUuid: null,
      exitUuid: exit.uuid,
      decision: "approved",
      noticePeriodDays: 30,
      lastWorkingDay: LAST_WORKING_DAY,
    });

    // 3. FnF is calculated while the laptop is still out, so it must show the
    //    asset as withheld rather than quietly ignoring it.
    const provisional = await calculateSettlement({ orgId, exitUuid: exit.uuid });
    expect(provisional.assets.count).toBe(1);
    expect(provisional.assets.exposure).toBe(250000);
    expect(provisional.assets.applied).toBe(provisional.gross);
    expect(provisional.net_fnf_amount).toBe(0);
    await saveSettlement({ orgId, actorUuid: null, exitUuid: exit.uuid });

    // 4. Payment is blocked until the asset comes back.
    await expect(
      processSettlement({ orgId, actorUuid: null, exitUuid: exit.uuid, target: "processed" }),
    ).rejects.toMatchObject({ statusCode: 409 });

    await db.query(
      "UPDATE asset_assignments SET returned_at=NOW(), return_condition='good' WHERE asset_uuid=?",
      [assetUuid],
    );

    // 5. Recalculate: now nothing is withheld and the real balance shows.
    await db.query("DELETE FROM final_settlements WHERE exit_request_uuid=?", [exit.uuid]);
    const finalCalc = await calculateSettlement({ orgId, exitUuid: exit.uuid });
    expect(finalCalc.assets.count).toBe(0);
    expect(finalCalc.assets.exposure).toBe(0);
    expect(finalCalc.net_fnf_amount).toBe(finalCalc.gross);
    expect(finalCalc.net_fnf_amount).toBe(Math.round(PER_DAY * 15 * 100) / 100);

    await saveSettlement({ orgId, actorUuid: null, exitUuid: exit.uuid });

    // 6. Clear every department's task.
    let full = await getExitRequest({ orgId, exitUuid: exit.uuid });
    for (const item of full.checklist) {
      full = await clearChecklistItem({ orgId, actorUuid: null, exitUuid: exit.uuid, checklistUuid: item.uuid });
    }
    expect(full.checklistSummary.complete).toBe(true);

    await processSettlement({ orgId, actorUuid: null, exitUuid: exit.uuid, target: "processed" });
    const paid = await processSettlement({
      orgId,
      actorUuid: null,
      exitUuid: exit.uuid,
      target: "paid",
      paymentReference: "PAY-001",
    });
    expect(paid.status).toBe("paid");
    expect(paid.paid_at).toBeTruthy();

    // 7. Completion flips the employee to ex_employee - never a delete. The
    //    payslips, the custody history and this exit record all point at them.
    const completed = await completeExit({ orgId, actorUuid: null, exitUuid: exit.uuid, hrNotes: "Clean exit" });
    expect(completed.status).toBe("completed");
    expect(completed.completed_at).toBeTruthy();
    expect(completed.hr_notes).toBe("Clean exit");

    const [emp] = await db.query("SELECT status FROM employees WHERE uuid=?", [uuid]);
    expect(emp[0].status).toBe("ex_employee");

    // 8. Nothing outstanding remains, and the exit cannot be completed twice.
    expect((await getOutstandingAssets({ orgId, employeeUuid: uuid })).count).toBe(0);
    await expect(completeExit({ orgId, actorUuid: null, exitUuid: exit.uuid })).rejects.toMatchObject({
      statusCode: 409,
    });
  });
});

describe.runIf(HAS_DB)("the employee's own view", () => {
  it("shows the request, the checklist and the settlement - and nothing else", async () => {
    const uuid = await newEmployee("ESSView");
    await allocateLeave(uuid, { typeId: paidTypeId, allocated: 20, used: 5 });
    await assignAsset(uuid, { cost: 250000, tag: "AST-ESS-1" });
    const exit = await makeExit(uuid);
    await decideExitRequest({ orgId, actorUuid: null, exitUuid: exit.uuid, decision: "approved" });
    await saveSettlement({ orgId, actorUuid: null, exitUuid: exit.uuid });

    const mine = await getMyExit({ orgId, employeeUuid: uuid });
    expect(mine.exit_request.uuid).toBe(exit.uuid);
    expect(mine.exit_request.status).toBe("approved");
    expect(mine.checklist).toHaveLength(CHECKLIST_TEMPLATE.length);
    expect(mine.settlement.net_fnf_amount).toBeTruthy();

    // The asset deduction arithmetic is NOT exposed. Showing someone a number
    // partly derived from the price of the laptop they are holding, before Assets
    // has agreed what is owed, starts an argument HR cannot settle.
    expect(JSON.stringify(mine.settlement)).not.toContain("asset_deductions");
    expect(mine.settlement.leave_encashment_days).toBeTruthy();
  });

  it("returns a null request rather than failing when there is no exit", async () => {
    const uuid = await newEmployee("NoExit");
    const mine = await getMyExit({ orgId, employeeUuid: uuid });
    expect(mine.exit_request).toBeNull();
    expect(mine.checklist).toEqual([]);
  });

  it("reports on_roster so the page never offers a form to someone who has left", async () => {
    // THE BUG THIS FIXES. The employee page decided whether to show the
    // resignation form from the exit status alone, keying on "pending or
    // approved", so "show the form otherwise" included COMPLETED. A finished exit
    // rendered a fresh submission form, and submitting it was refused with "this
    // employee has already left the organization" - a dead end with nothing on the
    // page to explain it.
    const uuid = await newEmployee("LeftTheCompany");
    const exit = await makeExit(uuid);
    await decideExitRequest({ orgId, actorUuid: null, exitUuid: exit.uuid, decision: "approved" });
    await allocateLeave(uuid, { typeId: paidTypeId, allocated: 20, used: 5 });
    await saveSettlement({ orgId, actorUuid: null, exitUuid: exit.uuid });

    let full = await getExitRequest({ orgId, exitUuid: exit.uuid });
    for (const item of full.checklist) {
      full = await clearChecklistItem({ orgId, actorUuid: null, exitUuid: exit.uuid, checklistUuid: item.uuid });
    }
    await processSettlement({ orgId, actorUuid: null, exitUuid: exit.uuid, target: "processed" });
    await processSettlement({ orgId, actorUuid: null, exitUuid: exit.uuid, target: "paid" });
    await completeExit({ orgId, actorUuid: null, exitUuid: exit.uuid });

    const mine = await getMyExit({ orgId, employeeUuid: uuid });
    expect(mine.exit_request.status).toBe("completed");
    expect(mine.on_roster).toBe(false);
    expect(mine.employee_status).toBe("ex_employee");
  });

  it("reports on_roster false for an ex-employee who has NO exit record", async () => {
    // Someone can leave before this module exists, or HR can set the status by
    // hand. Inferring roster status from the absence of an exit record gets this
    // case exactly backwards and shows them a form they cannot use.
    const uuid = await newEmployee("GoneBeforeTheModule");
    await db.query("UPDATE employees SET status='ex_employee' WHERE uuid=?", [uuid]);

    const mine = await getMyExit({ orgId, employeeUuid: uuid });
    expect(mine.exit_request).toBeNull();
    expect(mine.on_roster).toBe(false);
    // And submitting against it is refused, not silently accepted.
    await expect(makeExit(uuid)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("reports on_roster true while the exit is still in flight, so a REJECTED one can be resubmitted", async () => {
    const uuid = await newEmployee("RejectedResubmit");
    const exit = await makeExit(uuid);
    await decideExitRequest({ orgId, actorUuid: null, exitUuid: exit.uuid, decision: "rejected" });

    const mine = await getMyExit({ orgId, employeeUuid: uuid });
    // Still on the roster, so the form returns - a rejection is a genuine
    // resubmission, unlike a completion.
    expect(mine.on_roster).toBe(true);
    expect(mine.exit_request.status).toBe("rejected");

    // And the database guard permits the new request, because rejected is not in
    // the open set.
    const second = await makeExit(uuid);
    expect(second.uuid).not.toBe(exit.uuid);
  });
});

describe("notice arithmetic is pure and total", () => {
  it("caps served at the contractual notice", () => {
    expect(
      noticeDaysServed({ noticeGivenOn: "2026-01-01", lastWorkingDay: "2026-12-31", noticePeriodDays: 30 }),
    ).toBe(30);
  });

  it("never returns a negative count", () => {
    expect(
      noticeDaysServed({ noticeGivenOn: "2026-10-20", lastWorkingDay: "2026-10-05", noticePeriodDays: 30 }),
    ).toBe(0);
  });

  it("counts a single day as one", () => {
    expect(
      noticeDaysServed({ noticeGivenOn: "2026-10-05", lastWorkingDay: "2026-10-05", noticePeriodDays: 30 }),
    ).toBe(1);
  });

  it("treats a zero notice period as zero, whatever the dates", () => {
    expect(
      noticeDaysServed({ noticeGivenOn: "2026-01-01", lastWorkingDay: "2026-12-31", noticePeriodDays: 0 }),
    ).toBe(0);
  });
});