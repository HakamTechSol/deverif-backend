import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/config/db.js", () => ({ pool: { query: vi.fn() } }));

import requireModuleFeature, { MODULE_FEATURE_KEYS, assertModuleFeature, upgradeRequiredError, FEATURE_NOT_INCLUDED_MESSAGE, NO_ACTIVE_SUBSCRIPTION_MESSAGE } from "../src/middleware/requireModuleFeature.js";
import { ALL_MODULE_KEYS, ORIGINAL_MODULE_KEYS } from "./helpers/moduleKeyFixtures.js";
import { pool } from "../src/config/db.js";

/**
 * A fully provisioned plan, i.e. what every `subscription_plans.module_flags`
 * row looks like AFTER migrations/20261101_hr_modules_backfill_module_flags.sql.
 * Kept as one literal rather than derived so a test that accidentally depends on
 * a module key no longer existing fails loudly instead of quietly passing.
 */
const FULL_TRUES = JSON.stringify(
  Object.fromEntries(ALL_MODULE_KEYS.map((key) => [key, true]))
);

let orgRow;

function mockNext() {
  const next = vi.fn();
  return next;
}

/** Route the mocked pool query by which middleware issued it. */
function installPoolQuery() {
  pool.query = vi.fn(async (sql) => {
    if (String(sql).includes("sp.module_flags")) return [[orgRow]];
    // requireActiveSubscription's own live SELECT
    return [[{ subscription_status: orgRow.subscription_status }]];
  });
}

function reqWith(extra = {}) {
  return { method: "POST", scopeOrgId: 7, ...extra };
}

beforeEach(() => {
  vi.clearAllMocks();
  orgRow = { subscription_status: "active", module_flags: FULL_TRUES };
  installPoolQuery();
});

describe("requireModuleFeature", () => {
  it("factory rejects unknown module keys", () => {
    expect(() => requireModuleFeature("billing_management")).toThrowError(/Invalid module feature key/);
  });

  it("exposes every allowed module key, in the documented order", () => {
    // The five pre-existing core-HR modules must stay FIRST and in this exact
    // order — utils/moduleFlags.js documents that the leading order is pinned
    // so diffs against older revisions stay small. The thirteen workforce /
    // money-ops / automation modules follow.
    expect(MODULE_FEATURE_KEYS).toEqual([
      "employee_management",
      "attendance_management",
      "user_management",
      "leave_management",
      "payroll_management",
      "manpower_management",
      "recruitment_management",
      "onboarding_management",
      "separation_management",
      "training_management",
      "performance_management",
      "piece_work_management",
      "expense_management",
      "travel_management",
      "asset_management",
      "helpdesk_management",
      "scheduled_reports",
      "hr_letters_management",
    ]);
  });

  it("has no duplicate module keys", () => {
    expect(new Set(MODULE_FEATURE_KEYS).size).toBe(MODULE_FEATURE_KEYS.length);
  });

  // Every newly added module must behave identically to the original five, or
  // a module could ship unreachable (locked) or silently ungated (open) while
  // every other gate test still passed.
  it.each(MODULE_FEATURE_KEYS.filter((k) => !ORIGINAL_MODULE_KEYS.includes(k)))(
    "%s is gated by the plan's module_flags like any other module",
    async (key) => {
      // ON -> allowed.
      orgRow.module_flags = JSON.stringify({ [key]: true });
      const allow = mockNext();
      await requireModuleFeature(key)(reqWith(), {}, allow);
      expect(allow).toHaveBeenCalledTimes(1);
      expect(allow.mock.calls[0][0]).toBeUndefined();

      // OFF -> the distinct UPGRADE_REQUIRED 403 naming that module.
      orgRow.module_flags = JSON.stringify({ [key]: false });
      const deny = mockNext();
      await requireModuleFeature(key)(reqWith(), {}, deny);
      expect(deny.mock.calls[0][0].code).toBe("UPGRADE_REQUIRED");
      expect(deny.mock.calls[0][0].extra).toMatchObject({ module: key, can_retry: false });

      // ABSENT -> also locked. isModuleIncluded() is `flags[key] === true`, so a
      // key the plan never stored reads as undefined and is blocked. This is
      // exactly the trap migrations/20261101_hr_modules_backfill_module_flags.sql
      // exists to close, so it is pinned here deliberately.
      orgRow.module_flags = JSON.stringify({ employee_management: true });
      const absent = mockNext();
      await requireModuleFeature(key)(reqWith(), {}, absent);
      expect(absent.mock.calls[0][0].code).toBe("UPGRADE_REQUIRED");
    }
  );

  it("gives every module a human label, so no user sees a raw snake_case key", () => {
    for (const key of MODULE_FEATURE_KEYS) {
      const err = upgradeRequiredError(key);
      expect(err.extra.module_label, key).toBeTruthy();
      expect(err.extra.module_label, key).toMatch(/^[A-Z]/);
      expect(err.message, key).toContain(err.extra.module_label);
    }
  });

  it("403s when the request has no organization", async () => {
    const next = mockNext();
    await requireModuleFeature("payroll_management")({ method: "POST" }, {}, next);
    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(403);
    expect(err.message).toBe("User has no organization");
  });

  it("resolves org from req.user.organization when scopeOrgId is absent", async () => {
    const next = mockNext();
    const req = { method: "POST", user: { organization: 7 } };
    await requireModuleFeature("payroll_management")(req, {}, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]).toBeUndefined();
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("sp.module_flags"), [7]);
  });

  it("allows when the plan includes the module", async () => {
    const next = mockNext();
    await requireModuleFeature("leave_management")(reqWith(), {}, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]).toBeUndefined();
  });

  it("403s with the distinct UPGRADE_REQUIRED code when the flag is false", async () => {
    orgRow.module_flags = JSON.stringify({
      employee_management: true,
      attendance_management: true,
      user_management: true,
      leave_management: true,
      payroll_management: false,
    });
    const next = mockNext();
    await requireModuleFeature("payroll_management")(reqWith(), {}, next);
    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(403);
    // The message names the module so the user knows WHAT to upgrade for, and
    // the code lets the frontend tell this apart from a dead subscription.
    expect(err.message).toBe("Upgrade your plan to access Payroll Management.");
    expect(err.code).toBe("UPGRADE_REQUIRED");
    expect(err.extra).toMatchObject({
      module: "payroll_management",
      module_label: "Payroll Management",
      can_retry: false,
    });
  });

  it("allows legacy plans with NULL module_flags (nothing locked out)", async () => {
    orgRow.module_flags = null;
    const next = mockNext();
    await requireModuleFeature("payroll_management")(reqWith(), {}, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]).toBeUndefined();
  });

  it("parses object-shaped flags (mysql driver may return JSON as string or object)", async () => {
    orgRow.module_flags = { ...JSON.parse(FULL_TRUES), payroll_management: false };
    const next = mockNext();
    await requireModuleFeature("payroll_management")(reqWith(), {}, next);
    expect(next.mock.calls[0][0].statusCode).toBe(403);
  });
});

