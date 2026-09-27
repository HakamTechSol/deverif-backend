import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The reworked subscription-change model, end to end.
//
// Three outcomes only: activate_now (nothing live), upgrade_now (strictly higher
// tier, acts at once), change_scheduled (SAME or LOWER tier, parks in
// pending_plan_id until expiry). The "renew" outcome is gone: a renewal is a
// scheduled change whose target happens to be the plan the org already has.

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
  const secondConnection = {
    query: vi.fn(),
    beginTransaction: vi.fn(),
    commit: vi.fn(),
    rollback: vi.fn(),
    release: vi.fn(),
  };
  const getConnection = vi.fn();
  return { poolQuery, connQuery, connection, secondConnection, getConnection, refundMock: vi.fn(), refundStatusMock: vi.fn() };
});

vi.mock("../src/config/db.js", () => ({
  pool: { query: h.poolQuery, getConnection: h.getConnection },
}));

vi.mock("../src/services/safepay.service.js", () => ({
  refundSafepayPayment: (tracker, metadata) => h.refundMock(tracker, metadata),
  createSafepayPaymentSession: vi.fn(),
  createSafepayAuthToken: vi.fn(),
  buildSafepayCheckoutUrl: vi.fn(),
  getSafepayPaymentStatus: vi.fn(),
  // Settlement is now confirmed with the gateway before any local write, so the
  // submit mock alone is not enough to exercise the flow.
  getSafepayRefundStatus: (t) => h.refundStatusMock(t)
}));

import { pool } from "../src/config/db.js";
import { resolveSubscriptionChange } from "../src/utils/subscriptionTransition.js";
import { refundScheduledChange } from "../src/services/subscriptionCheckout.service.js";
import { finalizeSuccessfulCheckout } from "../src/services/payment.service.js";
import { applyDueSubscriptionChanges } from "../src/services/subscriptionLifecycle.service.js";

/* ─────────────────────────── fixtures ─────────────────────────── */

const FREE = { id: 1, name: "Free", monthly_price: 0, daily_request_quota: 0, billing_period: "monthly", is_free: 1 };
const BASIC = { id: 2, name: "Basic", monthly_price: 10000, daily_request_quota: 10, billing_period: "monthly", is_free: 0 };
const PRO = { id: 3, name: "Pro", monthly_price: 30000, daily_request_quota: 100, billing_period: "monthly", is_free: 0 };
const CUSTOM_LOW = { id: 4, name: "Custom Plan", monthly_price: 5000, daily_request_quota: 5, billing_period: "monthly", is_free: 0 };
const CUSTOM_HIGH = { id: 5, name: "Custom Plan", monthly_price: 50000, daily_request_quota: 500, billing_period: "monthly", is_free: 0 };

const NOW = new Date(2026, 0, 15, 10, 30, 0);
const EXPIRES_15_FEB = new Date(2026, 1, 15, 10, 30, 0);
const YMD = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** An org mid-period on a paid plan with real time still bought. */
const paidOrg = (plan = BASIC, overrides = {}) => ({
  id: 7,
  uuid: "org-uuid",
  subscription_status: "active",
  subscription_start: new Date(2025, 11, 15, 10, 30, 0),
  subscription_expiry: EXPIRES_15_FEB,
  subscription_plan_id: plan.id,
  pending_plan_id: null,
  current_plan: plan,
  ...overrides,
});

const freeOrg = (overrides = {}) => ({
  id: 9,
  uuid: "org-uuid",
  subscription_status: "active",
  subscription_start: new Date(2025, 5, 1, 9, 0, 0),
  subscription_expiry: null,
  subscription_plan_id: FREE.id,
  pending_plan_id: null,
  current_plan: FREE,
  ...overrides,
});

const lapsedOrg = (plan = PRO, overrides = {}) => ({
  ...paidOrg(plan),
  subscription_status: "active",
  subscription_expiry: new Date(2026, 0, 10, 10, 30, 0), // already past
  ...overrides,
});

/* ───────────────── helpers for the fake connection ───────────────── */

