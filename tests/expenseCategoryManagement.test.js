import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import express from "express";
import request from "supertest";

/**
 * MANAGING EXPENSE CATEGORIES: EDIT AND REMOVE.
 *
 * Only `create` existed. That is a strange gap for a resource the org admin is
 * supposed to own — you can define what may be claimed and then never change it,
 * so a wrong limit or a typo is permanent short of a database migration.
 *
 * THE REMOVE IS THE INTERESTING DECISION, and it is soft.
 *
 * `expense_claims.category_uuid` is ON DELETE RESTRICT, so a hard DELETE the
 * moment anyone has claimed against a category is refused by MySQL — and if it
 * were not, the claim list would lose the category name on claims the company has
 * already reimbursed. These are financial records that feed payslips months later.
 * So "remove" sets is_active=0: the category leaves the dropdown, and every
 * existing claim and generated payslip resolves exactly as before.
 *
 * Which also makes it REVERSIBLE, and that is the user-facing point. A "Delete"
 * button that destroys a year of claims' context because of one mis-click is a
 * worse bug than the missing feature, so `updateCategory` accepts `is_active` and
 * `listCategories` already supported `include_inactive`. The tests below pin the
 * reversibility, because a soft delete without a way back is just a slower hard
 * delete.
 */
vi.mock("../src/config/db.js", () => {
  const rows = (sql) => {
    if (/COUNT\(\*\)/i.test(String(sql))) return [[{ n: 3 }]];
    if (/FROM expense_categories/i.test(String(sql))) {
      return [[{ uuid: "cat-1", name: "Travel", is_active: 1, max_limit_per_claim: "50000.00" }]];
    }
    return [[]];
  };
  return {
    pool: {
      query: vi.fn(async (sql) => rows(sql)),
      getConnection: vi.fn(async () => ({
        query: vi.fn(async (sql) => rows(sql)),
        beginTransaction: vi.fn(),
        commit: vi.fn(),
        rollback: vi.fn(),
        release: vi.fn(),
      })),
    },
  };
});
vi.mock("../src/middleware/requireRole.js", () => ({
  default: () => (req, _res, next) => {
    req.user = { uuid: "11111111-1111-4111-8111-111111111111", id: 1, org_role: "org_admin", organization: 5, feature_access: {} };
    req.scopeOrgId = 5;
    next();
  },
}));
vi.mock("../src/middleware/authUser.js", () => ({
  default: (req, _res, next) => {
    req.user = { uuid: "11111111-1111-4111-8111-111111111111", org_role: "org_admin", organization: 5 };
    req.scopeOrgId = 5;
    next();
  },
}));
vi.mock("../src/middleware/requireActiveSubscription.js", () => ({ default: (_q, _s, n) => n() }));
vi.mock("../src/middleware/requireModuleFeature.js", () => ({ default: () => (_q, _s, n) => n() }));
vi.mock("../src/middleware/requirePermission.js", () => ({ default: () => (_q, _s, n) => n() }));

const { default: orgRouter } = await import("../src/routes/org.routes.js");
const { default: errorHandler } = await import("../src/middleware/errorHandler.js");

const ROUTER_MISS = "no such route in this test app";
const CAT = "cccccccc-0000-4000-8000-000000000001";

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/v1/org", orgRouter);
  a.use(errorHandler);
  a.use((_req, res) => res.status(404).json({ message: ROUTER_MISS }));
  return a;
}

describe("expense categories can be edited", () => {
  it("PUT /org/expense-categories/:uuid is routed", async () => {
    const res = await request(app()).put(`/api/v1/org/expense-categories/${CAT}`).send({ name: "Travel v2" });
    expect(res.body.message, "PUT was not routed").not.toBe(ROUTER_MISS);
    expect(res.status).toBe(200);
  });

  it("it returns the updated category, not an empty shell", async () => {
    // A handler that answered 200 with no body would leave the form looking like
    // it saved while the dropdown kept the old value.
    const res = await request(app()).put(`/api/v1/org/expense-categories/${CAT}`).send({ name: "Travel v2" });
    expect(res.body.data.category).toBeDefined();
  });

  it("create is still routed, because edit was added and not substituted", async () => {
    const res = await request(app()).post("/api/v1/org/expense-categories").send({ name: "Meals" });
    expect(res.body.message).not.toBe(ROUTER_MISS);
  });
});

