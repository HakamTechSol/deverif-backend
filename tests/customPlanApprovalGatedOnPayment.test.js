import { describe, it, expect, vi, beforeEach } from "vitest";

// Custom-plan approval must NOT activate a subscription.
//
// The behaviour being guarded: approval used to run resolveSubscriptionChange +
// applySubscriptionChange inline, so approving a request moved the organization
// onto the custom plan immediately (or scheduled it) without any money changing
// hands, and quietly exempted custom plans from the upgrade/schedule rule that
// every other plan obeys.
//
// Approval now records the negotiation and creates a pending checkout. Activation
// happens only when that checkout's webhook succeeds, and then through the
// ordinary tier comparison.

const h = vi.hoisted(() => {
  const poolQuery = vi.fn();
  const connQuery = vi.fn();
  const connection = {
    query: connQuery,
    beginTransaction: vi.fn(),
    commit: vi.fn(),
    rollback: vi.fn(),
    release: vi.fn(),
  };
  return {
    poolQuery,
    connQuery,
    connection,
    getConnection: vi.fn(),
    notify: vi.fn(),
    session: vi.fn(),
    passport: vi.fn(),
    checkoutUrl: vi.fn(),
  };
});

vi.mock("../src/config/db.js", () => ({
  pool: { query: h.poolQuery, getConnection: h.getConnection },
}));
vi.mock("../src/controllers/notification.controller.js", () => ({
  createNotificationForOrgUsers: (arg) => h.notify(arg),
}));
vi.mock("../src/services/safepay.service.js", () => ({
  createSafepayPaymentSession: (arg) => h.session(arg),
  createSafepayAuthToken: () => h.passport(),
  buildSafepayCheckoutUrl: (arg) => h.checkoutUrl(arg),
  getSafepayPaymentStatus: vi.fn(),
  refundSafepayPayment: vi.fn(),
}));

import { pool } from "../src/config/db.js";
import { approveCustomPlanRequest } from "../src/controllers/admin/subscription.controller.js";

const REQ_UUID = "cccccccc-dddd-4eee-8fff-000000000001";
const ORG_ID = 7;

const CUSTOM_PLAN = { uuid: "plan-uuid", name: "Custom Plan — Acme", monthly_price: "25000.00" };

/**
 * Route the approval transaction's queries. Deliberately records EVERY write so
 * the test can assert on what was and was not touched.
 */
function setupApproval() {
  h.connQuery.mockImplementation(async (sql) => {
    const stmt = String(sql);
    if (/^\s*SELECT/i.test(stmt)) {
      if (stmt.includes("FROM custom_plan_requests")) {
        return [[{ id: 3, organization_id: ORG_ID, status: "pending", organization_uuid: "org-uuid", organization_name: "Acme" }]];
      }
      if (stmt.includes("FROM subscription_plans")) return [[CUSTOM_PLAN]];
      if (stmt.includes("FROM subscription_checkouts WHERE id=?")) return [[{ id: 21, uuid: "checkout-uuid" }]];
      return [[]];
    }
    if (/^\s*INSERT/i.test(stmt)) return [{ insertId: 55, affectedRows: 1 }];
    return [{ affectedRows: 1 }];
  });
  h.connection.beginTransaction.mockResolvedValue(undefined);
  h.connection.commit.mockResolvedValue(undefined);
  h.connection.rollback.mockResolvedValue(undefined);
  h.getConnection.mockResolvedValue(h.connection);

  h.poolQuery.mockImplementation(async (sql) => {
    const stmt = String(sql);
    if (stmt.includes("FROM custom_plan_requests")) return [[{ id: 3, uuid: REQ_UUID, status: "approved" }]];
    if (stmt.includes("FROM subscription_plans")) return [[{ ...CUSTOM_PLAN, daily_request_quota: 50, is_custom: 1 }]];
    if (stmt.includes("UPDATE subscription_checkouts SET gateway_tracker_id")) return [{ affectedRows: 1 }];
    return [[]];
  });
}

function req() {
  return {
    params: { uuid: REQ_UUID },
    body: { daily_quota: 50, price: 25000 },
    admin: { uuid: "admin-uuid" },
  };
}
function res() {
  const r = {};
  r.status = vi.fn().mockReturnValue(r);
  r.json = vi.fn().mockReturnValue(r);
  return r;
}

const connSqls = () => h.connQuery.mock.calls.map(([sql]) => String(sql).replace(/\s+/g, " ").trim());

beforeEach(() => {
  vi.clearAllMocks();
  h.getConnection.mockReset();
  setupApproval();
  h.session.mockResolvedValue({ token: "trk_custom" });
  h.passport.mockResolvedValue("TBT");
  h.checkoutUrl.mockReturnValue("https://sandbox.example/checkout");
  h.notify.mockResolvedValue(undefined);
});

