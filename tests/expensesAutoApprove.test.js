import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const h = vi.hoisted(() => ({
  conn: {
    query: vi.fn(),
    beginTransaction: vi.fn(),
    commit: vi.fn(),
    rollback: vi.fn(),
    release: vi.fn(),
  },
  claim: null,
  payrollPeriods: new Set(),
  payrollClaims: [],
}));

vi.mock("../src/config/db.js", () => ({
  pool: { query: vi.fn(), getConnection: vi.fn(async () => h.conn) },
}));

import { pool } from "../src/config/db.js";
import {
  approveOwnClaim,
  createClaim,
  expenseReimbursementLine,
  getApprovedClaimsForPeriod,
  markClaimsPaidByPayroll,
  reviewClaim,
} from "../src/services/expenses.service.js";
import { hasPermission, parseFeatureAccess } from "../src/utils/permissions.js";

const ORG_ID = 7;
const ACTOR = "aaaaaaaa-0000-4000-8000-000000000001";
const EMPLOYEE = "aaaaaaaa-0000-4000-8000-000000000002";
const CLAIM = "aaaaaaaa-0000-4000-8000-000000000003";
const EXPENSE_MIGRATION = readFileSync(
  "migrations/20261226_expense_permissions_payroll_safety.sql",
  "utf8",
);
const STANDALONE_EXPENSE_MIGRATION = readFileSync(
  "migrations/20261227_standalone_subadmin_expenses.sql",
  "utf8",
);

function installDb() {
  const query = async (sql, params = []) => {
    const text = String(sql);
    if (text.includes("FROM employees")) {
      return [[{ uuid: EMPLOYEE, full_name: "Ayesha", status: "current_employee" }]];
    }
    if (text.includes("FROM expense_claims") && text.includes("SELECT *")) {
      return h.claim ? [[{ ...h.claim }]] : [[]];
    }
    if (text.includes("FROM salary_records") && text.includes("employee_uuid=? AND year=?")) {
      const month = Number(params[3]);
      const year = Number(params[2]);
      return [h.payrollPeriods.has(`${year}-${month}`) ? [{ uuid: "existing" }] : []];
    }
    if (text.includes("FROM salary_records") && text.includes("employee_uuid=?")) {
      return [[{ uuid: params[0] }]];
    }
    if (text.includes("FROM expense_payroll_period_locks")) return [[]];
    if (text.includes("FROM attachments")) return [[]];
    if (text.includes("SELECT c.uuid, c.amount")) return [h.payrollClaims];
    if (text.includes("INSERT INTO expense_claims")) {
      h.claim = {
        uuid: CLAIM,
        organization_id: ORG_ID,
        employee_uuid: params[2],
        employee_name: params[3],
        expense_name: "Taxi",
        amount: "1000.00",
        expense_date: "2026-09-10",
        description: null,
        status: "pending",
        payment_mode: params[8],
        auto_approved: 0,
        created_by: params[9],
      };
      return [{ insertId: 1 }];
    }
    if (text.startsWith("UPDATE expense_claims")) {
      const isPayrollPayment = text.includes("paid_via_salary_record_uuid");
      if (text.includes("status='pending'") && h.claim?.status !== "pending") {
        return [{ affectedRows: 0 }];
      }
      if (text.includes("SET status='approved'")) {
        h.claim.status = "approved";
        h.claim.auto_approved = 1;
        h.claim.auto_approved_by_uuid = params[0];
        h.claim.reviewed_by_uuid = params[1];
        h.claim.reimbursement_month = params[2];
        h.claim.reimbursement_year = params[3];
      } else if (text.includes("SET status=?")) {
        h.claim.status = params[0];
        h.claim.payment_mode = params[1];
        h.claim.rejection_reason = params[3];
      } else if (isPayrollPayment) {
        h.claim.status = "paid";
        h.claim.paid_via_salary_record_uuid = params[1];
      }
      return [{ affectedRows: 1 }];
    }
    return [[]];
  };
  h.conn.query.mockImplementation(query);
  pool.query.mockImplementation(query);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.payrollPeriods = new Set();
  h.payrollClaims = [];
  h.claim = {
    uuid: CLAIM,
    organization_id: ORG_ID,
    employee_uuid: EMPLOYEE,
    employee_name: "Ayesha",
    expense_name: "Taxi",
    amount: "1000.00",
    expense_date: "2026-09-10",
    description: null,
    status: "pending",
    payment_mode: "payroll",
    auto_approved: 0,
    created_by: ACTOR,
  };
  installDb();
});