describe("requireModuleFeature reuses the existing subscription lock when NO active subscription exists", () => {
  it("blocked for writes with the standard subscription message", async () => {
    orgRow = { subscription_status: "expired", module_flags: FULL_TRUES };
    const next = mockNext();
    await requireModuleFeature("payroll_management")(reqWith(), {}, next);
    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(403);
    expect(err.message).toBe(
      "Your organization does not have an active subscription. Please subscribe to use these modules."
    );
    // A dead subscription is a DIFFERENT failure from "your plan does not
    // include this module", and the client has to be able to tell them apart.
    expect(err.code).toBe("SUBSCRIPTION_INACTIVE");
    expect(err.extra).toBeUndefined();
  });

  it("stays read-only for GET like the existing lock (next through)", async () => {
    orgRow = { subscription_status: "expired", module_flags: FULL_TRUES };
    const next = mockNext();
    await requireModuleFeature("payroll_management")(reqWith({ method: "GET" }), {}, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]).toBeUndefined();
  });
});

describe("assertModuleFeature (programmatic helper)", () => {
  it("throws 403 with the subscription message when no active subscription", async () => {
    orgRow = { subscription_status: "expired", module_flags: FULL_TRUES };
    await expect(assertModuleFeature("employee_management", 7)).rejects.toThrow(
      expect.objectContaining({
        statusCode: 403,
        message: NO_ACTIVE_SUBSCRIPTION_MESSAGE,
        code: "SUBSCRIPTION_INACTIVE",
      })
    );
  });

  it("throws 403 with the distinct upgrade error when the flag is false", async () => {
    orgRow = {
      subscription_status: "active",
      module_flags: JSON.stringify({ attendance_management: false }),
    };
    await expect(assertModuleFeature("attendance_management", 7)).rejects.toThrow(
      expect.objectContaining({
        statusCode: 403,
        code: "UPGRADE_REQUIRED",
        extra: expect.objectContaining({ module: "attendance_management" }),
      })
    );
  });

  it("silently passes for legacy active plans with NULL module_flags", async () => {
    orgRow = { subscription_status: "active", module_flags: null };
    await expect(assertModuleFeature("payroll_management", 7)).resolves.toBeUndefined();
  });

  it("resolves when the plan includes the requested module", async () => {
    orgRow = { subscription_status: "active", module_flags: FULL_TRUES };
    await expect(assertModuleFeature("leave_management", 7)).resolves.toBeUndefined();
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("sp.module_flags"), [7]);
  });
});