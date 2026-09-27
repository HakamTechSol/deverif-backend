import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/config/db.js", () => ({
  pool: { query: vi.fn(), getConnection: vi.fn() },
}));

import { pool } from "../src/config/db.js";
import {
  addBillingPeriod,
  applySubscriptionChange,
  comparePlanTier,
  expiryForPlan,
  isSubscriptionActive,
  isSubscriptionValid,
  resolveSubscriptionChange,
} from "../src/utils/subscriptionTransition.js";
import { isFreePlan, getFreePlan, findFreePlan } from "../src/utils/subscriptionPlans.js";
import { assignFreePlanToOrg, freePlanInsertColumns } from "../src/utils/freePlan.js";
import { applyDueSubscriptionChanges } from "../src/services/subscriptionLifecycle.service.js";
import { getOrgPlan } from "../src/utils/requestQuota.js";
import { getPlanSummary } from "../src/utils/plan.js";

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ fixtures â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

// Fixed local clock so nothing depends on the real "today".
const NOW = new Date(2026, 0, 15, 10, 30, 0); // 15 Jan 2026, 10:30 local
const daysFrom = (date, days) => new Date(date.getTime() + days * 86400000);

// The Free plan is just another row, recognised ONLY by is_free=1 -- never by a
// hardcoded id, name or price. Deliberately given a non-obvious id/name/price
// here so a test that passes cannot be relying on a hardcoded "Free"/id 1/0.00.
const FREE_PLAN = {
  id: 77,
  name: "Starter (Free)",
  monthly_price: 0,
  daily_request_quota: 0,
  billing_period: "monthly",
  is_free: 1,
};

const PLAN_A = { id: 1, name: "Plan A", monthly_price: 10000, daily_request_quota: 10, billing_period: "monthly", is_free: 0 };
const PLAN_B = { id: 2, name: "Plan B", monthly_price: 30000, daily_request_quota: 100, billing_period: "monthly", is_free: 0 };
const PLAN_B_YEARLY = { ...PLAN_B, id: 3, billing_period: "yearly" };
const PLAN_A_RENAMED = { ...PLAN_A, id: 9, name: "Plan A (2026)" }; // same tier, different id

const activeOrg = (overrides = {}) => ({
  id: 42,
  subscription_status: "active",
  subscription_start: new Date(2025, 11, 15, 10, 30, 0),
  // Expires 15 Feb 2026 -> the org renewing "10 days early" on 15 Jan still has
  // 31 days of paid time left, which must be carried forward, not discarded.
  subscription_expiry: new Date(2026, 1, 15, 10, 30, 0),
  subscription_plan_id: PLAN_A.id,
  pending_plan_id: null,
  current_plan: PLAN_A,
  ...overrides,
});

/** An org on the Free plan: active, no expiry (meaning "indefinite"). */
const freeOrg = (overrides = {}) => ({
  id: 50,
  subscription_status: "active",
  subscription_start: new Date(2025, 5, 1, 9, 0, 0),
  subscription_expiry: null,
  subscription_plan_id: FREE_PLAN.id,
  pending_plan_id: null,
  current_plan: FREE_PLAN,
  ...overrides,
});

const ymd = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ addBillingPeriod â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

describe("addBillingPeriod", () => {
  it("adds one month for a monthly plan", () => {
    expect(ymd(addBillingPeriod(new Date(2026, 0, 15, 10, 30, 0), "monthly"))).toBe("2026-02-15");
  });

  it("adds twelve months for a yearly plan", () => {
    expect(ymd(addBillingPeriod(new Date(2026, 0, 15, 10, 30, 0), "yearly"))).toBe("2027-01-15");
  });

  it("treats an unknown/absent billing period as monthly", () => {
    expect(ymd(addBillingPeriod(new Date(2026, 0, 15, 10, 30, 0), undefined))).toBe("2026-02-15");
  });

  it("clamps to the last day of a shorter target month instead of overflowing", () => {
    // Plain setMonth would roll 31 Jan + 1 month forward into 3 March.
    expect(ymd(addBillingPeriod(new Date(2026, 0, 31, 12, 0, 0), "monthly"))).toBe("2026-02-28");
  });

  it("does not mutate the input date", () => {
    const base = new Date(2026, 0, 15, 10, 30, 0);
    addBillingPeriod(base, "monthly");
    expect(ymd(base)).toBe("2026-01-15");
  });

  it("rejects an invalid base date", () => {
    expect(() => addBillingPeriod(new Date("not-a-date"), "monthly")).toThrow();
  });
});

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

describe("isSubscriptionActive", () => {
  it("is true only when active AND not yet expired", () => {
    expect(isSubscriptionActive(activeOrg(), NOW)).toBe(true);
    expect(isSubscriptionActive(activeOrg({ subscription_expiry: daysFrom(NOW, -1) }), NOW)).toBe(false);
    expect(isSubscriptionActive(activeOrg({ subscription_status: "expired" }), NOW)).toBe(false);
    // The Free plan is 'active' but has a NULL expiry -> nothing to extend.
    expect(isSubscriptionActive(activeOrg({ subscription_expiry: null }), NOW)).toBe(false);
  });
});

describe("comparePlanTier", () => {
  it("ranks by daily_request_quota first", () => {
    expect(comparePlanTier(PLAN_A, PLAN_B)).toBe("upgrade");
    expect(comparePlanTier(PLAN_B, PLAN_A)).toBe("downgrade");
  });

  it("falls back to monthly_price when the quota ties", () => {
    const cheap = { id: 10, monthly_price: 5000, daily_request_quota: 10, billing_period: "monthly" };
    const dear = { id: 11, monthly_price: 9000, daily_request_quota: 10, billing_period: "monthly" };
    expect(comparePlanTier(cheap, dear)).toBe("upgrade");
    expect(comparePlanTier(dear, cheap)).toBe("downgrade");
  });

  it("reports 'same' when both quota and price tie", () => {
    expect(comparePlanTier(PLAN_A, PLAN_A_RENAMED)).toBe("same");
  });
});

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ resolveSubscriptionChange: the four cases â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

