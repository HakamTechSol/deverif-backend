import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/config/db.js", () => ({ pool: { query: vi.fn(), getConnection: vi.fn() } }));

import { pool } from "../src/config/db.js";
import requireModuleFeature from "../src/middleware/requireModuleFeature.js";
import requireActiveSubscription from "../src/middleware/requireActiveSubscription.js";
import errorHandler from "../src/middleware/errorHandler.js";
import { parseModuleFlags, isModuleIncluded } from "../src/utils/moduleFlags.js";
import { ALL_MODULE_KEYS } from "./helpers/moduleKeyFixtures.js";

/**
 * The real shape of the seeded Free plan: Employee Management is the ONLY module
 * included. This is the data a brand-new organization lands on by default, and
 * it is the exact scenario that was reported as broken -- a Free org saw
 * Employee Management locked too.
 *
 * Only `employee_management` is listed. Every other key is deliberately ABSENT
 * rather than explicitly `false`, because that is how the Free plan is really
 * seeded: `isModuleIncluded` reads an absent key as blocked either way, and a
 * test that wrote them out as `false` would no longer catch a regression that
 * changed the absent-vs-false distinction.
 */
const FREE_PLAN_FLAGS = JSON.stringify({ employee_management: true });

let orgRow;

function mockNext() {
  return vi.fn();
}

/** Serve both the module-feature lookup and the blanket subscription lookup. */
function installPoolQuery() {
  pool.query = vi.fn(async (sql) => {
    const s = String(sql);
    if (s.includes("sp.module_flags")) {
      return [[{ subscription_status: orgRow.subscription_status, module_flags: orgRow.module_flags }]];
    }
    // requireActiveSubscription's own live SELECT (org + joined plan)
    if (s.includes("sp.is_free")) {
      return [
        [
          {
            subscription_status: orgRow.subscription_status,
            subscription_expiry: orgRow.subscription_expiry ?? null,
            subscription_plan_id: orgRow.subscription_plan_id ?? null,
            is_free: orgRow.is_free ?? 1,
          },
        ],
      ];
    }
    return [[]];
  });
}

const req = { method: "POST", scopeOrgId: 7 };

beforeEach(() => {
  vi.clearAllMocks();
  orgRow = {
    subscription_status: "active",
    subscription_expiry: null,
    subscription_plan_id: 1,
    is_free: 1,
    module_flags: FREE_PLAN_FLAGS,
  };
  installPoolQuery();
});

describe("a Free-plan organization is NOT blanket-locked", () => {
  it("passes requireActiveSubscription (Free counts as a valid subscription)", async () => {
    const next = mockNext();
    await requireActiveSubscription(req, {}, next);
    expect(next).toHaveBeenCalledTimes(1);
    // next() with no argument == allowed through.
    expect(next.mock.calls[0][0]).toBeUndefined();
  });

  it.each(ALL_MODULE_KEYS)("is not locked out of %s by the blanket gate", async (key) => {
    // Guards against the regression where the blanket middleware was the only
    // thing being consulted and every module appeared locked.
    const flags = parseModuleFlags(orgRow.module_flags);
    const next = mockNext();
    await requireModuleFeature(key)(req, {}, next);
    if (isModuleIncluded(flags, key)) {
      expect(next.mock.calls[0][0]).toBeUndefined();
    } else {
      expect(next.mock.calls[0][0]?.code).toBe("UPGRADE_REQUIRED");
    }
  });
});

describe("per-module gating on a Free plan matches the pricing card", () => {
  it("allows Employee Management, which the Free card lists as included", async () => {
    const next = mockNext();
    await requireModuleFeature("employee_management")(req, {}, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]).toBeUndefined();
  });

  // Every module other than employee_management must be locked on the Free plan,
  // including the thirteen added by the HR expansion. Driven off ALL_MODULE_KEYS
  // rather than a hand-written list so a new module cannot be added without this
  // assertion covering it.
  it.each(ALL_MODULE_KEYS.filter((k) => k !== "employee_management"))(
    "returns a distinct UPGRADE_REQUIRED for %s instead of a generic 403",
    async (key) => {
      const next = mockNext();
      await requireModuleFeature(key)(req, {}, next);
      const err = next.mock.calls[0][0];

      expect(err).toBeDefined();
      expect(err.statusCode).toBe(403);
      // The distinguishing bits: a machine-readable code and which module.
      expect(err.code).toBe("UPGRADE_REQUIRED");
      expect(err.extra).toMatchObject({ module: key, can_retry: false });
      // It must NOT look like a dead subscription.
      expect(err.code).not.toBe("SUBSCRIPTION_INACTIVE");
      expect(typeof err.message).toBe("string");
      expect(err.message).toContain("Upgrade your plan");
    }
  );

  it("names the module in the human-readable message", async () => {
    const next = mockNext();
    await requireModuleFeature("payroll_management")(req, {}, next);
    expect(next.mock.calls[0][0].message).toBe("Upgrade your plan to access Payroll Management.");
  });
});

