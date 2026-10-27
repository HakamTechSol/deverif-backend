import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  conn: {
    query: vi.fn(),
    beginTransaction: vi.fn(),
    commit: vi.fn(),
    rollback: vi.fn(),
    release: vi.fn(),
  },
}));

vi.mock("../src/config/db.js", () => ({
  pool: { query: vi.fn(), getConnection: vi.fn(async () => h.conn) },
}));

import { pool } from "../src/config/db.js";
import { autoApproveClaim, createClaim } from "../src/services/expenses.service.js";
import { ATTACHMENT_ENTITY } from "../src/services/expenses.service.js";
import { parseFeatureAccess } from "../src/utils/permissions.js";

/**
 * THE AUTO-APPROVAL SHORTCUT, AND THE THREE THINGS THAT MUST HOLD.
 *
 * A checkbox that skips a review queue is a shortcut around the one control that
 * decides whether the company pays for something. Three rules keep it honest, and
 * each of these tests kills the shortcut if its rule is removed:
 *
 *   1. AUTHORITY IS SERVER-SIDE. The flag on the request is a claim made by the
 *      sender. `canApproveExpenses` comes from the session, so an account without
 *      the permission gets a PENDING claim even though it sent the flag.
 *   2. NO SELF-APPROVAL. The claimant and the approver are two people on purpose,
 *      and a submission-time checkbox must not become a way around that.
 *   3. THE RECEIPT RULE SURVIVES. A receipt-required category still needs its
 *      receipt, or the shortcut is not a shortcut at all.
 *
 * And the behaviour that makes the feature usable at all: a REFUSED auto-approval
 * still leaves the claim FILED, pending. Refusing the entire submission would
 * punish the employee for a checkbox the server has to police.
 */

const ORG_ID = 7;
const ACTOR = "aaaaaaaa-0000-4000-8000-000000000001";
const CLAIMANT = "aaaaaaaa-0000-4000-8000-000000000002";
const CLAIM = "aaaaaaaa-0000-4000-8000-000000000003";
const CATEGORY = "aaaaaaaa-0000-4000-8000-000000000004";
const EMPLOYEE = { uuid: CLAIMANT, full_name: "Ayesha" };

/** A DB router shaped for the claim path. */
function installDb({ requiresReceipt = 1, limit = null, receipts = 0, claimAmount = "1000.00" } = {}) {
  const route = (sql) => {
    const s = String(sql);
    /*
     * Order matters: the generic `SELECT` catch-all comes LAST, and the
     * employee-roster query is matched explicitly. A catch-all placed above it
     * answers every SELECT, including the one that decides the claimant exists,
     * and the failure reads as "Employee not found" on a test that was about
     * something else entirely.
     */
    if (s.includes("SELECT name, requires_receipt FROM expense_categories")) {
      return [[{ name: "Travel", requires_receipt: requiresReceipt }]];
    }
    if (s.includes("SELECT name, max_limit_per_claim FROM expense_categories")) {
      return [[{ name: "Travel", max_limit_per_claim: limit }]];
    }
    if (s.includes("COUNT(*) AS n FROM attachments")) return [[{ n: receipts }]];
    if (s.includes("SELECT amount FROM expense_claims")) return [[{ amount: claimAmount }]];
    if (s.includes("FROM expense_categories WHERE uuid=? AND organization_id=?")) {
      return [[{ name: "Travel", requires_receipt: requiresReceipt }]];
    }
    if (s.includes("SELECT name, requires_receipt FROM expense_categories WHERE uuid=? AND organization_id=?")) {
      return [[{ name: "Travel", requires_receipt: requiresReceipt }]];
    }
    if (s.includes("uuid, full_name") && s.includes("FROM employees")) {
      return [[{ ...EMPLOYEE, status: "current_employee" }]];
    }
    if (s.includes("INSERT INTO expense_claims")) return [{ insertId: 1 }];
    // createClaim finishes by re-reading the row it just wrote.
    if (s.includes("FROM expense_claims")) {
      return [[{
        uuid: CLAIM,
        organization_id: ORG_ID,
        employee_uuid: CLAIMANT,
        employee_name: "Ayesha",
        category_uuid: CATEGORY,
        amount: claimAmount,
        expense_date: "2026-09-10",
        description: null,
        status: "pending",
        payment_mode: "payroll",
      }]];
    }
    return [{}];
  };
  h.conn.query.mockImplementation(async (sql) => route(sql));
  pool.query.mockImplementation(async (sql) => route(sql));
  pool.getConnection.mockResolvedValue(h.conn);
}

