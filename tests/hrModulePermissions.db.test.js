import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

import {
  PERMISSION_KEYS,
  TRUE_BY_DEFAULT,
  parseFeatureAccess,
  hasPermission,
} from "../src/utils/permissions.js";

/**
 * THE SERVER HALF OF THE HR-MODULE PERMISSION AUDIT.
 *
 * The frontend half is hrModulePermissions.test.ts in the client repo, which asserts
 * ROUTE_ACCESS per role and per permission. It cannot assert anything about this
 * repo — org.routes.js and permissions.js do not exist there — so the guarantee that
 * the CLIENT table matches the SERVER is enforced here instead, by reading the
 * server's own gate definitions and checking them against its own permission list.
 *
 * The failure this pins is specific and was real: six HR modules were staff-open to
 * every sub-admin regardless of feature_access, because each route's gate named a
 * ROLE and no gate named a permission. Reading a routes file that looks correct is
 * how that shipped — every line was a valid role, and the absence of a permission was
 * invisible.
 *
 * SOURCE-LEVEL ASSERTIONS, and honestly so: these read the route file as text rather
 * than mounting an Express app. What they catch is the regression — someone deleting
 * a requirePermission() from a gate, or adding a key to one gate and not another.
 * What they cannot catch is a mis-ordered middleware array, which is why the gates
 * are also checked to keep requirePermission AFTER the role gate: reversed, it would
 * deny org_admins before any role was considered.
 */

const ORG_ROUTES = readFileSync("src/routes/org.routes.js", "utf8");
const REQUIRE_ROLE = readFileSync("src/middleware/requireRole.js", "utf8");
const REQUIRE_PERMISSION_MW = readFileSync("src/middleware/requirePermission.js", "utf8");

/** The four permissions this audit added. */
const MODULE_PERMISSIONS = ["hr_letters", "manage_assets", "manage_separation", "approve_expenses"];

/** The self-service keys that predate this work. */
const SELF_SERVICE = ["attendance", "leave", "payroll"];

describe("PERMISSION_KEYS lists every delegatable permission", () => {
  it("includes all four HR-module permissions", () => {
    for (const key of MODULE_PERMISSIONS) {
      expect(PERMISSION_KEYS, `${key} missing`).toContain(key);
    }
  });

  it("keeps the six pre-existing keys, in order, so the pinned array still matches", () => {
    // The first six must be untouched. A reorder here changes nothing functionally
    // but breaks the tests that pin the array, which trains people to ignore them.
    expect(PERMISSION_KEYS.slice(0, 6)).toEqual([
      "attendance",
      "leave",
      "payroll",
      "manage_employees",
      "generate_request",
      "approve_request",
    ]);
  });

  it("has no duplicates", () => {
    expect(new Set(PERMISSION_KEYS).size).toBe(PERMISSION_KEYS.length);
  });

  it("defaults the module permissions to DENIED, and self-service to granted", () => {
    // The distinction the whole design turns on. These four hand someone the ability
    // to attest to a third party about someone's employment, spend the company's
    // money, or end a job. An admin has to choose to give them away.
    for (const key of MODULE_PERMISSIONS) {
      expect(parseFeatureAccess({})[key], `${key} defaults to granted`).toBe(false);
      expect(TRUE_BY_DEFAULT.has(key), `${key} is in TRUE_BY_DEFAULT`).toBe(false);
    }
    for (const key of SELF_SERVICE) {
      expect(parseFeatureAccess({})[key], `${key} defaults to denied`).toBe(true);
      expect(TRUE_BY_DEFAULT.has(key), `${key} missing from TRUE_BY_DEFAULT`).toBe(true);
    }
  });

  it("denies every delegated permission when feature_access is absent or malformed", () => {
    // The shape of a real pre-existing account: the column predates the permission,
    // so the key is simply not in the JSON. Falling back to granted here would hand
    // every legacy sub-admin all five modules.
    for (const raw of [null, undefined, {}, "", "not json", "[]", 42]) {
      const map = parseFeatureAccess(raw);
      for (const key of MODULE_PERMISSIONS) {
        expect(map[key], `${key} granted for ${JSON.stringify(raw)}`).toBe(false);
      }
    }
  });
});

