import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import express from "express";
import request from "supertest";

/**
 * AN ORG ADMIN CANNOT FILE AN EXPENSE CLAIM. NOT FOR THEMSELVES, NOT FOR ANYONE.
 *
 * This used to be permitted: POST /org/expense-claims sat on `expenseCategoryMgmt`,
 * the same gate as the review queue. That gate ends in requirePermission
 * ("approve_expenses"), and `hasPermission` returns true for an org_admin on the
 * ROLE alone, with nothing granted. So the single account in the company that can
 * approve any reimbursement was also handed the power to originate one — file it
 * and approve it in the same sitting, against an employee of its choosing, with
 * the receipt and the 90-day backdate rules the only brakes.
 *
 * The restriction is now structural rather than conditional, and that is the point.
 * There is no `unless (isOwner)` and no `assertNotSelf`, which is what a
 * conditional rule looks like one refactor away from being wrong. The route is not
 * registered, so the request cannot reach a handler at all.
 *
 * Staff keep what the policy gives them — categories, review, settlement — because
 * adjudicating a claim someone else filed is the job. Employees file through
 * /api/v1/my/expenses, which derives the claimant from the session.
 */

/*
 * The real router, with the auth stack stubbed.
 *
 * Mounted rather than read as text on purpose. A route being ABSENT is precisely
 * the thing source-scanning is worst at proving: a comment explaining why it is
 * gone satisfies a naive grep, and a mis-ordered middleware array looks identical
 * to a correct one. Only dispatching the request shows what Express actually
 * matched. The source assertions at the bottom are kept as a cheap second opinion
 * about intent, explicitly not as the proof.
 */
/**
 * A DB stub that answers a COUNT the way the service destructures it.
 *
 * `listClaims` opens with `const [[{ total }]] = ...`, so a bare empty result is
 * not "no claims" — it is a 500, because there is no `total` to read. Answering
 * the count is what lets the list route return a real 200 rather than an error,
 * which is the difference between proving the route runs and proving it matched.
 */
function stubRows(sql) {
  if (/COUNT\(\*\)\s+AS\s+total/i.test(String(sql))) return [[{ total: 0 }]];
  return [[]];
}

