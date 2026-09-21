import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/config/db.js", () => ({ pool: { query: vi.fn() } }));

import requireModuleFeature, { MODULE_FEATURE_KEYS, assertModuleFeature, FEATURE_NOT_INCLUDED_MESSAGE, NO_ACTIVE_SUBSCRIPTION_MESSAGE } from "../src/middleware/requireModuleFeature.js";
import { pool } from "../src/config/db.js";

const FULL_TRUES = JSON.stringify({
  employee_management: true,
  attendance_management: true,
  user_management: true,
  leave_management: true,
  payroll_management: true,
});

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

  it("exposes the five allowed module keys", () => {
    expect(MODULE_FEATURE_KEYS).toEqual([
      "employee_management",
      "attendance_management",
      "user_management",
      "leave_management",
      "payroll_management",
    ]);
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

  it("403s with the exact upgrade message when the flag is false", async () => {
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
    expect(err.message).toBe(
      "This feature is not included in your current plan. Contact your admin to upgrade."
    );
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
      expect.objectContaining({ statusCode: 403, message: NO_ACTIVE_SUBSCRIPTION_MESSAGE })
    );
  });

  it("throws 403 with the upgrade message when the flag is false", async () => {
    orgRow = {
      subscription_status: "active",
      module_flags: JSON.stringify({ attendance_management: false }),
    };
    await expect(assertModuleFeature("attendance_management", 7)).rejects.toThrow(
      expect.objectContaining({ statusCode: 403, message: FEATURE_NOT_INCLUDED_MESSAGE })
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