const sqls = () => h.connQuery.mock.calls.map(([sql]) => String(sql));
const sqlsOf = (mock) => mock.mock.calls.map(([sql]) => String(sql));

function fakeTx({ rows = [] } = {}) {
  h.connQuery.mockImplementation(async (sql) => {
    const stmt = String(sql);
    if (/^\s*SELECT/i.test(stmt)) {
      const pick = rows.find((r) => stmt.includes(r.match));
      return [pick ? pick.value : []];
    }
    if (/^\s*INSERT/i.test(stmt)) return [{ insertId: 500, affectedRows: 1 }];
    return [{ affectedRows: 1 }];
  });
  h.connection.beginTransaction.mockResolvedValue(undefined);
  h.connection.commit.mockResolvedValue(undefined);
  h.connection.rollback.mockResolvedValue(undefined);
  h.getConnection.mockResolvedValue(h.connection);
}

beforeEach(() => {
  vi.clearAllMocks();
  // mockReset on the connection factory, NOT clearAllMocks: several of these
  // tests deliberately throw partway through, and clearAllMocks keeps the
  // unconsumed mockResolvedValueOnce queue. Those leftovers would then hand the
  // NEXT test the wrong connection and fail far from the real cause.
  h.getConnection.mockReset();
  h.poolQuery.mockReset();
  h.secondConnection.query.mockReset();

  h.refundMock.mockResolvedValue({ refundReference: "refund_test", raw: {} });
  h.refundStatusMock.mockResolvedValue({
    settled: true, state: "TRACKER_REFUNDED", refundReference: "refund_test", hasRefundEvent: true,
  });
  // The refund claim, the reference record and the confirmed settle all go
  // through pool, and each must report a row affected.
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
  h.secondConnection.query.mockResolvedValue([{ affectedRows: 1 }]);
  h.secondConnection.beginTransaction.mockResolvedValue(undefined);
  h.secondConnection.commit.mockResolvedValue(undefined);
  h.secondConnection.rollback.mockResolvedValue(undefined);
  h.refundMock.mockResolvedValue({ refundReference: "refund_test", raw: {} });
  h.refundStatusMock.mockResolvedValue({
    settled: true, state: "TRACKER_REFUNDED", refundReference: "refund_test", hasRefundEvent: true,
  });
  // getConnection hands out the main connection, then the settle connection.
  h.getConnection
    .mockResolvedValueOnce(h.connection)
    .mockResolvedValueOnce(h.secondConnection);
});

/* ═════════════════════ Part 4.1 — same-plan selection ═════════════════════ */