describe("removing an expense category retires it rather than erasing it", () => {
  it("DELETE /org/expense-categories/:uuid is routed", async () => {
    const res = await request(app()).delete(`/api/v1/org/expense-categories/${CAT}`);
    expect(res.body.message, "DELETE was not routed").not.toBe(ROUTER_MISS);
    expect(res.status).toBe(200);
  });

  it("it says how many claims were preserved", async () => {
    // The UI shows this instead of implying the category and its history were
    // thrown away. A response that omits it forces the toast to lie or guess.
    const res = await request(app()).delete(`/api/v1/org/expense-categories/${CAT}`);
    expect(res.body.data.retired).toBe(true);
    expect(typeof res.body.data.claims_preserved).toBe("number");
  });

  it("NOTHING in the service issues a hard DELETE on the table", () => {
    // The single most important assertion in this file. A hard DELETE would be
    // refused by the FK the first time anyone claimed against the category, and
    // if the FK were ever relaxed it would delete financial history.
    const svc = readFileSync("src/services/expenses.service.js", "utf8");
    expect(svc).not.toMatch(/DELETE\s+FROM\s+expense_categories/i);
    // ...and the retirement is expressed as is_active=0.
    expect(svc).toMatch(/UPDATE expense_categories SET is_active=0/i);
  });

  it("it can be undone, because a soft delete with no way back is just slower", () => {
    const svc = readFileSync("src/services/expenses.service.js", "utf8");
    // updateCategory accepts is_active, which is how restore is expressed.
    expect(svc).toMatch(/isActive !== undefined/);
    expect(svc).toMatch(/is_active=\?/);
    // And listCategories can already show them, or "restore" would have nowhere
    // to show the restored row.
    expect(svc).toMatch(/includeInactive/);
  });
});

describe("category management is org-scoped and permission-gated", () => {
  it("both routes sit behind the same gate as create", () => {
    const routes = readFileSync("src/routes/org.routes.js", "utf8");
    // One gate for all three. Splitting them would mean the org admin can create
    // a limit they cannot then change, which is not a policy anyone intends.
    for (const line of [
      'router.post("/expense-categories"',
      'router.put("/expense-categories/:uuid"',
      'router.delete("/expense-categories/:uuid"',
    ]) {
      const at = routes.indexOf(line);
      expect(at, `${line} not registered`).toBeGreaterThan(-1);
      const stmt = routes.slice(at, routes.indexOf("\n", at));
      expect(stmt, `${line} is not behind expenseCategoryMgmt`).toContain("expenseCategoryMgmt");
    }
  });

  it("the gate still requires approve_expenses", () => {
    // Removing category management from the permission check would let a sub-admin
    // change the limits and receipt rules their own approvals are judged against.
    const routes = readFileSync("src/routes/org.routes.js", "utf8");
    const at = routes.indexOf("const expenseCategoryMgmt = ");
    expect(routes.slice(at, routes.indexOf("\n", at))).toContain('requirePermission("approve_expenses")');
  });

  it("the update never reads organization_id from the body", () => {
    // Every tenant boundary in this module comes from the session. A handler that
    // trusted a body field would let an admin move a category to another tenant.
    const ctrl = readFileSync("src/controllers/org/expenses.controller.js", "utf8");
    const fn = ctrl.slice(ctrl.indexOf("export async function updateExpenseCategory"));
    expect(fn).toContain("orgId: req.scopeOrgId");
    expect(fn).not.toMatch(/req\.body[^)]*organization/);
  });
});