vi.mock("../src/config/db.js", () => ({
  pool: {
    query: vi.fn(async (sql) => stubRows(sql)),
    getConnection: vi.fn(async () => ({
      query: vi.fn(async (sql) => stubRows(sql)),
      beginTransaction: vi.fn(),
      commit: vi.fn(),
      rollback: vi.fn(),
      release: vi.fn(),
    })),
  },
}));
vi.mock("../src/middleware/requireRole.js", () => ({
  default: () => (req, _res, next) => {
    req.user = {
      uuid: "11111111-1111-4111-8111-111111111111",
      id: 1,
      org_role: "org_admin",
      organization: 5,
      feature_access: {},
    };
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
vi.mock("../src/middleware/requireActiveSubscription.js", () => ({
  default: (_req, _res, next) => next(),
}));
vi.mock("../src/middleware/requireModuleFeature.js", () => ({
  default: () => (_req, _res, next) => next(),
}));
vi.mock("../src/middleware/requirePermission.js", () => ({
  default: () => (_req, _res, next) => next(),
}));

const { default: orgRouter } = await import("../src/routes/org.routes.js");
const { default: errorHandler } = await import("../src/middleware/errorHandler.js");
const { default: asyncHandler } = await import("../src/utils/asyncHandler.js");
const { myExpenseCategories } = await import("../src/controllers/org/expenses.controller.js");

/**
 * A message only THIS file's catch-all can produce.
 *
 * The distinction it exists to make: several expense routes legitimately answer
 * 404 from inside the HANDLER — a claim uuid that is not in the stubbed database
 * makes loadClaim throw ApiError(404, "Expense claim not found"). So "it returned
 * 404" cannot tell a removed route from a working one, and asserting on the status
 * alone would either pass vacuously or force the wrong fix. The router's miss is
 * the only response carrying this string.
 */
const ROUTER_MISS = "no such route in this test app";

/** A well-formed claim body, so a 404 cannot be explained by bad input. */
const CLAIM_BODY = {
  employee_uuid: "22222222-2222-4222-8222-222222222222",
  category_uuid: "33333333-3333-4333-8333-333333333333",
  amount: 500,
  expense_date: "2026-10-05",
  payment_mode: "payroll",
};

const CLAIM_UUID = "44444444-4444-4444-8444-444444444444";

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/v1/org", orgRouter);
  a.use(errorHandler);
  a.use((_req, res) => res.status(404).json({ message: ROUTER_MISS }));
  return a;
}

describe("an org admin cannot file an expense claim", () => {
  it("POST /org/expense-claims is not routed at all", async () => {
    const res = await request(app()).post("/api/v1/org/expense-claims").send(CLAIM_BODY);
    expect(res.status).toBe(404);
    expect(res.body.message).toBe(ROUTER_MISS);
  });

  it("the body being valid does not change the answer", async () => {
    // The same request with no employee_uuid — i.e. claiming for themselves, the
    // other half of the policy — is refused identically. A rule that only refused
    // the named-employee case would still leave the self-claim open.
    const res = await request(app())
      .post("/api/v1/org/expense-claims")
      .send({ ...CLAIM_BODY, employee_uuid: undefined });
    expect(res.status).toBe(404);
    expect(res.body.message).toBe(ROUTER_MISS);
  });

  it("neither does a trailing slash or a casing trick reach a handler", async () => {
    // Registration is matched on an exact path. These are the two shapes a client
    // or a curious employee would actually try once the obvious one 404s.
    for (const path of ["/api/v1/org/expense-claims/", "/api/v1/org/Expense-Claims"]) {
      const res = await request(app()).post(path).send(CLAIM_BODY);
      expect(res.status, `${path} reached a handler`).toBe(404);
      expect(res.body.message, `${path} reached a handler`).toBe(ROUTER_MISS);
    }
  });
});

describe("the review side of the module is untouched", () => {
  // A restriction that takes the queue down with it is not a restriction, it is an
  // outage. The status is deliberately NOT asserted here: three of these answer 404
  // from the handler because the stubbed database contains no such claim. What is
  // asserted is that Express matched a route at all — i.e. the router's miss
  // sentinel never comes back.
  const STILL_ROUTED = [
    ["get", "/api/v1/org/expense-claims"],
    ["get", `/api/v1/org/expense-claims/${CLAIM_UUID}`],
    ["post", `/api/v1/org/expense-claims/${CLAIM_UUID}/review`],
    ["post", `/api/v1/org/expense-claims/${CLAIM_UUID}/pay`],
    ["post", "/api/v1/org/expense-claims/bulk-pay"],
    ["post", `/api/v1/org/expense-claims/${CLAIM_UUID}/receipts`],
    ["get", "/api/v1/org/expense-categories"],
    ["post", "/api/v1/org/expense-categories"],
  ];

  for (const [method, path] of STILL_ROUTED) {
    it(`${method.toUpperCase()} ${path} is still routed`, async () => {
      const res = await request(app())[method](path).send({});
      expect(res.body?.message, `${method.toUpperCase()} ${path} was unregistered`).not.toBe(ROUTER_MISS);
    });
  }

  it("the list route really runs, rather than merely matching", async () => {
    // Belt and braces against the sentinel assertion being satisfied by a handler
    // that happens to echo it. The stubbed pool answers an empty page.
    const res = await request(app()).get("/api/v1/org/expense-claims");
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
  });
});

describe("the employee portal is the only way in", () => {
  it("/my/expenses is mounted, and it derives the claimant from the session", () => {
    const routes = readFileSync("src/routes/index.js", "utf8");
    const ess = readFileSync("src/routes/myExpenses.routes.js", "utf8");

    expect(routes).toContain("/my/expenses");
    // No employee_uuid anywhere in the ESS request surface: there is no field a
    // caller could change to have the company pay a colleague's taxi.
    expect(ess).not.toMatch(/req\.body[^)]*employee_uuid/);
    expect(ess).toContain('router.post("/"');
  });
});

describe("the employee portal can read the categories it must file against", () => {
  // THIS ONE WAS BROKEN AND SHIPPED. GET /org/expense-categories is gated on
  // org_admin/sub_admin plus approve_expenses, so the employee form's category
  // dropdown 403'd and rendered "No categories found. Create a new category
  // first." — false (they existed) and unactionable (the employee cannot open
  // that page). Dispatched here, not asserted as text: a 403 from a handler is
  // indistinguishable from a 403 from the router by status alone, which is
  // exactly how the original went unnoticed.
  // Stands in for GET /org/expense-categories, which is gated on
  // requireRole("org_admin","sub_admin") + requirePermission("approve_expenses").
  const staffOnly = express();
  staffOnly.get("/org/expense-categories", (_req, res) =>
    res.status(403).json({ success: false, message: "org_admin or sub_admin only" }),
  );
  staffOnly.use((_req, res) => res.status(404).json({ message: ROUTER_MISS }));

  /** The claim detail route, which is what a mis-ordered /categories falls into. */
  const claimDetail = (_req, res) => res.status(200).json({ data: { claim: "A CLAIM, not a category" } });

  function essApp(categoriesFirst = true) {
    const r = express.Router();
    r.use((req, _res, next) => {
      req.user = { uuid: "aaaaaaaa-0000-4000-8000-000000000002", organization: 1 };
      req.scopeOrgId = 1;
      next();
    });
    const categories = asyncHandler(myExpenseCategories);
    // Exactly two routes, in one of the two orders. Nothing else is registered —
    // an extra `/:uuid` left above this conditional silently won every match and
    // made both tests describe the same router.
    if (categoriesFirst) {
      r.get("/categories", categories);
      r.get("/:uuid", claimDetail);
    } else {
      r.get("/:uuid", claimDetail);
      r.get("/categories", categories);
    }
    const a = express();
    a.use(express.json());
    a.use("/api/v1/my/expenses", r);
    a.use(errorHandler);
    a.use((_req, res) => res.status(404).json({ message: ROUTER_MISS }));
    return a;
  }

  it("/my/expenses/categories is routed, and does not fall into /:uuid", async () => {
    const res = await request(essApp()).get("/api/v1/my/expenses/categories");
    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Expense categories");
    expect(res.body.data.items).toEqual([]);
  });

  it("the ORDER is the only thing that makes that true", async () => {
    // The same two routes, registered the other way round. Express matches in
    // registration order, so "/categories" is consumed as a claim uuid and the
    // employee is handed a CLAIM-shaped answer to a request about categories.
    //
    // Asserted as a 200 either way on purpose: both orders return 200, which is
    // precisely why a status-code check cannot catch this mis-ordering, and why
    // the test has to look at the payload.
    const res = await request(essApp(false)).get("/api/v1/my/expenses/categories");
    expect(res.status).toBe(200);
    expect(res.body.data.claim).toBe("A CLAIM, not a category");
    // ...and the correct order does not.
    const good = await request(essApp(true)).get("/api/v1/my/expenses/categories");
    expect(good.body.data.claim).toBeUndefined();
    expect(good.body.message).toBe("Expense categories");
  });

  it("the real route file registers /categories before /:uuid", () => {
    const src = readFileSync("src/routes/myExpenses.routes.js", "utf8");
    const categoriesAt = src.indexOf('router.get("/categories"');
    const uuidAt = src.indexOf('router.get("/:uuid"');
    expect(categoriesAt).toBeGreaterThan(-1);
    expect(uuidAt).toBeGreaterThan(-1);
    expect(categoriesAt, "/categories must be registered BEFORE /:uuid").toBeLessThan(uuidAt);
  });

  it("and it is wired to the handler, not left dangling", () => {
    const src = readFileSync("src/routes/myExpenses.routes.js", "utf8");
    expect(src).toContain("myExpenseCategories");
    expect(readFileSync("src/controllers/org/expenses.controller.js", "utf8")).toContain(
      "export async function myExpenseCategories",
    );
  });

  it("the categories a user may file under are not behind a staff-only gate", async () => {
    // The actual defect, stated as a gate check: an employee must reach the
    // category list without passing the role check the staff route requires.
    const staff = await request(staffOnly).get("/org/expense-categories");
    expect(staff.status, "precondition: staff categories are org-gated").toBe(403);
    expect(readFileSync("src/routes/myExpenses.routes.js", "utf8")).toContain(
      'router.get("/categories", selfService',
    );
  });
});

describe("the source agrees, as a second opinion rather than the proof", () => {
  const ORG_ROUTES = readFileSync("src/routes/org.routes.js", "utf8");
  const CTRL = readFileSync("src/controllers/org/expenses.controller.js", "utf8");

  /** Strip comments, so prose explaining the removal cannot satisfy an assertion. */
  const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

  it("no route registration creates a claim", () => {
    expect(code(ORG_ROUTES)).not.toMatch(/router\.post\(\s*"\/expense-claims"/);
  });

  it("submitExpenseClaim is not exported, so nothing can import it", () => {
    expect(ORG_ROUTES).not.toContain("submitExpenseClaim");
    expect(code(CTRL)).not.toMatch(/export async function submitExpenseClaim/);
  });

  it("createClaim is reachable only from the self-service handler", () => {
    // One call site, in submitMyExpenseClaim. createClaim itself is unchanged and
    // still shared — what moved is WHO MAY CALL IT, not what it does.
    const calls = [...code(CTRL).matchAll(/createClaim\(/g)];
    expect(calls.length, "createClaim has more than one call site").toBe(1);
  });

  it("categories and review are still here, because those are the org admin's job", () => {
    expect(code(ORG_ROUTES)).toMatch(/router\.post\(\s*"\/expense-categories"/);
    expect(code(ORG_ROUTES)).toMatch(/router\.post\(\s*"\/expense-claims\/:uuid\/review"/);
  });
});