describe("independent Sub Admin expense permissions", () => {
  it("defaults both capabilities off and does not infer one from the other", () => {
    const defaults = parseFeatureAccess(null);
    expect(defaults.create_expenses).toBe(false);
    expect(defaults.approve_expenses).toBe(false);
    expect(hasPermission({ org_role: "sub_admin", feature_access: { create_expenses: true } }, "create_expenses")).toBe(true);
    expect(hasPermission({ org_role: "sub_admin", feature_access: { create_expenses: true } }, "approve_expenses")).toBe(false);
    expect(hasPermission({ org_role: "sub_admin", feature_access: { approve_expenses: true } }, "create_expenses")).toBe(false);
  });

  describe("expense payment migration contract", () => {
    it("backfills paid claims and prevents duplicate or cross-tenant payment links", () => {
      expect(EXPENSE_MIGRATION).toContain("INSERT INTO expense_claim_payments");
      expect(EXPENSE_MIGRATION).toContain("WHERE c.status = 'paid'");
      expect(EXPENSE_MIGRATION).toContain("UNIQUE KEY uk_expense_claim_payments_claim (claim_uuid)");
      expect(EXPENSE_MIGRATION).toContain("FOREIGN KEY (organization_id, claim_uuid, employee_uuid)");
      expect(EXPENSE_MIGRATION).toContain("FOREIGN KEY (organization_id, salary_record_uuid, employee_uuid)");
      expect(EXPENSE_MIGRATION).not.toMatch(/DROP\s+TABLE/i);
    });

    it("allows standalone claim and payment rows while retaining tenant-scoped claim integrity", () => {
      expect(STANDALONE_EXPENSE_MIGRATION).toContain("MODIFY employee_uuid CHAR(36) DEFAULT NULL");
      expect(STANDALONE_EXPENSE_MIGRATION).toContain("FOREIGN KEY (organization_id, claim_uuid)");
      expect(STANDALONE_EXPENSE_MIGRATION).toContain("REFERENCES expense_claims (organization_id, uuid)");
      expect(STANDALONE_EXPENSE_MIGRATION).not.toMatch(/DROP\s+TABLE/i);
    });
  });
});