describe("same-plan selection while active: payment captured, change scheduled", () => {
  it("schedules the renewal and leaves subscription_expiry untouched", () => {
    const change = resolveSubscriptionChange(paidOrg(BASIC), BASIC, { now: NOW });

    expect(change.action).toBe("change_scheduled");
    expect(change.relation).toBe("same");
    expect(change.is_renewal).toBe(true);
    // The customer keeps exactly the period they already paid for.
    expect(YMD(change.subscription_expiry)).toBe("2026-02-15");
    expect(change.subscription_status).toBe("active");
    // pending_plan_id EQUALS the current plan id — that is the renewal.
    expect(change.pending_plan_id).toBe(BASIC.id);
  });

  it("is schedulable at any point in the period, not only near expiry", () => {
    // One day before expiry, and the day the subscription started.
    for (const now of [new Date(2026, 1, 14), new Date(2025, 11, 15)]) {
      const change = resolveSubscriptionChange(paidOrg(BASIC), BASIC, { now });
      expect(change.action).toBe("change_scheduled");
      expect(change.pending_plan_id).toBe(BASIC.id);
    }
  });

  it("records the scheduled change on the checkout so a refund can find it", async () => {
    // The webhook is what writes resulted_in_pending_plan_id, and it is written
    // only for a scheduled change. Without it there is no way to know which
    // payment to refund.
    //
    // finalizeSuccessfulCheckout uses the real clock, so the org's expiry has to
    // be comfortably in the FUTURE relative to now (not the Jan-2026 fixture
    // date) for the subscription to count as live.
    const liveUntil = new Date();
    liveUntil.setFullYear(liveUntil.getFullYear() + 2);

    h.connQuery.mockImplementation(async (sql) => {
      const stmt = String(sql);
      if (/^\s*SELECT/i.test(stmt)) {
        if (stmt.includes("FROM subscription_checkouts WHERE id=? FOR UPDATE")) {
          return [[{ id: 11, uuid: "co-uuid", organization_id: 7, plan_id: BASIC.id, status: "pending", gateway_tracker_id: "trk_1" }]];
        }
        if (stmt.includes("FROM organizations") && stmt.includes("FOR UPDATE")) {
          return [[{
            id: 7, uuid: "org-uuid", subscription_status: "active",
            subscription_plan_id: BASIC.id, pending_plan_id: null,
            subscription_expiry: liveUntil, subscription_start: new Date(),
          }]];
        }
        if (stmt.includes("FROM subscription_plans")) return [[BASIC]];
        return [[]];
      }
      return [{ affectedRows: 1 }];
    });
    h.poolQuery.mockImplementation(async (sql) => {
      if (String(sql).includes("DELETE FROM daily_request_usage")) return [{}];
      return [[]];
    });

    await finalizeSuccessfulCheckout({ checkoutId: 11, eventId: "evt_1" });

    const linkCall = h.connQuery.mock.calls.find(([sql]) =>
      String(sql).includes("SET resulted_in_pending_plan_id")
    );
    expect(linkCall).toBeDefined();
    expect(linkCall[1]).toEqual([BASIC.id, 11]);
  });

  it("does NOT record resulted_in_pending_plan_id for an immediate upgrade", async () => {
    // An upgrade grants the plan at once, so there is nothing to back out of and
    // no refund target should be recorded.
    const liveUntil = new Date();
    liveUntil.setFullYear(liveUntil.getFullYear() + 2);

    h.connQuery.mockImplementation(async (sql, params) => {
      const stmt = String(sql);
      if (/^\s*SELECT/i.test(stmt)) {
        if (stmt.includes("FROM subscription_checkouts WHERE id=? FOR UPDATE")) {
          return [[{ id: 11, uuid: "co-uuid", organization_id: 7, plan_id: PRO.id, status: "pending", gateway_tracker_id: "trk_2" }]];
        }
        if (stmt.includes("FROM organizations") && stmt.includes("FOR UPDATE")) {
          return [[{
            id: 7, uuid: "org-uuid", subscription_status: "active",
            subscription_plan_id: BASIC.id, pending_plan_id: null,
            subscription_expiry: liveUntil, subscription_start: new Date(),
          }]];
        }
        if (stmt.includes("FROM subscription_plans")) {
          // Two different plan reads: the org's CURRENT plan (from
          // subscription_plan_id) and the checkout's requested plan. Returning
          // the same row for both would make the upgrade look like a renewal.
          const wantedId = params && params[0];
          if (Number(wantedId) === PRO.id) return [[PRO]];
          return [[BASIC]];
        }
        return [[]];
      }
      return [{ affectedRows: 1 }];
    });
    h.poolQuery.mockImplementation(async (sql) => {
      if (String(sql).includes("DELETE FROM daily_request_usage")) return [{}];
      return [[]];
    });

    await finalizeSuccessfulCheckout({ checkoutId: 11, eventId: "evt_2" });

    expect(
      h.connQuery.mock.calls.some(([sql]) => String(sql).includes("SET resulted_in_pending_plan_id"))
    ).toBe(false);
  });
});

/* ═════════════════ Part 4.2/4.3 — the sweep applies at expiry ═════════════════ */

