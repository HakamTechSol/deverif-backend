import { describe, it, expect, vi, beforeEach } from "vitest";

// The refund amount must be the amount ACTUALLY charged, expressed in the
// gateway's minor unit.
//
// The unit is the part that is easy to get silently wrong: a refund of 30000
// against a PKR 30,000 charge would succeed at the gateway and refund one
// hundredth of what the customer paid, with no error anywhere.

const h = vi.hoisted(() => ({
  refundMock: vi.fn(),
  refundStatusMock: vi.fn(),
  poolQuery: vi.fn(),
  connQuery: vi.fn(),
}));

vi.mock("../src/services/safepay.service.js", () => ({
  refundSafepayPayment: (tracker, opts) => h.refundMock(tracker, opts),
  createSafepayPaymentSession: vi.fn(),
  createSafepayAuthToken: vi.fn(),
  buildSafepayCheckoutUrl: vi.fn(),
  getSafepayPaymentStatus: vi.fn(),
  // Settlement is confirmed with the gateway before anything is written locally,
  // so a test that only stubs the submit call no longer covers this flow.
  getSafepayRefundStatus: (t) => h.refundStatusMock(t),
}));

vi.mock("../src/config/db.js", () => ({
  pool: {
    query: h.poolQuery,
    getConnection: vi.fn(async () => ({
      query: h.connQuery,
      beginTransaction: vi.fn(async () => {}),
      commit: vi.fn(async () => {}),
      rollback: vi.fn(async () => {}),
      release: vi.fn(),
    })),
  },
}));

import { refundScheduledChange } from "../src/services/subscriptionCheckout.service.js";

function stubCheckout(checkout) {
  h.connQuery.mockImplementation(async (sql) => {
    const stmt = String(sql);
    if (/^\s*SELECT/i.test(stmt)) {
      if (stmt.includes("FROM organizations") && stmt.includes("FOR UPDATE")) {
        return [[{
          id: 2, uuid: "u", name: "Acme", subscription_status: "active",
          subscription_plan_id: 9, pending_plan_id: 3, subscription_expiry: new Date(),
        }]];
      }
      if (stmt.includes("FROM subscription_checkouts")) return [[checkout]];
      return [[]];
    }
    return [{ affectedRows: 1 }];
  });
}

const PKR_30K = {
  id: 7, uuid: "co", status: "completed",
  // subscription_checkouts.amount is DECIMAL(12,2) in RUPEES.
  amount: "30000.00", currency: "PKR",
  gateway_tracker_id: "track_abc", completed_at: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
  h.refundMock.mockResolvedValue({ refundReference: "refund_test", raw: {} });
  h.refundStatusMock.mockResolvedValue({
    settled: true, state: "TRACKER_REFUNDED", refundReference: "refund_test", hasRefundEvent: true,
  });
  // Writes go through pool (the refund claim, the reference record, the
  // confirmed settle) and must report a row affected, or the flow concludes the
  // refund was already claimed and 409s.
  h.poolQuery.mockImplementation(async (sql) => {
    const stmt = String(sql);
    if (/^\s*SELECT/i.test(stmt)) {
      if (stmt.includes("FROM subscription_checkouts WHERE id=?")) {
        return [[{ id: 7, organization_id: 1, refund_status: "refunded" }]];
      }
      if (stmt.includes("FROM organizations WHERE id=?")) return [[{ pending_plan_id: 3 }]];
      return [[]];
    }
    return [{ affectedRows: 1 }];
  });
  stubCheckout(PKR_30K);
});

describe("refundScheduledChange — amount and currency come from the charge", () => {
  it("converts the charged rupees into the gateway's paisa", async () => {
    await refundScheduledChange({ organizationId: 2 });

    const [tracker, opts] = h.refundMock.mock.calls[0];
    expect(tracker).toBe("track_abc");
    expect(opts.amount).toBe(3_000_000);
    expect(opts.currency).toBe("PKR");
  });

  it("uses the checkout's own currency rather than assuming PKR", async () => {
    stubCheckout({ ...PKR_30K, amount: "250.00", currency: "USD" });

    await refundScheduledChange({ organizationId: 2 });
    expect(h.refundMock.mock.calls[0][1].currency).toBe("USD");
    expect(h.refundMock.mock.calls[0][1].amount).toBe(25_000);
  });

  it("refunds what was charged, not the plan's current list price", async () => {
    // A price change between purchase and cancellation must not change the refund.
    stubCheckout({ ...PKR_30K, amount: "12345.67", currency: "PKR" });

    await refundScheduledChange({ organizationId: 2 });
    expect(h.refundMock.mock.calls[0][1].amount).toBe(1_234_567);
  });

  it("still never touches the active subscription", async () => {
    await refundScheduledChange({ organizationId: 2 });

    const orgWrites = h.connQuery.mock.calls
      .map(([sql]) => String(sql))
      .filter((s) => /UPDATE\s+organizations/i.test(s));
    for (const sql of orgWrites) {
      expect(sql).not.toMatch(/subscription_plan_id\s*=/);
      expect(sql).not.toMatch(/subscription_status\s*=/);
      expect(sql).not.toMatch(/subscription_expiry\s*=/);
    }
  });
});