describe("resolveSubscriptionChange", () => {
  it("Case A (renewal while active) SCHEDULES instead of extending now", () => {
    // Model correction: a renewal is no longer a distinct immediate outcome. It
    // is a scheduled change whose target happens to be the plan the org already
    // has, so pending_plan_id is allowed to equal subscription_plan_id.
    const change = resolveSubscriptionChange(activeOrg(), PLAN_A, { now: NOW });

    expect(change.action).toBe("change_scheduled");
    expect(change.relation).toBe("same");
    expect(change.is_renewal).toBe(true);
    expect(change.apply_immediately).toBe(false);
    // Nothing about the live period moves today.
    expect(ymd(change.subscription_expiry)).toBe("2026-02-15");
    expect(change.subscription_plan_id).toBe(PLAN_A.id);
    expect(change.subscription_status).toBe("active");
    // The renewal target IS the current plan.
    expect(change.pending_plan_id).toBe(PLAN_A.id);
    // A scheduled change is never a fresh start.
    expect(change.restamp_start).toBe(false);
  });

  it("a scheduled renewal carries no new expiry until the sweep applies it", () => {
    // The 31 days already paid for are not consumed and not double-charged: the
    // decision records an unchanged expiry, and the sweep later computes
    // new_expiry = old_expiry + billing_period.
    const change = resolveSubscriptionChange(activeOrg(), PLAN_A, { now: NOW });

    expect(ymd(change.subscription_expiry)).toBe("2026-02-15");
    expect(ymd(change.subscription_expiry)).not.toBe(ymd(daysFrom(NOW, 30)));
    // The base the sweep will extend from is the existing expiry, not today.
    expect(ymd(change.period_base_date)).toBe("2026-02-15");
  });

  it("Case A (expired renewal) starts a fresh cycle from today", () => {
    const org = activeOrg({ subscription_status: "expired", subscription_expiry: daysFrom(NOW, -3) });
    const change = resolveSubscriptionChange(org, PLAN_A, { now: NOW });

    expect(change.action).toBe("activate_now");
    expect(ymd(change.subscription_expiry)).toBe(ymd(new Date(2026, 1, 15, 10, 30, 0)));
    expect(change.restamp_start).toBe(true);
    expect(change.pending_plan_id).toBeNull();
  });

  it("Case A: a brand new org with no subscription at all starts from today", () => {
    const org = {
      id: 7,
      subscription_status: "none",
      subscription_start: null,
      subscription_expiry: null,
      subscription_plan_id: null,
      pending_plan_id: null,
      current_plan: null,
    };
    const change = resolveSubscriptionChange(org, PLAN_B, { now: NOW });

    expect(change.action).toBe("activate_now");
    expect(change.subscription_plan_id).toBe(PLAN_B.id);
    expect(ymd(change.subscription_expiry)).toBe("2026-02-15");
    expect(change.restamp_start).toBe(true);
    expect(change.pending_plan_id).toBeNull();
  });

  it("Case A: a free-plan org (active, NULL expiry) is a fresh activation, not a renewal", () => {
    const org = {
      id: 8,
      subscription_status: "active",
      subscription_start: new Date(2025, 5, 1),
      subscription_expiry: null,
      subscription_plan_id: 0,
      pending_plan_id: null,
      current_plan: { id: 0, name: "Free", monthly_price: 0, daily_request_quota: 0, billing_period: "monthly" },
    };
    const change = resolveSubscriptionChange(org, PLAN_A, { now: NOW });

    expect(change.action).toBe("activate_now");
    expect(ymd(change.subscription_expiry)).toBe("2026-02-15");
  });

  it("Case A: a same-tier plan under a different id is scheduled, keeping the current plan", () => {
    const change = resolveSubscriptionChange(activeOrg(), PLAN_A_RENAMED, { now: NOW });

    expect(change.action).toBe("change_scheduled");
    expect(change.relation).toBe("same");
    // The org keeps the plan it already has for now: a cosmetic rename must not
    // swap their billing period out from under them mid-period.
    expect(change.subscription_plan_id).toBe(PLAN_A.id);
    expect(ymd(change.subscription_expiry)).toBe("2026-02-15");
    // The renamed plan is what is queued, so at expiry the rename takes effect.
    expect(change.pending_plan_id).toBe(PLAN_A_RENAMED.id);
  });

  it("Case B (upgrade while active) switches immediately on a fresh cycle", () => {
    const change = resolveSubscriptionChange(activeOrg(), PLAN_B, { now: NOW });

    expect(change.action).toBe("upgrade_now");
    expect(change.subscription_plan_id).toBe(PLAN_B.id);
    expect(change.subscription_status).toBe("active");
    // No proration, no carry-over: today + one period.
    expect(ymd(change.subscription_expiry)).toBe("2026-02-15");
    expect(change.restamp_start).toBe(false);
    expect(change.pending_plan_id).toBeNull();
  });

  it("Case B honours the requested plan's own billing period", () => {
    const change = resolveSubscriptionChange(activeOrg(), PLAN_B_YEARLY, { now: NOW });
    expect(ymd(change.subscription_expiry)).toBe("2027-01-15");
  });

  it("Case C (downgrade while active) changes nothing now and parks the plan", () => {
    const org = activeOrg({ subscription_plan_id: PLAN_B.id, current_plan: PLAN_B });
    const change = resolveSubscriptionChange(org, PLAN_A, { now: NOW });

    // Same action name as a renewal: one mechanism for every non-upgrade change
    // while a subscription is live.
    expect(change.action).toBe("change_scheduled");
    expect(change.relation).toBe("downgrade");
    expect(change.is_renewal).toBe(false);
    expect(change.apply_immediately).toBe(false);
    // Everything about the current subscription is untouched...
    expect(change.subscription_plan_id).toBe(PLAN_B.id);
    expect(ymd(change.subscription_expiry)).toBe("2026-02-15");
    expect(change.subscription_status).toBe("active");
    // ...and the new plan waits in pending_plan_id.
    expect(change.pending_plan_id).toBe(PLAN_A.id);
  });

  it("force: true makes an admin override apply the downgrade immediately", () => {
    const org = activeOrg({ subscription_plan_id: PLAN_B.id, current_plan: PLAN_B });
    const change = resolveSubscriptionChange(org, PLAN_A, { now: NOW, force: true });

    expect(change.action).toBe("activate_now");
    expect(change.subscription_plan_id).toBe(PLAN_A.id);
    expect(ymd(change.subscription_expiry)).toBe("2026-02-15");
    expect(change.pending_plan_id).toBeNull();
  });

  it("ignores force for an org with no live subscription (nothing to protect)", () => {
    const org = {
      id: 9,
      subscription_status: "expired",
      subscription_expiry: daysFrom(NOW, -10),
      subscription_plan_id: PLAN_B.id,
      pending_plan_id: null,
      current_plan: PLAN_B,
    };
    const change = resolveSubscriptionChange(org, PLAN_A, { now: NOW, force: true });
    expect(change.action).toBe("activate_now");
    expect(ymd(change.subscription_expiry)).toBe("2026-02-15");
  });

  it("rejects a change with no plan", () => {
    expect(() => resolveSubscriptionChange(activeOrg(), null, { now: NOW })).toThrow();
  });
});

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ applySubscriptionChange: the SQL it writes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