describe("hasPermission honours an explicit grant over the default", () => {
  it("grants exactly what is granted and nothing adjacent", () => {
    const u = { org_role: "sub_admin", feature_access: { manage_separation: true } };
    expect(hasPermission(u, "manage_separation")).toBe(true);
    for (const key of MODULE_PERMISSIONS.filter((k) => k !== "manage_separation")) {
      expect(hasPermission(u, key), `${key} leaked`).toBe(false);
    }
  });

  it("an org_admin passes on the role alone, with nothing granted", () => {
    const u = { org_role: "org_admin", feature_access: {} };
    for (const key of MODULE_PERMISSIONS) {
      expect(hasPermission(u, key), `org_admin denied ${key}`).toBe(true);
    }
  });

  it("an employee is refused every delegated permission however many they hold", () => {
    // hasPermission is a PERMISSION check, not a role check, so it will grant an
    // employee holding the key. That is correct in isolation — the route's role gate
    // runs first and refuses them — and this test documents the boundary rather than
    // pretending hasPermission is a complete answer on its own.
    const u = { org_role: "employee", feature_access: { approve_expenses: true } };
    expect(hasPermission(u, "approve_expenses")).toBe(true);
    // Which is exactly why the frontend matrix tests each of these against an
    // employee and asserts denial: the permission key must not become the only gate.
  });
});

describe("each module gate in org.routes.js requires its own permission", () => {
  const GATES = [
    ["hrLettersMgmt", "hr_letters"],
    ["assetMgmt", "manage_assets"],
    ["separationMgmt", "manage_separation"],
    ["expenseCategoryMgmt", "approve_expenses"],
  ];

  /** The single-line definition of a gate, so an assertion cannot match a comment. */
  function gateLine(name) {
    const at = ORG_ROUTES.indexOf(`const ${name} = `);
    expect(at, `gate ${name} not found`).toBeGreaterThan(-1);
    return ORG_ROUTES.slice(at, ORG_ROUTES.indexOf("\n", at));
  }

  for (const [gate, key] of GATES) {
    it(`${gate} requires ${key}`, () => {
      expect(gateLine(gate)).toContain(`requirePermission("${key}")`);
    });

    it(`${gate} puts requirePermission AFTER the role and module gates`, () => {
      // Order is load-bearing. requirePermission reads req.user, which only exists
      // after requireRole has populated it, and org_admin must pass on the ROLE, so
      // a permission check placed before the role gate would deny org_admins
      // outright and lock them out of their own company.
      const line = gateLine(gate);
      expect(line.indexOf("requirePermission(")).toBeGreaterThan(-1);
      // It spreads `staff` or `orgAdminsOnly`, both of which start with requireRole.
      expect(line).toMatch(/\[\.\.\.(staff|orgAdminsOnly)/);
    });

    it(`${gate} is still scoped to staff, so the permission cannot open an employee path`, () => {
      const line = gateLine(gate);
      expect(line).toContain("requireModuleFeature(");
    });
  }

  it("orgAdminsOnly gates stay role-only and gain no permission", () => {
    // hrLettersOwner and assetCategoryMgmt deliberately keep the stricter role gate:
    // DELETING a template and redefining the classes of asset that exist are
    // structural decisions, not delegated operations. Adding a permission to them
    // would hand out the power to remove the definitions others depend on.
    expect(gateLineOf("hrLettersOwner")).not.toContain("requirePermission(");
    expect(gateLineOf("assetCategoryMgmt")).not.toContain("requirePermission(");
  });

  function gateLineOf(name) {
    const at = ORG_ROUTES.indexOf(`const ${name} = `);
    expect(at, `gate ${name} not found`).toBeGreaterThan(-1);
    return ORG_ROUTES.slice(at, ORG_ROUTES.indexOf("\n", at));
  }
});

describe("the middleware supports what it is now asked to do", () => {
  it("requirePermission is a middleware factory that reads req.user", () => {
    expect(REQUIRE_PERMISSION_MW).toMatch(/export default function requirePermission/);
    expect(REQUIRE_PERMISSION_MW).toContain("req.user");
    expect(REQUIRE_PERMISSION_MW).toContain("hasPermission");
  });

  it("it fails loudly when req.user is absent, rather than granting", () => {
    // Misordering would otherwise read as "denied for no reason" on every request.
    expect(REQUIRE_PERMISSION_MW).toMatch(/if \(!req\.user\) throw new ApiError\(401/);
  });

  it("it names the missing permission in the 403", () => {
    // A sub-admin told simply "forbidden" cannot tell whether they need the
    // permission or a different account.
    expect(REQUIRE_PERMISSION_MW).toContain("${permission}");
  });

  it("requireRole actually SELECTS feature_access", () => {
    // THE ONE THAT WOULD HAVE BROKEN IT SILENTLY.
    //
    // requireRole's query omitted feature_access while authUser's included it. So a
    // requirePermission() placed after requireRole read `undefined`, and
    // parseFeatureAccess(undefined) returns the DEFAULTS — which for the four module
    // permissions means DENIED. Every sub-admin who HAD been granted one would have
    // been refused, with no error anywhere to explain why, because a missing column
    // and an empty permission map are indistinguishable from the outside.
    expect(REQUIRE_ROLE).toMatch(/SELECT[\s\S]*?feature_access[\s\S]*?FROM users/s);
  });
});