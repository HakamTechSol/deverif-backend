import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  query: vi.fn(),
  getClaim: vi.fn(),
  reviewClaim: vi.fn(),
  createClaim: vi.fn(),
  approveOwnClaim: vi.fn(),
  conn: {
    beginTransaction: vi.fn(),
    commit: vi.fn(),
    rollback: vi.fn(),
    release: vi.fn(),
  },
}));

vi.mock("../src/config/db.js", () => ({
  pool: {
    query: h.query,
    getConnection: vi.fn(async () => h.conn),
  },
}));
vi.mock("../src/services/expenses.service.js", () => ({
  listClaims: vi.fn(),
  getClaim: h.getClaim,
  createClaim: h.createClaim,
  attachReceipts: vi.fn(),
  removeReceipt: vi.fn(),
  resolveReceipt: vi.fn(),
  reviewClaim: h.reviewClaim,
  markClaimPaid: vi.fn(),
  bulkMarkClaimsPaid: vi.fn(),
  approveOwnClaim: h.approveOwnClaim,
  ATTACHMENT_ENTITY: { CLAIM: "expense_claim" },
}));
vi.mock("../src/utils/auditLog.js", () => ({
  logAudit: vi.fn(),
  getActorFromReq: vi.fn(() => ({})),
}));

const {
  myExpenseClaims,
  myExpenseClaimDetail,
  reviewExpenseClaim,
  submitMyExpenseClaim,
} = await import("../src/controllers/org/expenses.controller.js");

const CLAIM = {
  uuid: "aaaaaaaa-0000-4000-8000-000000000003",
  employee_uuid: "aaaaaaaa-0000-4000-8000-000000000002",
  status: "pending",
};

function request(featureAccess = { approve_expenses: true }) {
  return {
    scopeOrgId: 7,
    params: { uuid: CLAIM.uuid },
    body: { decision: "approved" },
    user: {
      uuid: "aaaaaaaa-0000-4000-8000-000000000001",
      org_role: "sub_admin",
      feature_access: featureAccess,
    },
  };
}

describe("Sub Admin expense approval API authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.query.mockResolvedValue([[{ uuid: CLAIM.employee_uuid }]]);
    h.getClaim.mockResolvedValue(CLAIM);
    h.createClaim.mockResolvedValue({ uuid: CLAIM.uuid });
  });

  it("denies own-claim approval even when Approve Employee Expenses is granted", async () => {
    await expect(reviewExpenseClaim(request(), {})).rejects.toMatchObject({ statusCode: 403 });
    expect(h.reviewClaim).not.toHaveBeenCalled();
  });

  it("denies approval when the permission is revoked", async () => {
    await expect(reviewExpenseClaim(request({ create_expenses: true }), {})).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(h.query).not.toHaveBeenCalled();
    expect(h.reviewClaim).not.toHaveBeenCalled();
  });

  it("allows a sub-admin with the granular Create Own Expense grant to submit their own claim", async () => {
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
    const req = {
      scopeOrgId: 7,
      body: { expense_name: "Taxi", amount: 1000, expense_date: "2026-09-10" },
      user: {
        uuid: "aaaaaaaa-0000-4000-8000-000000000001",
        org_role: "sub_admin",
        feature_access: { granular_permissions: { "expenses.create_own": true } },
      },
    };

    await expect(submitMyExpenseClaim(req, res)).resolves.toBeDefined();
    expect(h.createClaim).toHaveBeenCalledWith(expect.objectContaining({
      employeeUuid: CLAIM.employee_uuid,
      expenseName: "Taxi",
    }));
    expect(h.approveOwnClaim).toHaveBeenCalled();
    expect(h.conn.commit).toHaveBeenCalled();
  });

  it("allows an unlinked sub-admin to submit a directly paid, auto-approved claim", async () => {
    h.query.mockResolvedValue([[]]);
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
    const req = {
      scopeOrgId: 7,
      body: { expense_name: "Taxi", amount: 1000, expense_date: "2026-09-10" },
      user: {
        uuid: "aaaaaaaa-0000-4000-8000-000000000001",
        full_name: "Sub-admin",
        org_role: "sub_admin",
        feature_access: { granular_permissions: { "expenses.create_own": true } },
      },
    };

    await expect(submitMyExpenseClaim(req, res)).resolves.toBeDefined();
    expect(h.createClaim).toHaveBeenCalledWith(expect.objectContaining({
      employeeUuid: null,
      employeeName: "Sub-admin",
      paymentMode: "direct",
    }));
    expect(h.approveOwnClaim).toHaveBeenCalled();
    expect(h.conn.commit).toHaveBeenCalled();
  });

  it("lists claims for an unlinked sub-admin by creator identity", async () => {
    h.query.mockResolvedValue([[]]);
    const req = {
      scopeOrgId: 7,
      query: {},
      user: { uuid: "aaaaaaaa-0000-4000-8000-000000000001", org_role: "sub_admin" },
    };
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };

    await myExpenseClaims(req, res);

    expect((await import("../src/services/expenses.service.js")).listClaims).toHaveBeenCalledWith(
      expect.objectContaining({
        employeeUuid: undefined,
        createdByUuid: req.user.uuid,
      }),
    );
  });

  it("allows an unlinked sub-admin to open only their own standalone claim", async () => {
    h.query.mockResolvedValue([[]]);
    h.getClaim.mockResolvedValue({
      ...CLAIM,
      employee_uuid: null,
      created_by: "aaaaaaaa-0000-4000-8000-000000000001",
    });
    const req = {
      scopeOrgId: 7,
      params: { uuid: CLAIM.uuid },
      user: { uuid: "aaaaaaaa-0000-4000-8000-000000000001", org_role: "sub_admin" },
    };
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };

    await expect(myExpenseClaimDetail(req, res)).resolves.toBeDefined();
    expect(res.json).toHaveBeenCalled();

    h.getClaim.mockResolvedValue({
      ...CLAIM,
      employee_uuid: null,
      created_by: "aaaaaaaa-0000-4000-8000-000000000004",
    });
    await expect(myExpenseClaimDetail(req, res)).rejects.toMatchObject({ statusCode: 404 });
  });
});
