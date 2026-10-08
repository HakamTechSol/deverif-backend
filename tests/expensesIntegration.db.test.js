import { describe, it, expect, beforeAll, afterAll } from "vitest";
import dotenv from "dotenv";
import mysql from "mysql2/promise";
import {
  createCategory,
  createClaim,
  reviewClaim,
  markClaimPaid,
  bulkMarkClaimsPaid,
  getApprovedClaimsForPeriod,
  expenseReimbursementLine,
  markClaimsPaidByPayroll,
  loadClaim,
  MAX_BACKDATE_DAYS,
} from "../src/services/expenses.service.js";
import { generatePayroll } from "../src/controllers/salary.controller.js";
import { pool } from "../src/config/db.js";

/**
 * THE INVARIANT THIS FILE EXISTS TO PROVE.
 *
 * A claim is reimbursed exactly once. Everything else in expense management is
 * ordinary CRUD that a mocked pool would test perfectly well; this is the part where
 * being right in JavaScript and wrong in SQL is the normal outcome, because every
 * rule below is enforced by a WHERE clause and a transaction rather than by an `if`.
 *
 * WHY A REAL DATABASE.
 *
 *   - The guards are `WHERE status='pending'` / `WHERE status='approved'` clauses. A
 *     mock can be told to return success; it cannot tell you the query refuses to
 *     match a row it should not, and that refusal IS the double-payment protection.
 *   - `expense_year` / `expense_month` are STORED GENERATED columns, so the period
 *     bucketing payroll depends on is computed by MySQL. A mock cannot reproduce
 *     YEAR() on a DATE, and getting it wrong puts a February taxi on a March payslip.
 *   - mysql2 returns a DATE as a Date at LOCAL midnight. On this server (UTC+5)
 *     '2026-10-01' arrives as 2026-09-30T19:00:00Z, so reading it with
 *     toISOString() shifts the calendar day backwards. isoDate() is used throughout
 *     precisely so that cannot happen; a mock has no timezone to catch it in.
 *
 * EVERY TEST GETS ITS OWN EMPLOYEE AND ITS OWN CATEGORY. Claims are counted and
 * totalled per employee and per period, so a shared fixture would make each test see
 * the previous one's money and the file would become order-dependent - a payroll
 * regression would present as "the claim total is wrong" with no obvious cause.
 *
 * THE 20261114 REGRESSION, EXPLICITLY.
 *
 * The one-claim-per-employee-per-day-per-mode unique guard is gone, because two
 * legitimate same-day claims (two taxis to a client visit) are a real business case.
 * Removing a duplicate-preventing constraint is exactly the change that risks
 * reintroducing double payment, so `two same-day claims both settle, once each` is
 * asserted directly rather than inferred.
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

/** The payroll period every period-bucketing assertion runs against. */
const MONTH = 10;
const YEAR = 2026;
/** A working Tuesday inside the period, so a claim dated here is in-period. */
const IN_PERIOD = "2026-10-06";

let db;
let orgId;
let otherOrgId;
let taxi;
let meals;
let unlimited;
let n = 0;

beforeAll(async () => {
  if (!HAS_DB) return;
  db = await mysql.createConnection(cfg);

  const [org] = await db.query("INSERT INTO organizations (uuid, name) VALUES (UUID(), ?)", [
    `Expense Integration ${Date.now()}`,
  ]);
  orgId = org.insertId;

  // A second organization, used to prove tenancy is enforced on read and not merely
  // assumed. Created because "the query filters by org_id" is untestable without a
  // row that the filter must exclude.
  const [other] = await db.query("INSERT INTO organizations (uuid, name) VALUES (UUID(), ?)", [
    `Expense Other Tenant ${Date.now()}`,
  ]);
  otherOrgId = other.insertId;

  const mk = async (name, opts) =>
    createCategory({ orgId, name, conn: db, ...opts });

  // requires_receipt: the receipt gate, and the reason attachments exist here.
  taxi = await mk("Taxi", { maxLimitPerClaim: 5000, requiresReceipt: true });
  meals = await mk("Meals", { requiresReceipt: false });
  // No limit at all, to keep limit-enforcement tests off the critical path.
  unlimited = await mk("General", { requiresReceipt: false });
});