describe("lifecycle sweep applies a pending change at expiry", () => {
  const PAST = new Date(2026, 0, 10, 10, 30, 0);

  function sweepFor(orgRow, planRow) {
    h.poolQuery.mockImplementation(async (sql) => {
      const stmt = String(sql);
      // scheduled-changes branch
      if (stmt.includes("pending_plan_id IS NOT NULL")) {
        return [[{ id: orgRow.id, uuid: orgRow.uuid, name: "Org", pending_plan_id: orgRow.pending_plan_id, subscription_expiry: orgRow.subscription_expiry }]];
      }
      // lapsed-paid branch: nothing, so the Free-fallback path is not exercised
      if (stmt.includes("sp.is_free = 0")) return [[]];
      // repair branch
      if (stmt.includes("subscription_plan_id IS NULL") || stmt.includes("= 'none'")) return [[]];
      if (stmt.includes("is_free=1")) return [[FREE]];
      return [[]];
    });
    h.connQuery.mockImplementation(async (sql) => {
      const stmt = String(sql);
      if (/^\s*SELECT/i.test(stmt)) {
        if (stmt.includes("FROM organizations") && stmt.includes("FOR UPDATE")) return [[orgRow]];
        if (stmt.includes("FROM subscription_plans")) return [[planRow]];
        return [[]];
      }
      return [{ affectedRows: 1 }];
    });
  }

  it("applies a SAME-PLAN pending change as new_expiry = old_expiry + billing_period", async () => {
    const org = {
      id: 7, uuid: "org-uuid", name: "Org",
      subscription_status: "active", subscription_plan_id: BASIC.id,
      pending_plan_id: BASIC.id,          // renewal: same plan
      subscription_expiry: PAST,
    };
    sweepFor(org, BASIC);

    const result = await applyDueSubscriptionChanges();

    expect(result.scheduled).toHaveLength(1);
    expect(result.scheduled[0].kind).toBe("renewal");
    // PAST (10 Jan) + 1 month = 10 Feb. NOT "today + 1 month".
    expect(YMD(result.scheduled[0].new_expiry)).toBe("2026-02-10");

    const update = h.connQuery.mock.calls.find(([sql]) => String(sql).includes("UPDATE organizations"));
    const [updateSql, updateParams] = update;
    // pending_plan_id is cleared in the same statement that extends the period.
    expect(updateSql).toContain("pending_plan_id=NULL");
    expect(updateParams[0]).toBe(BASIC.id);
    expect(YMD(updateParams[1])).toBe("2026-02-10");
  });

  it("still applies a DOWNGRADE pending change the same way", async () => {
    // The rework must not have disturbed the pre-existing downgrade path.
    const org = {
      id: 8, uuid: "org-uuid", name: "Org",
      subscription_status: "active", subscription_plan_id: PRO.id,
      pending_plan_id: BASIC.id,           // downgrade
      subscription_expiry: PAST,
    };
    sweepFor(org, BASIC);

    const result = await applyDueSubscriptionChanges();

    expect(result.scheduled).toHaveLength(1);
    expect(result.scheduled[0].kind).toBe("plan_change");
    expect(result.scheduled[0].plan_id).toBe(BASIC.id);
    expect(YMD(result.scheduled[0].new_expiry)).toBe("2026-02-10");
  });

  it("schedules a deliberate move to Free and applies it with a NULL expiry", async () => {
    // Free has no billing cycle, so the +period math must NOT run. This is the
    // one date computation that is Free-specific, and nothing else about how a
    // scheduled change is applied changes.
    const org = {
      id: 9, uuid: "org-uuid", name: "Org",
      subscription_status: "active", subscription_plan_id: PRO.id,
      pending_plan_id: FREE.id,            // schedule-to-Free
      subscription_expiry: PAST,
    };
    sweepFor(org, FREE);

    const result = await applyDueSubscriptionChanges();

    expect(result.scheduled).toHaveLength(1);
    expect(result.scheduled[0].plan_id).toBe(FREE.id);
    // NULL means "indefinite", not "expired".
    expect(result.scheduled[0].new_expiry).toBeNull();
  });
});

/* ═════════════════ 4.4/4.5 — cancel with refund (one mechanism) ═════════════════ */