describe("a genuinely broken subscription is still blocked, with the original message", () => {
  it("blocks writes with SUBSCRIPTION_INACTIVE when the org has no plan at all", async () => {
    orgRow = {
      subscription_status: "pending_payment",
      subscription_expiry: null,
      subscription_plan_id: null,
      is_free: null,
      module_flags: null,
    };
    const next = mockNext();
    await requireActiveSubscription(req, {}, next);
    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(403);
    expect(err.message).toBe(
      "Your organization does not have an active subscription. Please subscribe to use these modules."
    );
    expect(err.code).toBe("SUBSCRIPTION_INACTIVE");
  });

  it("blocks writes when a paid plan has lapsed", async () => {
    orgRow = {
      subscription_status: "active",
      subscription_expiry: new Date(Date.now() - 86400000),
      subscription_plan_id: 3,
      is_free: 0,
      module_flags: null,
    };
    const next = mockNext();
    await requireActiveSubscription(req, {}, next);
    expect(next.mock.calls[0][0].code).toBe("SUBSCRIPTION_INACTIVE");
  });

  it("keeps reads working (GET passes through) even when broken", async () => {
    orgRow = {
      subscription_status: "pending_payment",
      subscription_expiry: null,
      subscription_plan_id: null,
      is_free: null,
      module_flags: null,
    };
    const next = mockNext();
    await requireActiveSubscription({ ...req, method: "GET" }, {}, next);
    expect(next.mock.calls[0][0]).toBeUndefined();
  });

  it("module gate reports the subscription problem, not an upgrade prompt", async () => {
    orgRow = { subscription_status: "expired", module_flags: FREE_PLAN_FLAGS };
    const next = mockNext();
    await requireModuleFeature("payroll_management")(req, {}, next);
    const err = next.mock.calls[0][0];
    // No live subscription wins over the module check, and says so distinctly.
    expect(err.code).toBe("SUBSCRIPTION_INACTIVE");
    expect(err.extra).toBeUndefined();
  });
});

describe("errorHandler surfaces the code and module to the client", () => {
  const run = (err) => {
    const res = {
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
        return this;
      },
    };
    errorHandler(err, { method: "GET", originalUrl: "/x" }, res, () => {});
    return res;
  };

  it("passes UPGRADE_REQUIRED + module through to the JSON body", () => {
    const next = mockNext();
    // Build a real error through the middleware so the shape is not invented.
    return requireModuleFeature("payroll_management")(req, {}, next).then(() => {
      const res = run(next.mock.calls[0][0]);
      expect(res.statusCode).toBe(403);
      expect(res.body).toMatchObject({
        success: false,
        code: "UPGRADE_REQUIRED",
        module: "payroll_management",
        module_label: "Payroll Management",
        can_retry: false,
      });
    });
  });

  it("passes SUBSCRIPTION_INACTIVE through without a module", async () => {
    orgRow = {
      subscription_status: "pending_payment",
      subscription_expiry: null,
      subscription_plan_id: null,
      is_free: null,
      module_flags: null,
    };
    const next = mockNext();
    await requireActiveSubscription(req, {}, next);
    const res = run(next.mock.calls[0][0]);
    expect(res.body.code).toBe("SUBSCRIPTION_INACTIVE");
    expect(res.body.module).toBeUndefined();
  });

  it("still hides internals for a 500", () => {
    const res = run(Object.assign(new Error("boom"), { statusCode: 500 }));
    expect(res.body).toEqual({ success: false, message: "Internal Server Error" });
  });
});

describe("the pricing card and the enforcement read the same flags", () => {
  it("parseModuleFlags + isModuleIncluded agree with the seeded Free plan", () => {
    const flags = parseModuleFlags(FREE_PLAN_FLAGS);
    expect(flags).not.toBeNull();
    // Exactly one module is on the Free plan.
    expect(ALL_MODULE_KEYS.filter((k) => isModuleIncluded(flags, k))).toEqual([
      "employee_management",
    ]);
  });

  it("treats a legacy plan with no flags as unrestricted (nothing locked)", () => {
    const flags = parseModuleFlags(null);
    expect(flags).toBeNull();
    for (const k of ALL_MODULE_KEYS) expect(isModuleIncluded(flags, k)).toBe(true);
  });

  it("treats an empty flags object as everything blocked, matching the middleware", () => {
    const flags = parseModuleFlags("{}");
    for (const k of ALL_MODULE_KEYS) expect(isModuleIncluded(flags, k)).toBe(false);
  });
});