describe("applySubscriptionChange", () => {
  let connection;
  beforeEach(() => {
    connection = { query: vi.fn().mockResolvedValue([[], []]) };
  });

  it("writes the resolved expiry/plan and clears any pending plan on an immediate change", async () => {
    const change = resolveSubscriptionChange(activeOrg(), PLAN_B, { now: NOW });
    await applySubscriptionChange(connection, { organizationId: 42, change, now: NOW });

    const update = connection.query.mock.calls.find(([sql]) => sql.includes("UPDATE organizations"));
    expect(update).toBeDefined();
    expect(update[0]).toContain("pending_plan_id=NULL");
    expect(update[1]).toEqual([0, NOW, change.subscription_expiry, PLAN_B.id, 42]);
  });

  it("only writes pending_plan_id for a deferred downgrade", async () => {
    const org = activeOrg({ subscription_plan_id: PLAN_B.id, current_plan: PLAN_B });
    const change = resolveSubscriptionChange(org, PLAN_A, { now: NOW });
    await applySubscriptionChange(connection, { organizationId: 42, change, now: NOW });

    expect(connection.query).toHaveBeenCalledTimes(1);
    const [sql, params] = connection.query.mock.calls[0];
    expect(sql).toBe("UPDATE organizations SET pending_plan_id=? WHERE id=?");
    expect(params).toEqual([PLAN_A.id, 42]);
    // The current period's usage must NOT be reset for a downgrade that has not
    // taken effect yet.
    expect(
      connection.query.mock.calls.some(([s]) => String(s).includes("daily_request_usage"))
    ).toBe(false);
  });

  it("clears today's usage only for an immediate change", async () => {
    // Immediate = an upgrade (or a fresh activation on a lapsed plan). A
    // scheduled change grants nothing today, so it must not clear usage.
    await applySubscriptionChange(connection, {
      organizationId: 42,
      change: resolveSubscriptionChange(activeOrg(), PLAN_B, { now: NOW }),
      now: NOW,
    });

    expect(
      connection.query.mock.calls.some(([s]) => String(s).includes("DELETE FROM daily_request_usage"))
    ).toBe(true);
  });

  it("does NOT clear today's usage for a scheduled renewal", async () => {
    // This used to be an immediate "renew" and DID clear usage. A renewal no
    // longer grants a new plan, so clearing the bucket would hand back daily
    // quota the customer has not paid for twice.
    await applySubscriptionChange(connection, {
      organizationId: 42,
      change: resolveSubscriptionChange(activeOrg(), PLAN_A, { now: NOW }),
      now: NOW,
    });

    expect(
      connection.query.mock.calls.some(([s]) => String(s).includes("DELETE FROM daily_request_usage"))
    ).toBe(false);
  });
});

/* ─────────────────── identifying Free: flag only, never id/name/price ─────────────────── */

describe("isFreePlan", () => {
  it("recognises the Free plan purely by the is_free flag", () => {
    expect(isFreePlan({ id: 77, name: "Starter", monthly_price: 0, is_free: 1 })).toBe(true);
    expect(isFreePlan({ is_free: true })).toBe(true);
    expect(isFreePlan({ is_free: "1" })).toBe(true);
  });

  it("does not infer Free from a zero price or a plan name", () => {
    // A paid plan priced at 0 and a plan merely NAMED "Free" must both be
    // treated as paid -- only the flag identifies the Free plan.
    expect(isFreePlan({ name: "Free", monthly_price: 0, is_free: 0 })).toBe(false);
    expect(isFreePlan({ name: "Free", is_free: undefined })).toBe(false);
    expect(isFreePlan({ name: "Trial", monthly_price: 0, is_free: 0 })).toBe(false);
    expect(isFreePlan(null)).toBe(false);
  });
});