describe("cancel-with-refund: one mechanism for a scheduled renewal and a scheduled downgrade", () => {
  function setupCancel({ pendingPlanId, checkoutStatus = "completed", tracker = "trk_1" }) {
    h.connQuery.mockImplementation(async (sql) => {
      const stmt = String(sql);
      if (/^\s*SELECT/i.test(stmt)) {
        if (stmt.includes("FOR UPDATE") && stmt.includes("FROM organizations")) {
          return [[{
            id: 7, uuid: "org-uuid", name: "Org",
            subscription_status: "active",
            subscription_plan_id: BASIC.id,
            pending_plan_id: pendingPlanId,
            subscription_expiry: EXPIRES_15_FEB,
          }]];
        }
        if (stmt.includes("FROM subscription_plans")) return [[{ id: pendingPlanId, name: "P", monthly_price: 10000 }]];
        if (stmt.includes("FROM subscription_checkouts")) {
          return [[{
            id: 11, uuid: "co-uuid", status: checkoutStatus,
            amount: "10000.00", gateway_tracker_id: tracker, completed_at: new Date(2026, 0, 14),
          }]];
        }
        return [[]];
      }
      return [{ affectedRows: 1 }];
    });
    h.connection.beginTransaction.mockResolvedValue(undefined);
    h.connection.commit.mockResolvedValue(undefined);
    h.connection.rollback.mockResolvedValue(undefined);
    h.secondConnection.query.mockImplementation(async (sql) => {
      if (String(sql).includes("SET status='refunded'")) return [{ affectedRows: 1 }];
      if (String(sql).includes("SET pending_plan_id=NULL")) return [{ affectedRows: 1 }];
      return [{ affectedRows: 1 }];
    });
  }

  for (const [label, pendingPlanId] of [
    ["a scheduled RENEWAL (pending_plan_id === current plan)", BASIC.id],
    ["a scheduled DOWNGRADE", PRO.id],
  ]) {
    it(`refunds and clears ${label}`, async () => {
      setupCancel({ pendingPlanId });

      const outcome = await refundScheduledChange({ organizationId: 7 });

      // The gateway was actually called for the captured tracker.
      expect(h.refundMock).toHaveBeenCalledTimes(1);
      expect(h.refundMock.mock.calls[0][0]).toBe("trk_1");
      expect(outcome.refund).toBeTruthy();

      // The checkout row is marked refunded, never deleted.
      const refundUpdate = h.secondConnection.query.mock.calls.find(([sql]) =>
        String(sql).includes("SET status='refunded'")
      );
      expect(refundUpdate).toBeDefined();
      expect(refundUpdate[1]).toEqual([11]);
      expect(sqlsOf(h.secondConnection.query).some((s) => /DELETE\s+FROM\s+subscription_checkouts/i.test(s))).toBe(false);

      // The scheduled change is cleared, and only pending_plan_id moved.
      const clearUpdate = h.secondConnection.query.mock.calls.find(([sql]) =>
        String(sql).includes("SET pending_plan_id=NULL")
      );
      expect(clearUpdate).toBeDefined();
      expect(clearUpdate[1]).toEqual([7, pendingPlanId]);
    });
  }

  it("leaves the ACTIVE subscription completely untouched", async () => {
    setupCancel({ pendingPlanId: BASIC.id });

    await refundScheduledChange({ organizationId: 7 });

    // No write may touch subscription_plan_id / subscription_status /
    // subscription_expiry. Only pending_plan_id is allowed to change.
    for (const sql of sqlsOf(h.secondConnection.query)) {
      if (/UPDATE\s+organizations/i.test(sql)) {
        expect(sql).not.toMatch(/subscription_plan_id\s*=/);
        expect(sql).not.toMatch(/subscription_status\s*=/);
        expect(sql).not.toMatch(/subscription_expiry\s*=/);
      }
    }
  });

  it("400s when there is nothing scheduled", async () => {
    setupCancel({ pendingPlanId: null });

    await expect(refundScheduledChange({ organizationId: 7 })).rejects.toMatchObject({
      statusCode: 400,
    });
    // And nothing was refunded.
    expect(h.refundMock).not.toHaveBeenCalled();
  });

  it("keeps the scheduled change AND the charge when the gateway refund fails", async () => {
    setupCancel({ pendingPlanId: BASIC.id });
    h.getConnection.mockReset();
    h.getConnection.mockResolvedValueOnce(h.connection);
    h.refundMock.mockRejectedValue(new Error("Safepay refund failed: gateway down"));

    await expect(refundScheduledChange({ organizationId: 7 })).rejects.toMatchObject({
      statusCode: 502,
    });

    // Critically: pending_plan_id was NOT cleared, so the customer can retry
    // instead of losing the plan change AND the money.
    expect(sqlsOf(h.secondConnection.query)).toHaveLength(0);
  });

  it("is idempotent: a checkout already marked refunded is not refunded twice", async () => {
    setupCancel({ pendingPlanId: BASIC.id, checkoutStatus: "refunded" });
    h.getConnection.mockReset();
    h.getConnection.mockResolvedValueOnce(h.connection);

    const outcome = await refundScheduledChange({ organizationId: 7 });

    expect(outcome.already_refunded).toBe(true);
    expect(h.refundMock).not.toHaveBeenCalled();
    // The leftover intent is still cleared.
    const clear = h.connQuery.mock.calls.find(([sql]) => String(sql).includes("SET pending_plan_id=NULL"));
    expect(clear).toBeDefined();
  });
});