describe("Sub Admin own-claim approval bypass", () => {
  it("approves as part of the create transaction and records the actor", async () => {
    const claim = await approveOwnClaim({
      orgId: ORG_ID,
      actorUuid: ACTOR,
      claimUuid: CLAIM,
      conn: h.conn,
    });

    expect(claim.status).toBe("approved");
    const update = h.conn.query.mock.calls.find(([sql]) => String(sql).includes("SET status='approved'"));
    expect(update[0]).toContain("auto_approved=1");
    expect(update[0]).toContain("auto_approved_by_uuid");
    expect(update[1]).toContain(ACTOR);
    expect(update[0]).toContain("status='pending'");
  });

  it("assigns an already-generated payroll period to the next eligible month", async () => {
    h.payrollPeriods.add("2026-9");
    await approveOwnClaim({ orgId: ORG_ID, actorUuid: ACTOR, claimUuid: CLAIM, conn: h.conn });
    expect(h.claim.reimbursement_year).toBe(2026);
    expect(h.claim.reimbursement_month).toBe(10);
  });

  it("rejects duplicate/concurrent approval after the first state transition", async () => {
    await approveOwnClaim({ orgId: ORG_ID, actorUuid: ACTOR, claimUuid: CLAIM, conn: h.conn });
    await expect(
      approveOwnClaim({ orgId: ORG_ID, actorUuid: ACTOR, claimUuid: CLAIM, conn: h.conn }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("allows only one of two concurrent approvals to win", async () => {
    const results = await Promise.allSettled([
      approveOwnClaim({ orgId: ORG_ID, actorUuid: ACTOR, claimUuid: CLAIM, conn: h.conn }),
      approveOwnClaim({ orgId: ORG_ID, actorUuid: ACTOR, claimUuid: CLAIM, conn: h.conn }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });
});

describe("expense workflow and payroll eligibility", () => {
  it("creates and auto-approves a direct claim without an employee or payroll period", async () => {
    h.claim = null;
    await createClaim({
      orgId: ORG_ID,
      actorUuid: ACTOR,
      employeeUuid: null,
      employeeName: "Sub-admin",
      expenseName: "Taxi",
      amount: 1000,
      expenseDate: "2026-09-10",
      paymentMode: "direct",
      conn: h.conn,
    });

    expect(h.claim.employee_uuid).toBeNull();
    expect(h.claim.employee_name).toBe("Sub-admin");
    expect(h.claim.payment_mode).toBe("direct");

    await approveOwnClaim({ orgId: ORG_ID, actorUuid: ACTOR, claimUuid: CLAIM, conn: h.conn });
    expect(h.claim.status).toBe("approved");
    expect(h.claim.reimbursement_year).toBeNull();
  });

  it("rejects an employee-less claim unless direct payment is selected", async () => {
    await expect(createClaim({
      orgId: ORG_ID,
      actorUuid: ACTOR,
      employeeUuid: null,
      employeeName: "Sub-admin",
      expenseName: "Taxi",
      amount: 1000,
      expenseDate: "2026-09-10",
      paymentMode: "payroll",
      conn: h.conn,
    })).rejects.toMatchObject({ statusCode: 400 });
  });

  it("creates claims pending, while a rejection leaves them out of payroll", async () => {
    h.claim = null;
    await createClaim({
      orgId: ORG_ID,
      actorUuid: ACTOR,
      employeeUuid: EMPLOYEE,
      expenseName: "Taxi",
      amount: 1000,
      expenseDate: "2026-09-10",
      conn: h.conn,
    });
    expect(h.claim.status).toBe("pending");
    const rejected = await reviewClaim({
      orgId: ORG_ID,
      actorUuid: ACTOR,
      claimUuid: CLAIM,
      decision: "rejected",
      rejectionReason: "Receipt details are missing",
      conn: h.conn,
    });
    expect(rejected.status).toBe("rejected");
    expect(h.conn.query.mock.calls.some(([sql]) => String(sql).includes("expense_claim_payments"))).toBe(false);
  });

  it("feeds only approved claims assigned to the payroll period", async () => {
    h.payrollClaims = [{
      uuid: CLAIM,
      amount: "1000.00",
      expense_date: "2026-09-10",
      expense_name: "Taxi",
    }];
    const claims = await getApprovedClaimsForPeriod({
      orgId: ORG_ID,
      employeeUuid: EMPLOYEE,
      month: 9,
      year: 2026,
      conn: h.conn,
    });
    expect(claims).toHaveLength(1);
    const query = h.conn.query.mock.calls.find(([sql]) => String(sql).includes("SELECT c.uuid, c.amount"));
    expect(query[0]).toContain("status = 'approved'");
    expect(query[0]).toContain("COALESCE(c.reimbursement_year, c.expense_year)");
    expect(query[0]).toContain("<= ?");
    expect(query[1]).toEqual([ORG_ID, EMPLOYEE, 2026, 2026, 9]);
    expect(expenseReimbursementLine(claims).amount).toBe(1000);
  });

  it("excludes pending claims and scopes payroll candidates by tenant", async () => {
    h.payrollClaims = [];
    const claims = await getApprovedClaimsForPeriod({
      orgId: ORG_ID,
      employeeUuid: EMPLOYEE,
      month: 9,
      year: 2026,
      conn: h.conn,
    });
    expect(claims).toEqual([]);
    const query = h.conn.query.mock.calls.find(([sql]) => String(sql).includes("SELECT c.uuid, c.amount"));
    expect(query[0]).toContain("c.status = 'approved'");
    expect(query[1][0]).toBe(ORG_ID);
    expect(query[1][1]).toBe(EMPLOYEE);
  });

  it("writes exactly one payment history record when payroll consumes a claim", async () => {
    h.claim.status = "approved";
    await markClaimsPaidByPayroll({
      conn: h.conn,
      orgId: ORG_ID,
      salaryRecordUuid: "bbbbbbbb-0000-4000-8000-000000000001",
      claims: [{ uuid: CLAIM }],
      performedByUuid: ACTOR,
    });
    expect(h.claim.status).toBe("paid");
    expect(h.conn.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO expense_claim_payments"))).toBe(true);
    await expect(markClaimsPaidByPayroll({
      conn: h.conn,
      orgId: ORG_ID,
      salaryRecordUuid: "bbbbbbbb-0000-4000-8000-000000000002",
      claims: [{ uuid: CLAIM }],
    })).rejects.toMatchObject({ statusCode: 409 });
  });
});