describe("getFreePlan", () => {
  it("looks the plan up dynamically by is_free=1", async () => {
    const executor = { query: vi.fn().mockResolvedValue([[FREE_PLAN], []]) };
    const plan = await getFreePlan(executor);

    expect(plan).toEqual(FREE_PLAN);
    const [sql, params] = executor.query.mock.calls[0];
    expect(sql).toContain("is_free=1");
    // No id and no name is baked into the query, so the lookup keeps working if
    // the Free plan is recreated or renamed.
    expect(sql).not.toMatch(/id\s*=\s*\d/);
    expect(sql).not.toMatch(/name\s*=\s*'/);
    expect(params ?? []).toEqual([]);
  });

  it("throws a loud error when no Free plan is configured", async () => {
    const executor = { query: vi.fn().mockResolvedValue([[], []]) };
    await expect(getFreePlan(executor)).rejects.toThrow(/is_free=1/);
    expect(await findFreePlan(executor)).toBeNull();
  });
});

/* ────────────── Free has no billing cycle: NULL expiry, not "expired" ────────────── */

describe("expiryForPlan", () => {
  it("gives a paid plan a normal period from the base date", () => {
    expect(ymd(expiryForPlan(PLAN_A, new Date(2026, 0, 15, 10, 30, 0)))).toBe("2026-02-15");
    expect(ymd(expiryForPlan(PLAN_B_YEARLY, new Date(2026, 0, 15, 10, 30, 0)))).toBe("2027-01-15");
  });

  it("gives the Free plan NO expiry at all", () => {
    expect(expiryForPlan(FREE_PLAN, new Date(2026, 0, 15, 10, 30, 0))).toBeNull();
  });
});

describe("isSubscriptionValid", () => {
  it("accepts an active Free org with a NULL expiry (indefinite, not expired)", () => {
    expect(isSubscriptionValid(freeOrg(), NOW)).toBe(true);
  });

  it("accepts a paid org whose expiry is still in the future", () => {
    expect(isSubscriptionValid(activeOrg(), NOW)).toBe(true);
  });

  it("rejects a paid org whose expiry has passed, even while status says active", () => {
    const lapsed = activeOrg({ subscription_expiry: daysFrom(NOW, -1) });
    expect(isSubscriptionValid(lapsed, NOW)).toBe(false);
  });

  it("rejects a paid plan with a NULL expiry as a data bug rather than granting perpetual access", () => {
    const buggy = activeOrg({ subscription_expiry: null });
    expect(isSubscriptionValid(buggy, NOW)).toBe(false);
  });

  it("rejects any non-active status", () => {
    expect(isSubscriptionValid(freeOrg({ subscription_status: "expired" }), NOW)).toBe(false);
    expect(isSubscriptionValid(freeOrg({ subscription_status: "none" }), NOW)).toBe(false);
    expect(isSubscriptionValid(freeOrg({ subscription_status: "pending_payment" }), NOW)).toBe(false);
  });
});

describe("comparePlanTier with the Free plan", () => {
  it("always ranks paid above Free, whatever the numbers say", () => {
    // A Free plan given a generous quota, and a paid plan given none: the flag
    // decides, not the numbers.
    const generousFree = { ...FREE_PLAN, daily_request_quota: 9999 };
    const zeroQuotaPaid = { ...PLAN_A, daily_request_quota: 0 };
    expect(comparePlanTier(FREE_PLAN, PLAN_A)).toBe("upgrade");
    expect(comparePlanTier(PLAN_A, FREE_PLAN)).toBe("downgrade");
    expect(comparePlanTier(zeroQuotaPaid, generousFree)).toBe("downgrade");
    expect(comparePlanTier(generousFree, zeroQuotaPaid)).toBe("upgrade");
  });

  it("reports Free against Free as the same tier", () => {
    const otherFree = { ...FREE_PLAN, id: 78, name: "Renamed Free" };
    expect(comparePlanTier(FREE_PLAN, otherFree)).toBe("same");
  });
});

/* ─────────────── resolveSubscriptionChange: Free as a real plan (Part 5) ─────────────── */

describe("resolveSubscriptionChange involving the Free plan", () => {
  it("upgrading FROM Free runs the normal upgrade comparison and starts a paid cycle today", () => {
    const change = resolveSubscriptionChange(freeOrg(), PLAN_B, { now: NOW });

    // Free is a real active subscription, so the org does NOT hit a "no plan"
    // special case -- it runs through the ordinary tier comparison, exactly as
    // Part 5 requires.
    expect(change.action).toBe("upgrade_now");
    expect(change.relation).toBe("upgrade");
    expect(change.subscription_plan_id).toBe(PLAN_B.id);
    expect(ymd(change.subscription_expiry)).toBe("2026-02-15");
    // The org has been a subscriber since it was created, so an upgrade does not
    // restamp that date.
    expect(change.restamp_start).toBe(false);
  });

  it("downgrading TO Free from a paid plan is SCHEDULED, exactly like any other downgrade", () => {
    const org = activeOrg({ subscription_plan_id: PLAN_B.id, current_plan: PLAN_B });
    const change = resolveSubscriptionChange(org, FREE_PLAN, { now: NOW });

    // No special-cased Free path: it flows through the ordinary scheduled-change
    // branch, keeping the paid features the org already paid for. Free is only
    // special at APPLY time, where its expiry becomes NULL.
    expect(change.action).toBe("change_scheduled");
    expect(change.relation).toBe("downgrade");
    expect(change.apply_immediately).toBe(false);
    expect(change.subscription_plan_id).toBe(PLAN_B.id);
    expect(ymd(change.subscription_expiry)).toBe("2026-02-15");
    expect(change.pending_plan_id).toBe(FREE_PLAN.id);
  });

  it("assigning Free to an org whose paid plan has already lapsed gives it no expiry", () => {
    const lapsed = activeOrg({ subscription_expiry: daysFrom(NOW, -5) });
    const change = resolveSubscriptionChange(lapsed, FREE_PLAN, { now: NOW });

    expect(change.action).toBe("activate_now");
    // Free never needs renewing, so it must not be given a synthetic month.
    expect(change.subscription_expiry).toBeNull();
    expect(change.subscription_plan_id).toBe(FREE_PLAN.id);
    expect(change.pending_plan_id).toBeNull();
  });

  it("does NOT defer a downgrade against an already-lapsed subscription", () => {
    // The reason the "no live period" short-circuit must stay BEFORE the tier
    // comparison: a lower-tier plan bought after the current one expired would
    // otherwise be classified as a downgrade and parked in pending_plan_id to be
    // applied at an expiry date that is already in the past, against paid time
    // that no longer exists.
    const lapsedHighTier = activeOrg({
      subscription_plan_id: PLAN_B.id,
      current_plan: PLAN_B,
      subscription_expiry: daysFrom(NOW, -5),
    });
    const change = resolveSubscriptionChange(lapsedHighTier, PLAN_A, { now: NOW });

    expect(change.action).toBe("activate_now");
    expect(change.relation).toBe("downgrade");
    expect(change.apply_immediately).toBe(true);
    expect(change.pending_plan_id).toBeNull();
  });

  it("re-selecting Free schedules a no-op renewal that keeps the expiry NULL", () => {
    // Free never expires, so this scheduled change is a genuine no-op: nothing
    // changes at apply time either. It is still scheduled rather than applied
    // immediately, because the rule is "everything that is not an upgrade is
    // scheduled" with no carve-out for Free.
    const change = resolveSubscriptionChange(freeOrg(), FREE_PLAN, { now: NOW });

    expect(change.action).toBe("change_scheduled");
    expect(change.relation).toBe("same");
    expect(change.is_renewal).toBe(true);
    expect(change.apply_immediately).toBe(false);
    // Free carries no expiry, and none is invented for the scheduled window.
    expect(change.subscription_expiry).toBeNull();
    expect(change.subscription_plan_id).toBe(FREE_PLAN.id);
    expect(change.pending_plan_id).toBe(FREE_PLAN.id);
  });

  it("reports the tier relation even on the activate short-circuit", () => {
    // A paid plan that has already lapsed, then a lower plan is bought. The
    // action is a fresh start (there is no paid time left to defer against),
    // but the relation is still reported so audit/UX can say what happened.
    const lapsed = activeOrg({ subscription_expiry: daysFrom(NOW, -5) });
    const change = resolveSubscriptionChange(lapsed, PLAN_B, { now: NOW });

    expect(change.action).toBe("activate_now");
    expect(change.relation).toBe("upgrade");
  });
});

/* ──────────── Part 2: new organizations land on the real Free plan ──────────── */

describe("new organizations default to the real Free plan", () => {
  it("freePlanInsertColumns produces a plan-backed active subscription", () => {
    const cols = freePlanInsertColumns(FREE_PLAN);
    expect(cols).toEqual({
      subscription_plan_id: FREE_PLAN.id,
      subscription_status: "active",
      // Free has no billing cycle, so the expiry is NULL ("indefinite").
      subscription_expiry: null,
    });
    // Crucially NOT null / 'none'.
    expect(cols.subscription_plan_id).not.toBeNull();
    expect(cols.subscription_status).not.toBe("none");
  });

  it("refuses to build insert columns from a plan that is not flagged Free", () => {
    expect(() => freePlanInsertColumns(PLAN_A)).toThrow(/is_free/);
  });

  it("assignFreePlanToOrg writes the looked-up plan, never a hardcoded id", async () => {
    const executor = {
      query: vi.fn(async (sql) => {
        if (sql.includes("is_free=1")) return [[FREE_PLAN], []];
        return [{ affectedRows: 1 }, []];
      }),
    };

    const plan = await assignFreePlanToOrg(executor, 99);

    expect(plan.id).toBe(FREE_PLAN.id);
    const update = executor.query.mock.calls.find(([sql]) => sql.includes("UPDATE organizations"));
    expect(update[0]).toContain("subscription_plan_id=?");
    expect(update[0]).toContain("subscription_expiry=NULL");
    expect(update[0]).toContain("pending_plan_id=NULL");
    expect(update[1]).toEqual([FREE_PLAN.id, 99]);
  });

  it("assignFreePlanToOrg fails loudly if the Free plan is missing", async () => {
    const executor = { query: vi.fn().mockResolvedValue([[], []]) };
    await expect(assignFreePlanToOrg(executor, 99)).rejects.toThrow(/is_free=1/);
  });
});

/* ─────── Part 4: quota must not be granted to a lapsed paid subscription ─────── */

describe("getOrgPlan quota entitlement", () => {
  const usageRow = [{ requests_used: 0, total_requests: 0 }];

  // getOrgPlan reads the real clock internally, so these have to be relative to
  // the real "now" rather than the fixed NOW used by the pure transition tests.
  const realDaysFromNow = (days) => new Date(Date.now() + days * 86400000);

  function mockOrgPlanQuery(row) {
    pool.query.mockImplementation(async (sql) => {
      if (String(sql).includes("FROM daily_request_usage")) return [usageRow, []];
      if (String(sql).includes("FROM organizations o")) return [[row], []];
      return [[], []];
    });
  }

  it("grants the paid quota to an active paid org inside its period", async () => {
    mockOrgPlanQuery({
      plan_id: PLAN_B.id,
      subscription_status: "active",
      subscription_expiry: realDaysFromNow(5),
      plan_name: PLAN_B.name,
      quota: 100,
      is_free: 0,
    });
    const plan = await getOrgPlan(1);
    expect(plan.quota).toBe(100);
    expect(plan.is_active).toBe(true);
    expect(plan.is_free).toBe(false);
  });

  it("does NOT grant the paid quota once the paid expiry has passed", async () => {
    mockOrgPlanQuery({
      plan_id: PLAN_B.id,
      subscription_status: "active", // stale flag: the job has not swept yet
      subscription_expiry: realDaysFromNow(-1),
      plan_name: PLAN_B.name,
      quota: 100,
      is_free: 0,
    });
    const plan = await getOrgPlan(1);
    expect(plan.quota).toBe(0);
    expect(plan.is_active).toBe(false);
  });

  it("treats a Free org as active with no paid quota (1 free request/day baseline)", async () => {
    mockOrgPlanQuery({
      plan_id: FREE_PLAN.id,
      subscription_status: "active",
      subscription_expiry: null,
      plan_name: FREE_PLAN.name,
      quota: 0,
      is_free: 1,
    });
    const plan = await getOrgPlan(1);
    expect(plan.is_active).toBe(true);
    expect(plan.is_free).toBe(true);
    expect(plan.quota).toBe(0);
  });
});

/* ─────────────────── getPlanSummary is data-driven, not name-driven ─────────────────── */

describe("getPlanSummary", () => {
  // getPlanSummary reads the real clock, so expiries here are relative to now.
  const realDaysFromNow = (days) => new Date(Date.now() + days * 86400000);

  it("reports a Free org as the free tier with no expiry, not as expired", () => {
    const summary = getPlanSummary({
      status: "active",
      plan_name: FREE_PLAN.name,
      is_free: 1,
      expiry: null,
    });
    expect(summary.is_free).toBe(true);
    expect(summary.code).toBe("free");
    expect(summary.is_expired).toBe(false);
    expect(summary.has_expiry).toBe(false);
    expect(summary.expires_at).toBeNull();
    expect(summary.status).toBe("free");
  });

  it("does not treat a plan merely NAMED Free as the free tier", () => {
    const summary = getPlanSummary({
      status: "active",
      plan_name: "Free",
      is_free: 0,
      expiry: realDaysFromNow(10),
    });
    expect(summary.is_free).toBe(false);
    expect(summary.code).toBe("paid");
    expect(summary.is_active).toBe(true);
  });

  it("reports a lapsed paid plan as expired", () => {
    const summary = getPlanSummary({
      status: "active",
      plan_name: PLAN_B.name,
      is_free: 0,
      expiry: realDaysFromNow(-2),
    });
    expect(summary.is_expired).toBe(true);
    expect(summary.status).toBe("expired");
  });

  it("treats a paid plan with a NULL expiry as a data bug, not perpetual access", () => {
    const summary = getPlanSummary({
      status: "active",
      plan_name: PLAN_B.name,
      is_free: 0,
      expiry: null,
    });
    expect(summary.is_expired).toBe(true);
    expect(summary.is_active).toBe(false);
  });
});

/* ───────── the lifecycle sweep: scheduled change vs unplanned lapse ───────── */

const EXPIRED_EXPIRY = new Date(2026, 0, 10, 10, 30, 0); // already in the past

/**
 * A fake transaction connection that answers the sweep's queries for one org.
 * `plan` is the plan pointed at by pending_plan_id.
 */
function fakeConnection({ org, plan = null, affectedRows = 1 }) {
  return {
    query: vi.fn(async (sql) => {
      if (typeof sql !== "string") return [[], []];
      if (sql.includes("FROM organizations")) return [[{ ...org }], []];
      if (sql.includes("FROM subscription_plans")) return [plan ? [{ ...plan }] : [], []];
      if (sql.startsWith("UPDATE organizations")) return [{ affectedRows }, []];
      return [[], []];
    }),
    beginTransaction: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    release: vi.fn(),
  };
}

/**
 * The sweep issues two candidate queries on the pool. `due` feeds the
 * scheduled-change query, `lapsed` the lapsed-paid query.
 */
function seedPoolQueries({ due = [], lapsed = [], planless = [] } = {}) {
  pool.query.mockImplementation(async (sql) => {
    const s = String(sql);
    if (s.includes("pending_plan_id IS NOT NULL")) return [due, []];
    if (s.includes("sp.is_free = 0")) return [lapsed, []];
    if (s.includes("o.subscription_status = 'none'")) return [planless, []];
    if (s.includes("is_free=1")) return [[FREE_PLAN], []];
    if (s.includes("FROM users")) return [[], []];
    return [{ affectedRows: 1 }, []];
  });
}

describe("applyDueSubscriptionChanges", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("branch 1: a scheduled plan change comes due", () => {
    it("switches the plan, extends from the old expiry and clears pending_plan_id", async () => {
      const org = {
        id: 42,
        uuid: "org-uuid-42",
        name: "Acme",
        subscription_status: "expired",
        subscription_plan_id: PLAN_B.id,
        pending_plan_id: PLAN_A.id,
        subscription_expiry: EXPIRED_EXPIRY,
      };
      const connection = fakeConnection({ org, plan: PLAN_A });
      pool.getConnection.mockResolvedValue(connection);
      seedPoolQueries({
        due: [{ id: 42, uuid: "org-uuid-42", name: "Acme", pending_plan_id: PLAN_A.id, subscription_expiry: EXPIRED_EXPIRY }],
      });

      const result = await applyDueSubscriptionChanges();

      expect(result.failed).toEqual([]);
      expect(result.scheduled).toHaveLength(1);
      expect(result.scheduled[0]).toMatchObject({
        organization_id: 42,
        plan_id: PLAN_A.id,
        previous_expiry: EXPIRED_EXPIRY,
      });
      // New period starts where the old one ended: no paid time lost.
      expect(ymd(result.scheduled[0].new_expiry)).toBe("2026-02-10");

      const update = connection.query.mock.calls.find(([sql]) => String(sql).startsWith("UPDATE organizations"));
      expect(update[0]).toContain("subscription_plan_id=?");
      expect(update[0]).toContain("pending_plan_id=NULL");
      expect(update[1]).toEqual([PLAN_A.id, result.scheduled[0].new_expiry, 42, PLAN_A.id]);
      // Guarded on the pending id it observed, so a concurrent run cannot
      // re-apply the same change twice.
      expect(update[0]).toContain("WHERE id=? AND pending_plan_id=?");
      expect(connection.commit).toHaveBeenCalledTimes(1);
      expect(connection.rollback).not.toHaveBeenCalled();
    });

    it("applies a scheduled downgrade to Free with NO expiry", async () => {
      const org = {
        id: 43,
        uuid: "org-uuid-43",
        name: "Beta",
        subscription_status: "active",
        subscription_plan_id: PLAN_B.id,
        pending_plan_id: FREE_PLAN.id,
        subscription_expiry: EXPIRED_EXPIRY,
      };
      const connection = fakeConnection({ org, plan: FREE_PLAN });
      pool.getConnection.mockResolvedValue(connection);
      seedPoolQueries({
        due: [{ id: 43, uuid: "org-uuid-43", name: "Beta", pending_plan_id: FREE_PLAN.id, subscription_expiry: EXPIRED_EXPIRY }],
      });

      const result = await applyDueSubscriptionChanges();

      expect(result.scheduled).toHaveLength(1);
      expect(result.scheduled[0].plan_id).toBe(FREE_PLAN.id);
      // Free has no billing cycle, so it must NOT be given a synthetic month.
      expect(result.scheduled[0].new_expiry).toBeNull();
    });

    it("does nothing when a scheduled change is not due yet", async () => {
      const future = new Date(2099, 0, 1);
      const org = {
        id: 44,
        uuid: "org-uuid-44",
        name: "Gamma",
        subscription_status: "active",
        subscription_plan_id: PLAN_B.id,
        pending_plan_id: PLAN_A.id,
        subscription_expiry: future,
      };
      const connection = fakeConnection({ org, plan: PLAN_A });
      pool.getConnection.mockResolvedValue(connection);
      seedPoolQueries({
        due: [{ id: 44, uuid: "org-uuid-44", name: "Gamma", pending_plan_id: PLAN_A.id, subscription_expiry: future }],
      });

      const result = await applyDueSubscriptionChanges();

      expect(result.scheduled).toEqual([]);
      expect(
        connection.query.mock.calls.some(([sql]) => String(sql).startsWith("UPDATE organizations"))
      ).toBe(false);
      expect(connection.rollback).toHaveBeenCalledTimes(1);
    });

    it("skips an org whose pending plan was already cleared by a concurrent run", async () => {
      const org = {
        id: 45,
        uuid: "org-uuid-45",
        name: "Delta",
        subscription_status: "expired",
        subscription_plan_id: PLAN_B.id,
        pending_plan_id: null, // cleared under the lock
        subscription_expiry: EXPIRED_EXPIRY,
      };
      const connection = fakeConnection({ org, plan: PLAN_A });
      pool.getConnection.mockResolvedValue(connection);
      seedPoolQueries({
        due: [{ id: 45, uuid: "org-uuid-45", name: "Delta", pending_plan_id: PLAN_A.id, subscription_expiry: EXPIRED_EXPIRY }],
      });

      const result = await applyDueSubscriptionChanges();

      expect(result.scheduled).toEqual([]);
      expect(
        connection.query.mock.calls.some(([sql]) => String(sql).startsWith("UPDATE organizations"))
      ).toBe(false);
    });
  });

  describe("branch 2: a paid subscription lapses with nothing scheduled", () => {
    const lapsedOrg = {
      id: 60,
      uuid: "org-uuid-60",
      name: "Epsilon",
      subscription_status: "active",
      subscription_plan_id: PLAN_B.id,
      subscription_expiry: EXPIRED_EXPIRY,
    };

    it("falls back to the real Free plan with a NULL expiry", async () => {
      const connection = fakeConnection({ org: { ...lapsedOrg, is_free: 0 } });
      pool.getConnection.mockResolvedValue(connection);
      seedPoolQueries({ lapsed: [{ ...lapsedOrg, plan_id: PLAN_B.id, plan_name: PLAN_B.name }] });

      const result = await applyDueSubscriptionChanges();

      expect(result.failed).toEqual([]);
      expect(result.lapsed).toHaveLength(1);
      expect(result.lapsed[0]).toMatchObject({
        organization_id: 60,
        previous_plan_id: PLAN_B.id,
        new_plan_id: FREE_PLAN.id,
        new_expiry: null,
      });

      const update = connection.query.mock.calls.find(([sql]) => String(sql).startsWith("UPDATE organizations"));
      expect(update[0]).toContain("subscription_status='active'");
      expect(update[0]).toContain("subscription_expiry=NULL");
      expect(update[1]).toEqual([FREE_PLAN.id, 60, PLAN_B.id]);
      // Guarded so it cannot clobber a renewal or an appearing scheduled change.
      expect(update[0]).toContain("pending_plan_id IS NULL");
      expect(update[0]).toContain("subscription_expiry <= NOW()");
      expect(connection.commit).toHaveBeenCalledTimes(1);
    });

    it("looks the Free plan up dynamically rather than assuming a fixed id", async () => {
      const connection = fakeConnection({ org: { ...lapsedOrg, is_free: 0 } });
      pool.getConnection.mockResolvedValue(connection);
      seedPoolQueries({ lapsed: [{ ...lapsedOrg, plan_id: PLAN_B.id, plan_name: PLAN_B.name }] });

      await applyDueSubscriptionChanges();

      const lookup = pool.query.mock.calls.find(([sql]) => String(sql).includes("is_free=1"));
      expect(lookup).toBeDefined();
      expect(lookup[0]).not.toMatch(/id\s*=\s*\d/);
    });

    it("skips an org that is already on Free", async () => {
      const onFree = { ...lapsedOrg, subscription_plan_id: FREE_PLAN.id, is_free: 1 };
      const connection = fakeConnection({ org: onFree });
      pool.getConnection.mockResolvedValue(connection);
      seedPoolQueries({ lapsed: [{ ...onFree, plan_id: FREE_PLAN.id, plan_name: FREE_PLAN.name }] });

      const result = await applyDueSubscriptionChanges();

      expect(result.lapsed).toEqual([]);
      expect(
        connection.query.mock.calls.some(([sql]) => String(sql).startsWith("UPDATE organizations"))
      ).toBe(false);
    });

    it("skips an org that acquired a scheduled change (the two branches must not double-fire)", async () => {
      // The candidate query said "lapsed", but between then and the lock a
      // pending_plan_id appeared. Branch 1 owns this org, not branch 2.
      const withPending = { ...lapsedOrg, is_free: 0, pending_plan_id: PLAN_A.id };
      const connection = fakeConnection({ org: withPending });
      pool.getConnection.mockResolvedValue(connection);
      seedPoolQueries({ lapsed: [{ ...lapsedOrg, plan_id: PLAN_B.id, plan_name: PLAN_B.name }] });

      const result = await applyDueSubscriptionChanges();

      expect(result.lapsed).toEqual([]);
      expect(
        connection.query.mock.calls.some(([sql]) => String(sql).startsWith("UPDATE organizations"))
      ).toBe(false);
      expect(connection.rollback).toHaveBeenCalledTimes(1);
    });

    it("skips an org that was renewed since the candidate query ran", async () => {
      const renewed = { ...lapsedOrg, is_free: 0, subscription_expiry: new Date(2099, 0, 1) };
      const connection = fakeConnection({ org: renewed });
      pool.getConnection.mockResolvedValue(connection);
      seedPoolQueries({ lapsed: [{ ...lapsedOrg, plan_id: PLAN_B.id, plan_name: PLAN_B.name }] });

      const result = await applyDueSubscriptionChanges();

      expect(result.lapsed).toEqual([]);
      expect(
        connection.query.mock.calls.some(([sql]) => String(sql).startsWith("UPDATE organizations"))
      ).toBe(false);
    });
  });

  // ── integrity net ──────────────────────────────────────────────────────────
  // An unexplained mutation once left organizations with subscription_plan_id
  // NULL and a non-active status. The sweep must heal that AND leave an audit
  // trail, so a recurrence is both self-healing and traceable.
  describe("integrity net: organizations left planless", () => {
    const planlessOrg = {
      id: 80,
      uuid: "org-uuid-80",
      name: "Corrupted",
      subscription_status: "pending_payment",
      subscription_plan_id: null,
      subscription_expiry: "2026-10-25T19:27:41.000Z",
      pending_plan_id: null,
    };

    it("heals a planless org onto the Free plan with no expiry", async () => {
      const connection = fakeConnection({ org: planlessOrg });
      pool.getConnection.mockResolvedValue(connection);
      seedPoolQueries({ planless: [planlessOrg] });

      const result = await applyDueSubscriptionChanges();

      expect(result.repaired).toHaveLength(1);
      expect(result.repaired[0]).toMatchObject({
        organization_id: 80,
        from_status: "pending_payment",
        from_plan_id: null,
        to_plan_id: FREE_PLAN.id,
        assigned_free_plan: true,
      });

      const update = connection.query.mock.calls.find(
        ([sql]) => String(sql).startsWith("UPDATE organizations")
      );
      expect(update[0]).toContain("subscription_status='active'");
      expect(update[0]).toContain("pending_plan_id=NULL");
      // Free has no billing cycle, so the expiry must be cleared.
      expect(update[1]).toEqual([FREE_PLAN.id, 1, 80]);
      expect(connection.commit).toHaveBeenCalledTimes(1);
    });

    it("normalises a 'none' org that still has its plan, keeping the plan", async () => {
      const onPaidPlan = {
        ...planlessOrg,
        subscription_status: "none",
        subscription_plan_id: PLAN_B.id,
      };
      const connection = fakeConnection({ org: onPaidPlan });
      pool.getConnection.mockResolvedValue(connection);
      seedPoolQueries({ planless: [onPaidPlan] });

      const result = await applyDueSubscriptionChanges();

      expect(result.repaired).toHaveLength(1);
      // The org already has a real plan, so it keeps it rather than being reset
      // to Free; only the status is repaired.
      expect(result.repaired[0]).toMatchObject({ to_plan_id: PLAN_B.id, assigned_free_plan: false });
      const update = connection.query.mock.calls.find(
        ([sql]) => String(sql).startsWith("UPDATE organizations")
      );
      expect(update[1]).toEqual([PLAN_B.id, 0, 80]);
    });

    it("skips an org that acquired a scheduled change before the lock", async () => {
      const withPending = { ...planlessOrg, pending_plan_id: PLAN_A.id };
      const connection = fakeConnection({ org: withPending });
      pool.getConnection.mockResolvedValue(connection);
      seedPoolQueries({ planless: [planlessOrg] });

      const result = await applyDueSubscriptionChanges();

      expect(result.repaired).toEqual([]);
      expect(
        connection.query.mock.calls.some(([sql]) => String(sql).startsWith("UPDATE organizations"))
      ).toBe(false);
    });

    it("does nothing on a healthy database", async () => {
      const connection = fakeConnection({ org: planlessOrg });
      pool.getConnection.mockResolvedValue(connection);
      seedPoolQueries({ planless: [] });

      const result = await applyDueSubscriptionChanges();

      expect(result.repaired).toEqual([]);
      expect(
        connection.query.mock.calls.some(([sql]) => String(sql).startsWith("UPDATE organizations"))
      ).toBe(false);
    });
  });

  it("keeps going when one organization fails", async () => {
    const bad = {
      id: 70,
      uuid: "org-uuid-70",
      name: "Zeta",
      subscription_status: "active",
      subscription_plan_id: PLAN_B.id,
      pending_plan_id: PLAN_A.id,
      subscription_expiry: EXPIRED_EXPIRY,
    };
    const good = { ...bad, id: 71, uuid: "org-uuid-71", name: "Eta" };

    const badConnection = {
      query: vi.fn().mockRejectedValue(new Error("deadlock")),
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
    };
    const goodConnection = fakeConnection({ org: good, plan: PLAN_A });
    pool.getConnection.mockResolvedValueOnce(badConnection).mockResolvedValueOnce(goodConnection);
    seedPoolQueries({
      due: [
        { id: 70, uuid: "org-uuid-70", name: "Zeta", pending_plan_id: PLAN_A.id, subscription_expiry: EXPIRED_EXPIRY },
        { id: 71, uuid: "org-uuid-71", name: "Eta", pending_plan_id: PLAN_A.id, subscription_expiry: EXPIRED_EXPIRY },
      ],
    });

    const result = await applyDueSubscriptionChanges();

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].organization_id).toBe(70);
    expect(result.scheduled.map((s) => s.organization_id)).toEqual([71]);
  });
});