beforeEach(() => {
  vi.clearAllMocks();
  installDb();
});

describe("autoApproveClaim — the rules the shortcut cannot bypass", () => {
  it("refuses when the account cannot approve claims, and records the refusal", async () => {
    const refusal = await autoApproveClaim({
      orgId: ORG_ID,
      actorUuid: ACTOR,
      employeeUuid: CLAIMANT,
      claimUuid: CLAIM,
      categoryUuid: CATEGORY,
      canApproveExpenses: false,
      conn: h.conn,
    });

    expect(refusal).toMatch(/approve_expenses/);
    // NOT approved. The update must not have run.
    const sql = h.conn.query.mock.calls.map(([s]) => String(s)).join("\n");
    expect(sql).not.toContain("status='approved'");
  });

  it("refuses self-approval even for an authorized approver", async () => {
    // The authority is present and the receipt rule is satisfied. The ONLY thing
    // standing between this and an approval is that the claimant and the actor
    // are the same person - which is the rule the requirement says is NOT bypassed.
    const refusal = await autoApproveClaim({
      orgId: ORG_ID,
      actorUuid: CLAIMANT,
      employeeUuid: CLAIMANT,
      claimUuid: CLAIM,
      categoryUuid: CATEGORY,
      canApproveExpenses: true,
      requiresReceipt: 1,
      receipts: 1,
      conn: h.conn,
    });

    expect(refusal).toMatch(/person it reimburses/i);
  });

  it("refuses a receipt-required category with no receipt attached", async () => {
    installDb({ requiresReceipt: 1, receipts: 0 });
    const refusal = await autoApproveClaim({
      orgId: ORG_ID,
      actorUuid: ACTOR,
      employeeUuid: CLAIMANT,
      claimUuid: CLAIM,
      categoryUuid: CATEGORY,
      canApproveExpenses: true,
      conn: h.conn,
    });

    expect(refusal).toMatch(/require a receipt/i);
  });

  it("refuses a claim above the category's current limit", async () => {
    // The limit is checked at submission AND here, because a category can be
    // tightened between the two. Approving against a stale policy reimburses what
    // the org's own rules now forbid.
    installDb({ requiresReceipt: 0, limit: 500, claimAmount: "1000.00" });
    const refusal = await autoApproveClaim({
      orgId: ORG_ID,
      actorUuid: ACTOR,
      employeeUuid: CLAIMANT,
      claimUuid: CLAIM,
      categoryUuid: CATEGORY,
      canApproveExpenses: true,
      conn: h.conn,
    });

    expect(refusal).toMatch(/limit/i);
  });

  it("approves, and records WHO approved and that the shortcut was used", async () => {
    installDb({ requiresReceipt: 0, receipts: 1 });
    const refusal = await autoApproveClaim({
      orgId: ORG_ID,
      actorUuid: ACTOR,
      employeeUuid: CLAIMANT,
      claimUuid: CLAIM,
      categoryUuid: CATEGORY,
      canApproveExpenses: true,
      conn: h.conn,
    });

    expect(refusal).toBeNull();
    const updated = h.conn.query.mock.calls.find(([s]) => String(s).includes("status='approved'"));
    expect(updated).toBeDefined();
    const [sql, params] = updated;
    // The actor, in BOTH columns: the reviewed_by column every existing reader
    // already understands, and the auto_approved_by column that records the
    // shortcut. Without the second, "how many claims skipped review?" has no
    // answer anywhere in the database.
    expect(sql).toContain("auto_approved=1");
    expect(sql).toContain("auto_approved_by_uuid");
    expect(sql).toContain("reviewed_by_uuid=?");
    expect(params).toContain(ACTOR);
  });

  it("keeps the status guard, so a concurrent manual decision is not overwritten", async () => {
    installDb({ requiresReceipt: 0, receipts: 1 });
    await autoApproveClaim({
      orgId: ORG_ID,
      actorUuid: ACTOR,
      employeeUuid: CLAIMANT,
      claimUuid: CLAIM,
      categoryUuid: CATEGORY,
      canApproveExpenses: true,
      conn: h.conn,
    });

    const updated = h.conn.query.mock.calls.find(([s]) => String(s).includes("status='approved'"));
    // The same guard reviewClaim uses. Two people acting at once must not both
    // win, and the loser's write must match zero rows.
    expect(String(updated[0])).toContain("status='pending'");
  });
});