describe("approving a custom-plan request does NOT activate the subscription", () => {
  it("marks the request approved and links the plan it created", async () => {
    await approveCustomPlanRequest(req(), res());

    const update = h.connQuery.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE custom_plan_requests") && String(sql).includes("status='approved'")
    );
    expect(update).toBeDefined();
    // [quota, price, approvedPlanId, decidedBy, requestId]
    //
    // approved_plan_id is what makes the approval actionable: it is the edge the
    // org admin needs to open a checkout for exactly this plan. Without it the
    // approved request is a dead end, because subscription_plans has no
    // organization_id and the generated plan name is not a reliable key.
    expect(update[1]).toEqual([50, "25000.00", 55, "admin-uuid", 3]);
    expect(String(update[0])).toContain("approved_plan_id");
  });

  it("creates a PENDING checkout for the negotiated price and quota", async () => {
    await approveCustomPlanRequest(req(), res());

    const insert = h.connQuery.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO subscription_checkouts")
    );
    expect(insert).toBeDefined();
    // [orgId, planId, planUuid, planName, amount, metadata]
    expect(insert[1][0]).toBe(ORG_ID);
    expect(insert[1][1]).toBe(55);
    expect(insert[1][4]).toBe(25000);
    expect(String(insert[0])).toContain("'pending'");
  });

  it("NEVER writes organizations.subscription_* on this path", async () => {
    await approveCustomPlanRequest(req(), res());

    // This is the whole point. An UPDATE (or INSERT) touching the org's
    // subscription plan, status or expiry here would be an activation that
    // nobody paid for.
    for (const sql of connSqls()) {
      if (/UPDATE\s+organizations|INSERT\s+INTO\s+organizations/i.test(sql)) {
        expect(sql).not.toMatch(/subscription_plan_id/);
        expect(sql).not.toMatch(/subscription_status/);
        expect(sql).not.toMatch(/subscription_expiry/);
        expect(sql).not.toMatch(/pending_plan_id/);
      }
    }
  });

  it("does not run the shared transition logic at all", async () => {
    await approveCustomPlanRequest(req(), res());

    // applySubscriptionChange is the only writer of organizations.subscription_*,
    // so proving it was never reached proves no activation could have happened.
    for (const sql of connSqls()) {
      if (/UPDATE\s+organizations/i.test(sql)) {
        expect(sql).not.toContain("subscription_start=");
        expect(sql).not.toContain("reminder_2d_sent");
      }
    }
    // Nor is the org row even locked/loaded for a transition.
    expect(connSqls().some((s) => /FROM organizations WHERE id=\? FOR UPDATE/i.test(s))).toBe(false);
  });

  it("reports awaiting_payment rather than claiming activation", async () => {
    const r = res();
    await approveCustomPlanRequest(req(), r);

    const payload = r.json.mock.calls[0][0];
    const data = payload?.data ?? payload;
    expect(data.subscription_activated).toBe(false);
    expect(data.awaiting_payment).toBe(true);
    expect(data.checkout_uuid).toBe("checkout-uuid");
  });

  it("notifies the org admin with a payment link", async () => {
    await approveCustomPlanRequest(req(), res());

    expect(h.notify).toHaveBeenCalledTimes(1);
    const arg = h.notify.mock.calls[0][0];
    expect(arg.orgId).toBe(ORG_ID);
    expect(arg.link).toBe("https://sandbox.example/checkout");
    expect(arg.message).toMatch(/payment/i);
  });

  it("still approves if the payment session cannot be created", async () => {
    // The org still owes the negotiated amount, so the approval and its
    // checkout must stand. Rolling back here would leave the admin thinking
    // nothing happened.
    h.session.mockRejectedValue(new Error("gateway down"));

    const r = res();
    await approveCustomPlanRequest(req(), r);

    expect(h.connection.rollback).not.toHaveBeenCalled();
    const payload = r.json.mock.calls[0][0];
    const data = payload?.data ?? payload;
    expect(data.awaiting_payment).toBe(true);
    // Falls back to the payments page so the org can still retry.
    expect(h.notify.mock.calls[0][0].link).toBe("/payments");
  });

  it("cancels any stale pending checkout so two live sessions cannot coexist", async () => {
    await approveCustomPlanRequest(req(), res());

    const cancel = h.connQuery.mock.calls.find(([sql]) =>
      String(sql).includes("SET status='cancelled'")
    );
    expect(cancel).toBeDefined();
    expect(cancel[1]).toEqual([ORG_ID]);
  });
});

describe("approving a custom-plan request still validates its input and state", () => {
  it("rejects a non-positive quota", async () => {
    await expect(
      approveCustomPlanRequest({ ...req(), body: { daily_quota: 0, price: 100 } }, res())
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects a negative price", async () => {
    await expect(
      approveCustomPlanRequest({ ...req(), body: { daily_quota: 10, price: -5 } }, res())
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("409s on an already-approved request", async () => {
    h.connQuery.mockImplementation(async (sql) => {
      if (String(sql).includes("FROM custom_plan_requests")) {
        return [[{ id: 3, organization_id: ORG_ID, status: "approved" }]];
      }
      return [[]];
    });
    await expect(approveCustomPlanRequest(req(), res())).rejects.toMatchObject({ statusCode: 409 });
  });

  it("409s on an already-denied request", async () => {
    h.connQuery.mockImplementation(async (sql) => {
      if (String(sql).includes("FROM custom_plan_requests")) {
        return [[{ id: 3, organization_id: ORG_ID, status: "denied" }]];
      }
      return [[]];
    });
    await expect(approveCustomPlanRequest(req(), res())).rejects.toMatchObject({ statusCode: 409 });
  });

  it("rolls back when the checkout cannot be created", async () => {
    h.connQuery.mockImplementation(async (sql) => {
      const stmt = String(sql);
      if (stmt.includes("FROM subscription_checkouts WHERE id=?")) return [[]];
      if (/^\s*SELECT/i.test(stmt)) {
        if (stmt.includes("FROM custom_plan_requests")) {
          return [[{ id: 3, organization_id: ORG_ID, status: "pending" }]];
        }
        if (stmt.includes("FROM subscription_plans")) return [[CUSTOM_PLAN]];
        return [[]];
      }
      return [{ insertId: 55, affectedRows: 1 }];
    });

    await expect(approveCustomPlanRequest(req(), res())).rejects.toMatchObject({ statusCode: 500 });
    expect(h.connection.rollback).toHaveBeenCalled();
    expect(h.connection.commit).not.toHaveBeenCalled();
  });
});