afterAll(async () => {
  if (!db) return;
  // Children before parents, and scoped by organization rather than by the uuids
  // created here: one test deliberately files a claim for an employee in the OTHER
  // org (the cross-tenant case), and a uuid list would miss that row. Deleting the
  // org first fails outright with fk_emp_org, because employees reference it.
  for (const id of [orgId, otherOrgId]) {
    // attachments has no FK, so nothing cascades it - it has to go by hand or the
    // rows outlive the org they point at.
    await db.query("DELETE FROM attachments WHERE organization_id=?", [id]);
    await db.query("DELETE FROM employees WHERE organization_id=?", [id]);
  }
  // Both probe orgs are deleted: left behind they appear in an org-admin's
  // organization picker and their categories look like real company policy.
  await db.query("DELETE FROM organizations WHERE id IN (?, ?)", [orgId, otherOrgId]);
  await db.end();
});

async function newEmployee(org = orgId, name = "Probe") {
  n += 1;
  const [emp] = await db.query(
    `INSERT INTO employees (uuid, full_name, organization_id, status)
     VALUES (UUID(), ?, ?, 'current_employee')`,
    [`${name}-${n}`, org],
  );
  const [row] = await db.query("SELECT uuid FROM employees WHERE id=?", [emp.insertId]);
  return row[0].uuid;
}

/** Attach a receipt row directly, the way the upload route would. */
async function attachReceipt(claimUuid, org = orgId) {
  const [row] = await db.query(
    `INSERT INTO attachments
       (uuid, organization_id, entity_type, entity_uuid, category, file_name, file_path, file_size, mime_type)
     VALUES (UUID(), ?, 'expense_claim', ?, 'expense_receipt', 'receipt.jpg', ?, 1, 'image/jpeg')`,
    [org, claimUuid, `uploads/${claimUuid}/receipt.jpg`],
  );
  return row.insertId;
}

const file = (amount, over = {}) =>
  createClaim({
    orgId,
    employeeUuid: over.employeeUuid,
    categoryUuid: over.categoryUuid ?? unlimited.uuid,
    amount,
    expenseDate: over.expenseDate ?? IN_PERIOD,
    description: "probe claim",
    paymentMode: over.paymentMode ?? "payroll",
    conn: db,
  });

/** file + approve, attaching a receipt first only when the category requires one. */
async function approvedClaim({ employeeUuid, categoryUuid = unlimited.uuid, amount = 1000, expenseDate = IN_PERIOD, paymentMode = "payroll" }) {
  const claim = await file(amount, { employeeUuid, categoryUuid, expenseDate, paymentMode });
  // Derived from the category rather than passed in as a flag, so a test cannot
  // forget it and then fail for the wrong reason.
  if (categoryUuid === taxi.uuid) await attachReceipt(claim.uuid);
  return reviewClaim({ orgId, claimUuid: claim.uuid, decision: "approved", conn: db });
}