/* ═════════════════ 4.6 — the upgrade path is unaffected ═════════════════ */

describe("upgrade path: still immediate, never scheduled", () => {
  it("a higher-tier plan switches at once on a fresh cycle", () => {
    const change = resolveSubscriptionChange(paidOrg(BASIC), PRO, { now: NOW });

    expect(change.action).toBe("upgrade_now");
    expect(change.apply_immediately).toBe(true);
    expect(change.subscription_plan_id).toBe(PRO.id);
    expect(change.pending_plan_id).toBeNull();
    // Fresh cycle from today, not carried over.
    expect(YMD(change.subscription_expiry)).toBe("2026-02-15");
  });

  it("a CUSTOM plan with a higher quota is an immediate upgrade, not exempt", () => {
    const change = resolveSubscriptionChange(paidOrg(BASIC), CUSTOM_HIGH, { now: NOW });
    expect(change.action).toBe("upgrade_now");
    expect(change.pending_plan_id).toBeNull();
  });

  it("a CUSTOM plan with a LOWER quota is scheduled like any other downgrade", () => {
    // The point of routing custom plans through the same comparison: being
    // bespoke is not a licence to bypass the upgrade/schedule rule.
    const change = resolveSubscriptionChange(paidOrg(PRO), CUSTOM_LOW, { now: NOW });
    expect(change.action).toBe("change_scheduled");
    expect(change.relation).toBe("downgrade");
    expect(change.apply_immediately).toBe(false);
    expect(change.pending_plan_id).toBe(CUSTOM_LOW.id);
    expect(change.subscription_plan_id).toBe(PRO.id);
  });

  it("upgrading FROM Free is an immediate activation", () => {
    const change = resolveSubscriptionChange(freeOrg(), BASIC, { now: NOW });
    expect(change.action).toBe("upgrade_now");
    expect(change.pending_plan_id).toBeNull();
  });
});

/* ═════════════════ Part 3 — the five Free-plan invariants ═════════════════ */

describe("Free-plan invariant: a brand-new org is always on the dynamically-looked-up Free plan", () => {
  it("the insert columns put a new org on Free immediately, never null/none", async () => {
    const { freePlanInsertColumns } = await import("../src/utils/freePlan.js");
    const cols = freePlanInsertColumns(FREE);

    expect(cols.subscription_plan_id).toBe(FREE.id);
    expect(cols.subscription_status).toBe("active");
    // NULL expiry on Free means "indefinite", not "missing".
    expect(cols.subscription_expiry).toBeNull();
  });

  it("the Free plan is looked up by is_free=1, never by a hardcoded id", async () => {
    const { getFreePlan } = await import("../src/utils/subscriptionPlans.js");
    const executor = { query: vi.fn().mockResolvedValue([[{ id: 4242, is_free: 1, name: "Renamed Free" }]]) };

    const plan = await getFreePlan(executor);

    expect(executor.query.mock.calls[0][0]).toContain("is_free=1");
    // Whatever id the DB returns is what gets used.
    expect(plan.id).toBe(4242);
  });

  it("refuses to build insert columns for anything not flagged is_free", async () => {
    const { freePlanInsertColumns } = await import("../src/utils/freePlan.js");
    expect(() => freePlanInsertColumns(PRO)).toThrow();
  });
});

