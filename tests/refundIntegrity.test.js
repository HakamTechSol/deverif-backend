import { describe, it, expect, vi, beforeEach } from "vitest";

// Refund integrity: the local record must never claim more than the gateway says.
//
// The failure this guards is the expensive one -- telling a customer their money
// was returned when it was not. Three rules follow from that:
//   1. the gateway is SUBMITTED to and then CONFIRMED with, in that order
//   2. nothing local is written until the gateway confirms
//   3. a submitted-but-unconfirmed refund is a distinct, visible state that
//      CANNOT be refunded again

const h = vi.hoisted(() => ({
  refundMock: vi.fn(),
  refundStatusMock: vi.fn(),
  poolQuery: vi.fn(),
  connQuery: vi.fn(),
  confirmCalls: [],
}));

vi.mock("../src/services/safepay.service.js", () => ({
  refundSafepayPayment: (t, o) => h.refundMock(t, o),
  getSafepayRefundStatus: (t) => h.refundStatusMock(t),
  createSafepayPaymentSession: vi.fn(),
  createSafepayAuthToken: vi.fn(),
  buildSafepayCheckoutUrl: vi.fn(),
  getSafepayPaymentStatus: vi.fn(),
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

import {
  refundScheduledChange,
  confirmRefundSettled,
} from "../src/services/subscriptionCheckout.service.js";

const TRACKER = "track_test";
const GATEWAY_REF = "refund_from_gateway";

const CHECKOUT = {
  id: 7, uuid: "co-uuid", status: "completed", amount: "30000.00", currency: "PKR",
  gateway_tracker_id: TRACKER, completed_at: new Date(),
  refund_status: "none", refund_transaction_reference: null,
};

/** Route the transaction's reads; writes are recorded for assertions. */
function stage({ pendingPlanId = 3, checkout = CHECKOUT } = {}) {
  h.connQuery.mockImplementation(async (sql) => {
    const stmt = String(sql);
    if (/^\s*SELECT/i.test(stmt)) {
      if (stmt.includes("FROM organizations") && stmt.includes("FOR UPDATE")) {
        return [[{
          id: 1, uuid: "u", name: "Acme", subscription_status: "active",
          subscription_plan_id: 9, pending_plan_id: pendingPlanId, subscription_expiry: new Date(),
        }]];
      }
      if (stmt.includes("FROM subscription_checkouts")) return [[checkout]];
      if (stmt.includes("FROM subscription_plans")) return [[{ id: 9, name: "Custom", monthly_price: 50000 }]];
      return [[]];
    }
    return [{ affectedRows: 1 }];
  });
}

const poolSqls = () => h.poolQuery.mock.calls.map(([sql]) => String(sql).replace(/\s+/g, " "));
const connSqls = () => h.connQuery.mock.calls.map(([sql]) => String(sql).replace(/\s+/g, " "));

beforeEach(() => {
  vi.clearAllMocks();
  // Default pool router. confirmRefundSettled reads through pool (not the
  // transaction), so its two reads have to be routable here too.
  h.poolQuery.mockImplementation(async (sql) => {
    const stmt = String(sql);
    if (stmt.includes("FROM subscription_checkouts WHERE id=?")) {
      return [[{ id: 7, organization_id: 1, refund_status: "refunded" }]];
    }
    if (stmt.includes("FROM organizations WHERE id=?")) return [[{ pending_plan_id: 3 }]];
    return [{ affectedRows: 1 }];
  });
  h.refundMock.mockResolvedValue({ refundReference: GATEWAY_REF, raw: {} });
  h.refundStatusMock.mockResolvedValue({
    settled: true, state: "TRACKER_REFUNDED", refundReference: GATEWAY_REF, hasRefundEvent: true,
  });
  stage();
});

/* ── the ordering rule ── */

describe("refundScheduledChange — nothing local is written before the gateway confirms", () => {
  it("claims refund_status='pending' BEFORE calling the gateway", async () => {
    // A crash between "money moved" and "we wrote it down" is what produces a
    // double refund, so the claim has to exist first.
    let claimSeenBeforeGateway = false;
    h.poolQuery.mockImplementation(async (sql) => {
      if (String(sql).includes("SET refund_status='pending'")) {
        claimSeenBeforeGateway = h.refundMock.mock.calls.length === 0;
        return [{ affectedRows: 1 }];
      }
      return [{ affectedRows: 1 }];
    });

    await refundScheduledChange({ organizationId: 1 });
    expect(claimSeenBeforeGateway).toBe(true);
  });

  it("never records 'refunded' unless the gateway confirms", async () => {
    h.refundStatusMock.mockResolvedValue({
      settled: false, state: "TRACKER_ENDED", refundReference: null, hasRefundEvent: false,
    });

    await refundScheduledChange({ organizationId: 1 });

    expect(poolSqls().some((s) => /status='refunded'/i.test(s))).toBe(false);
    expect(poolSqls().some((s) => /refund_status='refunded'/i.test(s))).toBe(false);
  });

  it("clears pending_plan_id only after confirmation", async () => {
    h.refundStatusMock.mockResolvedValue({
      settled: false, state: "TRACKER_ENDED", refundReference: null, hasRefundEvent: false,
    });

    await refundScheduledChange({ organizationId: 1 });

    // The org must stay in the "scheduled, cancel still available" state.
    const clears = connSqls().filter((s) => /SET pending_plan_id=NULL/i.test(s));
    expect(clears).toHaveLength(0);
  });
});

/* ── the three real outcomes ── */

describe("refundScheduledChange — outcome reflects what the gateway actually said", () => {
  it("CONFIRMED: records refunded, stores the reference, clears the change", async () => {
    const outcome = await refundScheduledChange({ organizationId: 1 });

    expect(outcome.pending_confirmation).toBe(false);
    expect(outcome.refund_reference).toBe(GATEWAY_REF);
    expect(outcome.refund_state).toBe("TRACKER_REFUNDED");

    // The reference is the traceable link the old code threw away.
    expect(poolSqls().some((s) => /refund_transaction_reference=\?/.test(s))).toBe(true);
    // And it is mirrored onto the billing-ledger row.
    expect(poolSqls().some((s) => /UPDATE payment SET refund_transaction_reference/i.test(s))).toBe(true);
  });

  it("REFUSED: rolls the claim back, refunds nothing, clears nothing", async () => {
    h.refundMock.mockRejectedValue(new Error("Safepay refund failed: upstream 500"));

    await expect(refundScheduledChange({ organizationId: 1 })).rejects.toMatchObject({ statusCode: 502 });

    // Claim released so a retry is possible (the gateway moved nothing).
    expect(poolSqls().some((s) => /refund_status='none'/i.test(s))).toBe(true);
    expect(connSqls().some((s) => /SET pending_plan_id=NULL/i.test(s))).toBe(false);
  });

  it("SUBMITTED but unsettled: keeps the change, stores the reference, blocks a retry", async () => {
    h.refundStatusMock.mockResolvedValue({
      settled: false, state: "TRACKER_AUTHORIZED", refundReference: GATEWAY_REF, hasRefundEvent: false,
    });

    const outcome = await refundScheduledChange({ organizationId: 1 });

    expect(outcome.pending_confirmation).toBe(true);
    expect(outcome.refund_reference).toBe(GATEWAY_REF);
    // The reference is still recorded -- that is the reconciliation trail.
    expect(poolSqls().some((s) => /refund_transaction_reference=\?/.test(s))).toBe(true);
    // And the scheduled change is deliberately still there.
    expect(connSqls().some((s) => /SET pending_plan_id=NULL/i.test(s))).toBe(false);
  });

  it("prefers the reporter's reference over the submit response's", async () => {
    h.refundMock.mockResolvedValue({ refundReference: "refund_from_submit", raw: {} });
    h.refundStatusMock.mockResolvedValue({
      settled: true, state: "TRACKER_REFUNDED", refundReference: "refund_from_reporter", hasRefundEvent: true,
    });

    const outcome = await refundScheduledChange({ organizationId: 1 });
    expect(outcome.refund_reference).toBe("refund_from_reporter");
  });
});

/* ── the double-refund guard ── */

describe("refundScheduledChange — a second cancel can never refund twice", () => {
  it("409s when a refund is already pending, without calling the gateway", async () => {
    // The claim UPDATE reports 0 rows, which is how "someone already claimed it"
    // is detected atomically.
    h.poolQuery.mockImplementation(async (sql) => {
      if (String(sql).includes("refund_status='pending'")) return [{ affectedRows: 0 }];
      return [{ affectedRows: 1 }];
    });

    await expect(refundScheduledChange({ organizationId: 1 })).rejects.toMatchObject({ statusCode: 409 });
    expect(h.refundMock).not.toHaveBeenCalled();
  });

  it("re-confirms with the gateway on a retry instead of re-submitting", async () => {
    stage({ checkout: { ...CHECKOUT, status: "completed", refund_status: "pending" } });
    h.refundStatusMock.mockResolvedValue({
      settled: true, state: "TRACKER_REFUNDED", refundReference: GATEWAY_REF, hasRefundEvent: true,
    });

    const outcome = await refundScheduledChange({ organizationId: 1 });

    // The refund had already been submitted; asking again is how you pay twice.
    expect(h.refundMock).not.toHaveBeenCalled();
    expect(h.refundStatusMock).toHaveBeenCalledWith(TRACKER);
    expect(outcome.pending_confirmation).toBe(false);
  });

  it("tells the user not to retry while a refund is still settling", async () => {
    stage({ checkout: { ...CHECKOUT, status: "completed", refund_status: "pending" } });
    h.refundStatusMock.mockResolvedValue({
      settled: false, state: "TRACKER_ENDED", refundReference: null, hasRefundEvent: false,
    });

    await expect(refundScheduledChange({ organizationId: 1 })).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("do not retry"),
    });
    expect(h.refundMock).not.toHaveBeenCalled();
  });

  it("an already-settled refund only clears the leftover change", async () => {
    stage({ checkout: { ...CHECKOUT, status: "refunded", refund_status: "refunded", refund_transaction_reference: GATEWAY_REF } });

    const outcome = await refundScheduledChange({ organizationId: 1 });

    expect(outcome.already_refunded).toBe(true);
    expect(h.refundMock).not.toHaveBeenCalled();
    expect(h.refundStatusMock).not.toHaveBeenCalled();
  });
});

/* ── async settlement arriving later ── */

describe("confirmRefundSettled — the late confirmation path", () => {
  beforeEach(() => {
    h.poolQuery.mockImplementation(async (sql) => {
      const stmt = String(sql);
      if (stmt.includes("FROM subscription_checkouts WHERE id=?")) {
        return [[{ id: 7, organization_id: 1, refund_status: "pending" }]];
      }
      if (stmt.includes("FROM organizations WHERE id=?")) {
        return [[{ pending_plan_id: 3 }]];
      }
      return [{ affectedRows: 1 }];
    });
  });

  it("promotes the row and drops the scheduled change", async () => {
    const result = await confirmRefundSettled({ checkoutId: 7, refundReference: GATEWAY_REF, state: "TRACKER_REFUNDED" });

    expect(result.already_confirmed).toBe(false);
    expect(connSqls().some((s) => /status='refunded'/i.test(s))).toBe(true);
    expect(connSqls().some((s) => /SET pending_plan_id=NULL/i.test(s))).toBe(true);
    // Never keep a pending placeholder over the real reference.
    expect(connSqls().some((s) => /COALESCE\(\?, refund_transaction_reference\)/.test(s))).toBe(true);
  });

  it("is idempotent, so a duplicated webhook is harmless", async () => {
    h.poolQuery.mockImplementation(async (sql) => {
      if (String(sql).includes("FROM subscription_checkouts WHERE id=?")) {
        return [[{ id: 7, organization_id: 1, refund_status: "refunded" }]];
      }
      return [{ affectedRows: 1 }];
    });

    const result = await confirmRefundSettled({ checkoutId: 7, refundReference: GATEWAY_REF });
    expect(result.already_confirmed).toBe(true);
    // No second write, and certainly no second refund.
    expect(h.refundMock).not.toHaveBeenCalled();
  });
});