describe.runIf(HAS_DB)("an expense claim is reimbursed exactly once", () => {
  // -------------------------------------------------------------------------
  // The 20261114 change: same-day duplicates are legitimate again.
  // -------------------------------------------------------------------------
  it("two claims on the SAME day, same mode, both approve and both remain payable", async () => {
    const employee = await newEmployee(orgId, "TwoTaxis");

    const first = await approvedClaim({ employeeUuid: employee, amount: 450, expenseDate: IN_PERIOD });
    const second = await approvedClaim({ employeeUuid: employee, amount: 300, expenseDate: IN_PERIOD });

    expect(first.status).toBe("approved");
    expect(second.status).toBe("approved");
    // Distinct claims, not one overwritten by the other - which is the failure a
    // unique key would have produced by refusing the second insert.
    expect(first.uuid).not.toBe(second.uuid);
    expect(Number(first.amount)).toBe(450);
    expect(Number(second.amount)).toBe(300);

    const payable = await getApprovedClaimsForPeriod({
      orgId,
      employeeUuid: employee,
      month: MONTH,
      year: YEAR,
      conn: db,
    });
    expect(payable).toHaveLength(2);
    // Both land on ONE payslip line, totalled - not two lines, and neither lost.
    const line = expenseReimbursementLine(payable);
    expect(line.amount).toBe(750);
    expect(line.basis_value).toBe(2);
    expect(line.claim_uuids).toHaveLength(2);
  });

  it("even an IDENTICAL same-day claim twice is allowed through", async () => {
    // The deliberate cost of retiring the guard, pinned so it cannot change silently.
    // The exact duplicate is now a REVIEWER's judgement, not a constraint: see the
    // "does not do" section of 20261114_allow_multiple_same_day_claims.sql.
    const employee = await newEmployee(orgId, "AccidentalDouble");
    const a = await approvedClaim({ employeeUuid: employee, amount: 250, expenseDate: IN_PERIOD });
    const b = await approvedClaim({ employeeUuid: employee, amount: 250, expenseDate: IN_PERIOD });

    expect(a.uuid).not.toBe(b.uuid);
    const payable = await getApprovedClaimsForPeriod({
      orgId, employeeUuid: employee, month: MONTH, year: YEAR, conn: db,
    });
    expect(payable).toHaveLength(2);
    expect(expenseReimbursementLine(payable).amount).toBe(500);
  });

  // -------------------------------------------------------------------------
  // The protection that replaced the guard.
  // -------------------------------------------------------------------------
  it("a payroll run settles the claims, and a SECOND run settles nothing", async () => {
    const employee = await newEmployee(orgId, "PayrollOnce");
    const claim = await approvedClaim({ employeeUuid: employee, amount: 800 });

    const firstRun = await getApprovedClaimsForPeriod({
      orgId, employeeUuid: employee, month: MONTH, year: YEAR, conn: db,
    });
    expect(firstRun).toHaveLength(1);
    await markClaimsPaidByPayroll({
      conn: db, orgId, salaryRecordUuid: "salary-record-1", claims: firstRun,
    });

    const secondRun = await getApprovedClaimsForPeriod({
      orgId, employeeUuid: employee, month: MONTH, year: YEAR, conn: db,
    });
    // This is the whole point: 'approved' is what payroll looks for, and the claim
    // is no longer approved, so a regenerated period cannot pay it twice.
    expect(secondRun).toHaveLength(0);
    expect(expenseReimbursementLine(secondRun)).toBeNull();

    const [rows] = await db.query(
      "SELECT status, paid_via_salary_record_uuid, paid_at FROM expense_claims WHERE uuid=?",
      [claim.uuid],
    );
    expect(rows[0].status).toBe("paid");
    // Traceable to the payslip that carried it - the evidence an audit reads.
    expect(rows[0].paid_via_salary_record_uuid).toBe("salary-record-1");
    expect(rows[0].paid_at).toBeTruthy();
  });

  it("markClaimsPaidByPayroll will not re-settle a claim that is already paid", async () => {
    const employee = await newEmployee(orgId, "ReSettle");
    const claim = await approvedClaim({ employeeUuid: employee, amount: 500 });
    const claims = await getApprovedClaimsForPeriod({
      orgId, employeeUuid: employee, month: MONTH, year: YEAR, conn: db,
    });

    await markClaimsPaidByPayroll({ conn: db, orgId, salaryRecordUuid: "run-a", claims });
    // A caller holding a stale claim list (two payroll runs racing, or a retry that
    // reused an old payload) must not be able to settle it again.
    await markClaimsPaidByPayroll({ conn: db, orgId, salaryRecordUuid: "run-b", claims });

    const [rows] = await db.query(
      "SELECT status, paid_via_salary_record_uuid FROM expense_claims WHERE uuid=?",
      [claim.uuid],
    );
    // The second run matched zero rows: run-b does not overwrite run-a.
    expect(rows[0].status).toBe("paid");
    expect(rows[0].paid_via_salary_record_uuid).toBe("run-a");
  });

  it("a paid claim can never be settled again, by hand or in bulk", async () => {
    const employee = await newEmployee(orgId, "Terminal");
    const claim = await approvedClaim({ employeeUuid: employee, amount: 400, paymentMode: "direct" });
    await markClaimPaid({ orgId, claimUuid: claim.uuid, paymentReference: "TRF-1", conn: db });

    await expect(
      markClaimPaid({ orgId, claimUuid: claim.uuid, conn: db }),
    ).rejects.toThrow(/already been paid/i);

    const bulk = await bulkMarkClaimsPaid({
      orgId, claimUuids: [claim.uuid], conn: db,
    });
    expect(bulk.paid).toHaveLength(0);
    expect(bulk.refused).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Review rules.
  // -------------------------------------------------------------------------
  it("a category that requires a receipt cannot be approved without one", async () => {
    const employee = await newEmployee(orgId, "NoReceipt");
    const claim = await file(900, { employeeUuid: employee, categoryUuid: taxi.uuid });

    await expect(
      reviewClaim({ orgId, claimUuid: claim.uuid, decision: "approved", conn: db }),
    ).rejects.toThrow(/require a receipt/i);

    // Still pending afterwards - a refused approval must not half-apply.
    const [rows] = await db.query("SELECT status FROM expense_claims WHERE uuid=?", [claim.uuid]);
    expect(rows[0].status).toBe("pending");

    await attachReceipt(claim.uuid);
    const approved = await reviewClaim({ orgId, claimUuid: claim.uuid, decision: "approved", conn: db });
    expect(approved.status).toBe("approved");
    expect(approved.receipt_satisfied).toBe(true);
  });

  it("a receipt requirement is NOT applied to a category that does not ask for one", async () => {
    // The other direction: if receipts were demanded everywhere, the module would be
    // unusable for small daily spend and people would stop filing claims at all.
    const employee = await newEmployee(orgId, "NoReceiptNeeded");
    const claim = await file(120, { employeeUuid: employee, categoryUuid: meals.uuid });
    const approved = await reviewClaim({ orgId, claimUuid: claim.uuid, decision: "approved", conn: db });
    expect(approved.status).toBe("approved");
    expect(approved.receipt_satisfied).toBe(true);
    expect(approved.receipt_count).toBe(0);
  });

  it("a claim cannot be decided twice", async () => {
    const employee = await newEmployee(orgId, "TwiceDecided");
    const claim = await approvedClaim({ employeeUuid: employee, amount: 700 });

    // Flipping an approved claim to rejected is the quiet way to lose a
    // reimbursement, so it is refused rather than allowed.
    await expect(
      reviewClaim({
        orgId, claimUuid: claim.uuid, decision: "rejected", rejectionReason: "changed my mind", conn: db,
      }),
    ).rejects.toThrow(/already approved/i);

    const [rows] = await db.query("SELECT status FROM expense_claims WHERE uuid=?", [claim.uuid]);
    expect(rows[0].status).toBe("approved");
  });

  it("a rejection needs a reason the employee can act on", async () => {
    const employee = await newEmployee(orgId, "SilentReject");
    const claim = await file(300, { employeeUuid: employee });

    await expect(
      reviewClaim({ orgId, claimUuid: claim.uuid, decision: "rejected", conn: db }),
    ).rejects.toThrow(/reason/i);

    const rejected = await reviewClaim({
      orgId, claimUuid: claim.uuid, decision: "rejected", rejectionReason: "Receipt unreadable", conn: db,
    });
    expect(rejected.status).toBe("rejected");
    expect(rejected.rejection_reason).toBe("Receipt unreadable");
  });

  // -------------------------------------------------------------------------
  // Period bucketing: the DATE/timezone trap.
  // -------------------------------------------------------------------------
  it("a claim is bucketed by the month the money was SPENT, not the month it was filed", async () => {
    const employee = await newEmployee(orgId, "LateFiling");
    // Filed in November for a September taxi. It belongs in September's payroll.
    await approvedClaim({ employeeUuid: employee, amount: 650, expenseDate: "2026-09-14" });
    await approvedClaim({ employeeUuid: employee, amount: 650, expenseDate: IN_PERIOD });

    const september = await getApprovedClaimsForPeriod({
      orgId, employeeUuid: employee, month: 9, year: YEAR, conn: db,
    });
    const october = await getApprovedClaimsForPeriod({
      orgId, employeeUuid: employee, month: MONTH, year: YEAR, conn: db,
    });
    expect(september).toHaveLength(1);
    expect(Number(september[0].amount)).toBe(650);
    expect(october).toHaveLength(1);
    // The date survives the DATE -> local-midnight -> string round trip intact,
    // which is the assertion that would fail under toISOString().
    expect(october[0].expense_date).toBe(IN_PERIOD);
    expect(september[0].expense_date).toBe("2026-09-14");
  });

  it("a direct-mode claim never reaches a payslip", async () => {
    const employee = await newEmployee(orgId, "DirectClaim");
    const claim = await approvedClaim({ employeeUuid: employee, amount: 900, paymentMode: "direct" });

    const payable = await getApprovedClaimsForPeriod({
      orgId, employeeUuid: employee, month: MONTH, year: YEAR, conn: db,
    });
    // Settled by bank transfer, so appearing here would pay it twice.
    expect(payable).toHaveLength(0);
    expect(expenseReimbursementLine(payable)).toBeNull();
    expect(claim.status).toBe("approved");
  });

  it("a direct claim cannot be hand-paid while it is routed through payroll, and vice versa", async () => {
    const payrollClaim = await approvedClaim({ employeeUuid: await newEmployee(orgId, "RoutedPayroll"), amount: 100 });
    await expect(
      markClaimPaid({ orgId, claimUuid: payrollClaim.uuid, conn: db }),
    ).rejects.toThrow(/through payroll/i);

    const directClaim = await approvedClaim({
      employeeUuid: await newEmployee(orgId, "RoutedDirect"),
      amount: 100,
      paymentMode: "direct",
    });
    // Paid on the direct route only.
    const paid = await markClaimPaid({ orgId, claimUuid: directClaim.uuid, conn: db });
    expect(paid.status).toBe("paid");
  });

  it("an unpaid claim from another month is not swept in by a later run", async () => {
    const employee = await newEmployee(orgId, "CrossPeriod");
    await approvedClaim({ employeeUuid: employee, amount: 300, expenseDate: "2026-09-02" });

    const october = await getApprovedClaimsForPeriod({
      orgId, employeeUuid: employee, month: MONTH, year: YEAR, conn: db,
    });
    // September's claim must not quietly ride October's payroll and then be
    // unavailable when September is regenerated.
    expect(october).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Submission rules.
  // -------------------------------------------------------------------------
  it("a claim over the category limit is refused at submission AND at review", async () => {
    const employee = await newEmployee(orgId, "OverLimit");
    // taxi is capped at 5000.
    await expect(file(6000, { employeeUuid: employee, categoryUuid: taxi.uuid })).rejects.toThrow(
      /exceeds the Taxi limit/i,
    );

    // And the limit can be TIGHTENED between submission and review, which is why it
    // is re-checked on approval rather than trusted from submission time.
    const claim = await file(4000, { employeeUuid: employee, categoryUuid: taxi.uuid });
    await attachReceipt(claim.uuid);
    await db.query("UPDATE expense_categories SET max_limit_per_claim=1000 WHERE uuid=?", [taxi.uuid]);
    try {
      await expect(
        reviewClaim({ orgId, claimUuid: claim.uuid, decision: "approved", conn: db }),
      ).rejects.toThrow(/exceeds the current Taxi limit/i);
    } finally {
      await db.query("UPDATE expense_categories SET max_limit_per_claim=5000 WHERE uuid=?", [taxi.uuid]);
    }
  });

  it("refuses a future expense and one beyond the backdate window", async () => {
    const employee = await newEmployee(orgId, "BadDates");
    await expect(file(100, { employeeUuid: employee, expenseDate: "2099-01-01" })).rejects.toThrow(
      /cannot be in the future/i,
    );

    const tooOld = new Date();
    tooOld.setDate(tooOld.getDate() - (MAX_BACKDATE_DAYS + 5));
    const old = tooOld.toISOString().slice(0, 10);
    await expect(file(100, { employeeUuid: employee, expenseDate: old })).rejects.toThrow(
      /more than 90 days ago/i,
    );
  });

  it("a claim cannot be filed by someone who has left the organization", async () => {
    const employee = await newEmployee(orgId, "Leaver");
    await db.query("UPDATE employees SET status='ex_employee' WHERE uuid=?", [employee]);
    await expect(file(100, { employeeUuid: employee })).rejects.toThrow(/left the organization/i);
  });

  // -------------------------------------------------------------------------
  // Tenancy.
  // -------------------------------------------------------------------------
  it("another organization's claim is invisible, and cannot be decided or paid", async () => {
    const mine = await approvedClaim({ employeeUuid: await newEmployee(orgId, "Mine"), amount: 500 });

    // The uuid is a real claim, just not this org's. It must read as absent rather
    // than as a permission error, which would confirm the row exists.
    await expect(loadClaim({ orgId: otherOrgId, claimUuid: mine.uuid, conn: db })).rejects.toThrow(
      /not found/i,
    );
    await expect(
      reviewClaim({ orgId: otherOrgId, claimUuid: mine.uuid, decision: "approved", conn: db }),
    ).rejects.toThrow(/not found/i);
    await expect(
      markClaimPaid({ orgId: otherOrgId, claimUuid: mine.uuid, conn: db }),
    ).rejects.toThrow(/not found/i);

    // And it is still untouched in its own org.
    const [rows] = await db.query("SELECT status FROM expense_claims WHERE uuid=?", [mine.uuid]);
    expect(rows[0].status).toBe("approved");
  });

  it("a claim cannot be filed against a category belonging to another organization", async () => {
    const theirCategory = await createCategory({
      orgId: otherOrgId,
      name: "Their Travel",
      conn: db,
    });
    const employee = await newEmployee(orgId, "WrongCategory");
    await expect(
      file(100, { employeeUuid: employee, categoryUuid: theirCategory.uuid }),
    ).rejects.toThrow(/not found/i);
  });

  it("an employee from another organization cannot have a claim filed for them", async () => {
    const outsider = await newEmployee(otherOrgId, "Outsider");
    await expect(file(100, { employeeUuid: outsider })).rejects.toThrow(/not found/i);
  });

  // -------------------------------------------------------------------------
  // Bulk settlement reporting.
  // -------------------------------------------------------------------------
  it("a bulk settlement reports what it paid AND what it refused", async () => {
    const good = await approvedClaim({ employeeUuid: await newEmployee(orgId, "BulkGood"), amount: 200, paymentMode: "direct" });
    const payroll = await approvedClaim({ employeeUuid: await newEmployee(orgId, "BulkPayroll"), amount: 200 });
    const pending = await file(200, { employeeUuid: await newEmployee(orgId, "BulkPending") });

    const result = await bulkMarkClaimsPaid({
      orgId,
      claimUuids: [good.uuid, payroll.uuid, pending.uuid],
      conn: db,
    });

    expect(result.paid).toEqual([good.uuid]);
    // Both refusals are reported, so a partial batch can never be mistaken for a
    // complete one - the failure mode a bare 200 would create here.
    expect(result.refused).toHaveLength(2);
    const reasons = result.refused.map((r) => r.reason).join(" ");
    expect(reasons).toMatch(/through payroll/i);
    expect(reasons).toMatch(/Only an approved claim/i);
  });

  // -------------------------------------------------------------------------
  // The payslip line.
  // -------------------------------------------------------------------------
  it("reimbursement is an EARNING, never a negative, and is absent when there is nothing to pay", async () => {
    const employee = await newEmployee(orgId, "LineShape");
    await approvedClaim({ employeeUuid: employee, amount: 100 });
    await approvedClaim({ employeeUuid: employee, amount: 250, expenseDate: "2026-10-07" });

    const claims = await getApprovedClaimsForPeriod({
      orgId, employeeUuid: employee, month: MONTH, year: YEAR, conn: db,
    });
    const line = expenseReimbursementLine(claims);

    // Money coming BACK to the employee. As a deduction it would cancel a real
    // earning on the same payslip and neither would be visible to the employee.
    expect(line.type).toBe("earning");
    expect(line.source).toBe("auto_expense");
    expect(line.amount).toBe(350);
    // A single claim is named; several are counted. Either way the reader can find
    // the underlying receipts.
    expect(line.label).toMatch(/2 claims/);

    // A zero line teaches people to ignore the lines that matter.
    expect(expenseReimbursementLine([])).toBeNull();
    expect(expenseReimbursementLine(null)).toBeNull();
  });

  it("a single claim is labelled by its category rather than as a count of one", async () => {
    const employee = await newEmployee(orgId, "SingleLabel");
    await approvedClaim({ employeeUuid: employee, amount: 100, categoryUuid: meals.uuid });
    const claims = await getApprovedClaimsForPeriod({
      orgId, employeeUuid: employee, month: MONTH, year: YEAR, conn: db,
    });
    expect(expenseReimbursementLine(claims).label).toMatch(/Meals/);
  });
});

/**
 * THE PART THAT ACTUALLY MOVES MONEY.
 *
 * Everything above tests the expense service in isolation. That is not the same
 * thing as the feature: the claim only becomes money because generatePayroll reads
 * it inside the salary transaction, writes an `auto_expense` earning line, and
 * consumes it in the same commit. Every one of those three steps lives in
 * salary.controller.js, not in expenses.service.js, so a suite that only calls the
 * service would pass while the payslip carried nothing at all.
 *
 * Driven through the real controller with a fake req/res rather than by exporting
 * computeEmployeePayroll for convenience: the risk here is not the arithmetic, it is
 * that the three writes happen in ONE transaction, and that is only observable from
 * outside the function.
 */

/** Minimal express response double: records what the handler sent. */
function fakeRes() {
  const sent = { status: null, body: null };
  return {
    sent,
    status(code) {
      sent.status = code;
      return this;
    },
    json(payload) {
      sent.body = payload;
      return this;
    },
    send() {
      return this;
    },
  };
}

/** An employee with a basic salary, so payroll has something to compute from. */
async function newPaidEmployee(name) {
  const uuid = await newEmployee(orgId, name);
  await db.query(
    `INSERT INTO employee_salary_history (uuid, employee_uuid, year, basic_salary, effective_from, effective_to)
     VALUES (UUID(), ?, ?, 30000, '2026-01-01', NULL)`,
    [uuid, YEAR],
  );
  return uuid;
}

describe.runIf(HAS_DB)("payroll carries approved claims onto the payslip and consumes them", () => {
  it("an approved claim becomes an auto_expense EARNING line and is marked paid by the run", async () => {
    const employee = await newPaidEmployee("PayslipEarning");
    const claim = await approvedClaim({ employeeUuid: employee, amount: 1250, categoryUuid: meals.uuid });

    const res = fakeRes();
    await generatePayroll(
      { scopeOrgId: orgId, body: { month: MONTH, year: YEAR, employee_uuids: [employee] }, user: { id: 1 } },
      res,
    );

    expect(res.sent.status).toBe(200);
    expect(res.sent.body.success).toBe(true);

    const [lines] = await db.query(
      "SELECT * FROM salary_record_lines WHERE organization_id=? AND employee_uuid=? AND source='auto_expense'",
      [orgId, employee],
    );
    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(Number(line.amount)).toBe(1250);
    // An earning, not a deduction: this is the employee's own money coming back.
    // As a deduction it would cancel a real earning on the same payslip.
    expect(line.type).toBe("earning");
    expect(Number(line.basis_value)).toBe(1);
    expect(line.basis_unit).toBe("claims");

    // Consumed in the same run, and traceable to the payslip that carried it.
    const [rows] = await db.query(
      "SELECT status, paid_at, paid_via_salary_record_uuid FROM expense_claims WHERE uuid=?",
      [claim.uuid],
    );
    expect(rows[0].status).toBe("paid");
    expect(rows[0].paid_at).toBeTruthy();
    expect(rows[0].paid_via_salary_record_uuid).toBeTruthy();

    const [records] = await db.query(
      "SELECT uuid FROM salary_records WHERE employee_uuid=? AND month=? AND year=?",
      [employee, MONTH, YEAR],
    );
    expect(rows[0].paid_via_salary_record_uuid).toBe(records[0].uuid);
    expect(res.sent.body.data.expense_claims_paid).toBe(1);
  });

  it("two claims on one payslip totalled into ONE line, and both claims consumed", async () => {
    const employee = await newPaidEmployee("PayslipTwoClaims");
    await approvedClaim({ employeeUuid: employee, amount: 400, expenseDate: "2026-10-05" });
    await approvedClaim({ employeeUuid: employee, amount: 650, expenseDate: "2026-10-06" });

    const res = fakeRes();
    await generatePayroll(
      { scopeOrgId: orgId, body: { month: MONTH, year: YEAR, employee_uuids: [employee] }, user: { id: 1 } },
      res,
    );

    const [lines] = await db.query(
      "SELECT * FROM salary_record_lines WHERE employee_uuid=? AND source='auto_expense'",
      [employee],
    );
    // ONE line carrying 1050, not two lines: the payslip should read as one
    // reimbursement, and the claim count is what proves both were included.
    expect(lines).toHaveLength(1);
    expect(Number(lines[0].amount)).toBe(1050);
    expect(Number(lines[0].basis_value)).toBe(2);

    const [unpaid] = await db.query(
      "SELECT COUNT(*) AS n FROM expense_claims WHERE employee_uuid=? AND status='approved'",
      [employee],
    );
    expect(Number(unpaid[0].n)).toBe(0);
  });

  it("a REGENERATED period does not pay the claim a second time", async () => {
    const employee = await newPaidEmployee("Regenerated");
    const claim = await approvedClaim({ employeeUuid: employee, amount: 900 });

    const first = fakeRes();
    await generatePayroll(
      { scopeOrgId: orgId, body: { month: MONTH, year: YEAR, employee_uuids: [employee] }, user: { id: 1 } },
      first,
    );
    expect(first.sent.body.data.expense_claims_paid).toBe(1);

    // Regenerate rewrites the period from scratch, which is the scenario most likely
    // to double-pay: it deletes and recreates every line, so a naive implementation
    // would re-read the claims. They are 'paid' now, so there is nothing to re-read.
    const second = fakeRes();
    await generatePayroll(
      {
        scopeOrgId: orgId,
        body: { month: MONTH, year: YEAR, employee_uuids: [employee], regenerate: true },
        user: { id: 1 },
      },
      second,
    );
    expect(second.sent.body.data.expense_claims_paid).toBe(0);

    const [lines] = await db.query(
      "SELECT amount FROM salary_record_lines WHERE employee_uuid=? AND source='auto_expense'",
      [employee],
    );
    // The payslip keeps the reimbursement, because the money really was paid once -
    // but only the ONE run's worth exists.
    expect(lines).toHaveLength(1);
    expect(Number(lines[0].amount)).toBe(900);

    const [rows] = await db.query("SELECT status FROM expense_claims WHERE uuid=?", [claim.uuid]);
    expect(rows[0].status).toBe("paid");
  });

  it("a claim consumed inside a transaction that ROLLS BACK stays approved and unpaid", async () => {
    const employee = await newPaidEmployee("Rollback");
    const claim = await approvedClaim({ employeeUuid: employee, amount: 700 });

    /**
     * THE PROPERTY, TESTED WITHOUT TOUCHING THE SCHEMA.
     *
     * markClaimsPaidByPayroll writes on the connection it is GIVEN. This opens a
     * transaction, consumes the claim, then rolls back, and asserts the claim is
     * untouched - which is only true if that UPDATE really did join the caller's
     * transaction.
     *
     * If the function ever used the pool instead, its UPDATE would commit on its
     * own connection immediately: this ROLLBACK would undo nothing and the
     * assertion would fail. So the test is not vacuous - it is a direct probe for
     * the exact mistake it describes.
     *
     * AN EARLIER VERSION RENAMED salary_record_lines out from under the code to
     * force a genuine mid-run failure. That was destructive to shared schema, and
     * vitest runs test FILES in parallel: payrollIntegration.db.test.js was
     * querying a table that did not exist while this file held it renamed. The
     * failure it produced was real, but it was produced by breaking another
     * suite, and a test that damages unrelated tests is worse than no test. A
     * rollback needs no broken schema to be meaningful.
     */
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await markClaimsPaidByPayroll({
        conn,
        orgId,
        salaryRecordUuid: "record-that-will-not-exist",
        claims: [{ uuid: claim.uuid, amount: 700 }],
      });

      const [inside] = await conn.query("SELECT status FROM expense_claims WHERE uuid=?", [
        claim.uuid,
      ]);
      // Visible as paid INSIDE the transaction...
      expect(inside[0].status).toBe("paid");

      await conn.rollback();

      // ...and gone after it. Being 'paid' is exactly what would exclude this claim
      // from every future payroll run, so a rolled-back run that left it marked
      // would lose the reimbursement silently and show it on no payslip.
      const [after] = await conn.query("SELECT status, paid_at FROM expense_claims WHERE uuid=?", [
        claim.uuid,
      ]);
      expect(after[0].status).toBe("approved");
      expect(after[0].paid_at).toBeNull();

      // And it is therefore still claimable by the next real run.
      const payable = await getApprovedClaimsForPeriod({
        orgId,
        employeeUuid: employee,
        month: MONTH,
        year: YEAR,
        conn: db,
      });
      expect(payable).toHaveLength(1);
    } finally {
      try {
        await conn.rollback();
      } catch {
        // Already rolled back; nothing to undo.
      }
      conn.release();
    }
  });

  it("a DIRECT claim survives payroll untouched, waiting to be transferred", async () => {
    const employee = await newPaidEmployee("DirectSurvives");
    await approvedClaim({ employeeUuid: employee, amount: 800, paymentMode: "direct" });

    const res = fakeRes();
    await generatePayroll(
      { scopeOrgId: orgId, body: { month: MONTH, year: YEAR, employee_uuids: [employee] }, user: { id: 1 } },
      res,
    );

    expect(res.sent.body.data.expense_claims_paid).toBe(0);
    const [lines] = await db.query(
      "SELECT COUNT(*) AS n FROM salary_record_lines WHERE employee_uuid=? AND source='auto_expense'",
      [employee],
    );
    expect(Number(lines[0].n)).toBe(0);
    const [rows] = await db.query(
      "SELECT status FROM expense_claims WHERE employee_uuid=?", [employee],
    );
    // Still approved, not paid: the payroll must not have settled a bank transfer.
    expect(rows[0].status).toBe("approved");
  });

  it("an employee with no approved claims gets NO reimbursement line", async () => {
    const employee = await newPaidEmployee("NoClaims");
    const res = fakeRes();
    await generatePayroll(
      { scopeOrgId: orgId, body: { month: MONTH, year: YEAR, employee_uuids: [employee] }, user: { id: 1 } },
      res,
    );
    expect(res.sent.body.data.expense_claims_paid).toBe(0);
    const [lines] = await db.query(
      "SELECT COUNT(*) AS n FROM salary_record_lines WHERE employee_uuid=? AND source='auto_expense'",
      [employee],
    );
    // A Rs 0.00 reimbursement row on every payslip is noise that teaches people to
    // ignore the lines that matter.
    expect(Number(lines[0].n)).toBe(0);
  });

  it("a claim from a DIFFERENT month is not paid by this run", async () => {
    const employee = await newPaidEmployee("OtherMonth");
    await approvedClaim({ employeeUuid: employee, amount: 600, expenseDate: "2026-09-08" });

    const res = fakeRes();
    await generatePayroll(
      { scopeOrgId: orgId, body: { month: MONTH, year: YEAR, employee_uuids: [employee] }, user: { id: 1 } },
      res,
    );

    // October's payroll must not consume September's reimbursement, or September
    // would find it already paid when it is regenerated.
    expect(res.sent.body.data.expense_claims_paid).toBe(0);
    const [rows] = await db.query("SELECT status FROM expense_claims WHERE employee_uuid=?", [employee]);
    expect(rows[0].status).toBe("approved");
  });
});