describe("Free-plan invariant: a lapsed paid subscription falls back to Free automatically", () => {
  it("the sweep's Free-fallback branch is gated exactly on expiry<=NOW, no pending, is_free=0", async () => {
    h.poolQuery.mockImplementation(async (sql) => {
      const stmt = String(sql);
      if (stmt.includes("pending_plan_id IS NOT NULL")) return [[]];
      if (stmt.includes("sp.is_free = 0")) {
        // The selection query for the lapsed branch.
        expect(stmt).toContain("o.subscription_expiry <= NOW()");
        expect(stmt).toContain("o.pending_plan_id IS NULL");
        expect(stmt).toContain("sp.is_free = 0");
        return [[{ id: 5, uuid: "u", name: "Org", subscription_expiry: new Date(2025, 11, 1), plan_id: PRO.id, plan_name: "Pro" }]];
      }
      if (stmt.includes("is_free=1")) return [[FREE]];
      return [[]];
    });
    h.connQuery.mockImplementation(async (sql) => {
      const stmt = String(sql);
      if (/^\s*SELECT/i.test(stmt)) {
        if (stmt.includes("FOR UPDATE") && stmt.includes("FROM organizations")) {
          return [[{ id: 5, uuid: "u", name: "Org", subscription_status: "active", subscription_plan_id: PRO.id, subscription_start: new Date(2025, 0, 1), subscription_expiry: new Date(2025, 11, 1), pending_plan_id: null }]];
        }
        if (stmt.includes("is_free=1")) return [[FREE]];
        return [[]];
      }
      return [{ affectedRows: 1 }];
    });

    const result = await applyDueSubscriptionChanges();

    expect(result.lapsed).toHaveLength(1);
    expect(result.lapsed[0].new_plan_id).toBe(FREE.id);
    // Free never expires, so the fallback writes a NULL expiry — "indefinite",
    // not "expired". Asserted on the sweep's own reported outcome, which is the
    // value the UPDATE was written from.
    expect(result.lapsed[0].new_expiry).toBeNull();
    // And the organization was actually moved onto the looked-up Free plan.
    const update = h.connQuery.mock.calls.find(([sql]) => String(sql).includes("UPDATE organizations"));
    expect(update).toBeDefined();
    expect(update[1]).toContain(FREE.id);
  });
});

describe("Free-plan invariant: a deliberate schedule-to-Free uses the same scheduling mechanism", () => {
  it("schedules Free via pending_plan_id while the paid plan keeps running", () => {
    const change = resolveSubscriptionChange(paidOrg(PRO), FREE, { now: NOW });

    // Same action as every other non-upgrade change — no Free-specific branch.
    expect(change.action).toBe("change_scheduled");
    expect(change.relation).toBe("downgrade");
    expect(change.apply_immediately).toBe(false);
    expect(change.pending_plan_id).toBe(FREE.id);
    // The paid plan and its paid period are untouched.
    expect(change.subscription_plan_id).toBe(PRO.id);
    expect(YMD(change.subscription_expiry)).toBe("2026-02-15");
  });
});

describe("Free-plan invariant: Free is never identified by id, name or price", () => {
  it("a paid plan priced at 0 is not Free", async () => {
    const { isFreePlan } = await import("../src/utils/subscriptionPlans.js");
    expect(isFreePlan({ id: 3, name: "Starter", monthly_price: 0, is_free: 0 })).toBe(false);
  });

  it("a plan merely NAMED Free is not Free", async () => {
    const { isFreePlan } = await import("../src/utils/subscriptionPlans.js");
    expect(isFreePlan({ id: 4, name: "Free", monthly_price: 500, is_free: 0 })).toBe(false);
  });

  it("a plan flagged is_free=1 is Free whatever its id and price", async () => {
    const { isFreePlan } = await import("../src/utils/subscriptionPlans.js");
    expect(isFreePlan({ id: 999, name: "Anything", monthly_price: 12345, is_free: 1 })).toBe(true);
  });
});
