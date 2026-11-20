import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../src/middleware/authUser.js", () => ({
  default: (req, _res, next) => {
    req.user = {
      uuid: "11111111-1111-4111-8111-111111111111",
      organization: 5,
      org_role: req.headers["x-org-role"] || "employee",
      feature_access: JSON.parse(req.headers["x-feature-access"] || "{}"),
    };
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
vi.mock("../src/controllers/org/expenses.controller.js", () => ({
  myExpenseClaims: (_req, res) => res.status(200).json({ items: [] }),
  submitMyExpenseClaim: (req, res) => res.status(201).json({ status: req.user.org_role }),
  myExpenseClaimDetail: (_req, res) => res.status(200).json({}),
  uploadMyExpenseReceipts: (_req, res) => res.status(200).json({}),
  removeMyExpenseReceipt: (_req, res) => res.status(200).json({}),
  downloadMyExpenseReceipt: (_req, res) => res.status(200).json({}),
}));

const { default: myExpensesRouter } = await import("../src/routes/myExpenses.routes.js");
const { default: errorHandler } = await import("../src/middleware/errorHandler.js");

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use("/api/v1/my/expenses", myExpensesRouter);
  instance.use(errorHandler);
  return instance;
}

describe("self-service expense creation authorization", () => {
  it("allows employees to file their own claim", async () => {
    const response = await request(app()).post("/api/v1/my/expenses").send({});
    expect(response.status).toBe(201);
  });

  it("allows a Sub Admin with Create Expense only", async () => {
    const response = await request(app())
      .post("/api/v1/my/expenses")
      .set("x-org-role", "sub_admin")
      .set("x-feature-access", JSON.stringify({ create_expenses: true }))
      .send({});
    expect(response.status).toBe(201);
  });

  it("allows a Sub Admin with the granular Create Own Expense grant", async () => {
    const response = await request(app())
      .post("/api/v1/my/expenses")
      .set("x-org-role", "sub_admin")
      .set("x-feature-access", JSON.stringify({
        granular_permissions: { "expenses.create_own": true },
      }))
      .send({});
    expect(response.status).toBe(201);
  });

  it("does not treat Approve Employee Expenses as Create Expense", async () => {
    const response = await request(app())
      .post("/api/v1/my/expenses")
      .set("x-org-role", "sub_admin")
      .set("x-feature-access", JSON.stringify({ approve_expenses: true }))
      .send({});
    expect(response.status).toBe(403);
  });

  it("denies a Sub Admin with neither permission", async () => {
    const response = await request(app()).post("/api/v1/my/expenses").set("x-org-role", "sub_admin").send({});
    expect(response.status).toBe(403);
  });

  it("allows both independent permissions without relying on client flags", async () => {
    const response = await request(app())
      .post("/api/v1/my/expenses")
      .set("x-org-role", "sub_admin")
      .set("x-feature-access", JSON.stringify({ create_expenses: true, approve_expenses: true }))
      .send({ auto_approve: false });
    expect(response.status).toBe(201);
  });
});