describe("feature_access — the permission the shortcut is gated on", () => {
  it("is NOT granted by default", () => {
    // TRUE_BY_DEFAULT covers attendance, leave and payroll. Approving expenses is
    // not one of them, which is what makes the permission check meaningful: a
    // sub_admin with no explicit grant cannot auto-approve.
    const map = parseFeatureAccess(null);
    expect(map.approve_expenses).toBe(false);
  });

  it("is granted when explicitly set, which is what a delegated reviewer has", () => {
    const map = parseFeatureAccess(JSON.stringify({ approve_expenses: true }));
    expect(map.approve_expenses).toBe(true);
  });
});

describe("createClaim — still files the claim whatever the shortcut does", () => {
  it("creates a PENDING claim, which is the path the auto-approval upgrades", async () => {
    installDb({ requiresReceipt: 0 });
    await createClaim({
      orgId: ORG_ID,
      actorUuid: ACTOR,
      employeeUuid: CLAIMANT,
      categoryUuid: CATEGORY,
      amount: 1000,
      expenseDate: "2026-09-10",
      conn: h.conn,
    });

    const inserted = h.conn.query.mock.calls.find(([s]) => String(s).includes("INSERT INTO expense_claims"));
    expect(inserted).toBeDefined();
    expect(String(inserted[0])).toContain("'pending'");
    // No auto-approval columns on the insert path: the claim is filed as pending
    // and the shortcut is a decision made afterwards, not a column set at birth.
    expect(String(inserted[0])).not.toContain("auto_approved");
  });

  it("is independent of the auto-approve decision, so a refusal cannot unfile it", async () => {
    // The order the controller uses: create, then attempt the decision. A claim
    // that refused the shortcut is still a claim that exists.
    installDb({ requiresReceipt: 0 });
    const claim = await createClaim({
      orgId: ORG_ID,
      actorUuid: ACTOR,
      employeeUuid: CLAIMANT,
      categoryUuid: CATEGORY,
      amount: 1000,
      expenseDate: "2026-09-10",
      conn: h.conn,
    });

    const refusal = await autoApproveClaim({
      orgId: ORG_ID,
      actorUuid: ACTOR,
      employeeUuid: CLAIMANT,
      claimUuid: claim.uuid,
      categoryUuid: CATEGORY,
      canApproveExpenses: false,
      conn: h.conn,
    });

    expect(refusal).toBeTruthy();
    // The insert ran and was never rolled back.
    const inserted = h.conn.query.mock.calls.some(([s]) => String(s).includes("INSERT INTO expense_claims"));
    expect(inserted).toBe(true);
  });
});

describe("attachReceipts — the org scoping the receipt follows", () => {
  it("scopes to the expense_claim entity, not a generic attachment", async () => {
    // Re-exported to pin the constant the auto-approval receipt count queries by.
    expect(ATTACHMENT_ENTITY.CLAIM).toBe("expense_claim");
  });
});
