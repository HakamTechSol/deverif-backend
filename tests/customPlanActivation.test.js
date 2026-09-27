import { describe, it, expect, vi, beforeEach } from "vitest";

// An approved custom-plan request must be PAYABLE.
//
// The gap this closes: approving a request records the negotiated terms and opens
// a pending checkout, but nothing in the app could act on it. The only way to
// open a checkout was POST /org/subscription/checkout, which hard-filters
// `is_custom=0 AND is_public=1` — and a custom plan is deliberately never public,
// because its price was negotiated. So approval could be recorded but never
// completed, and the org admin had no button to press.
//
// The invariants guarded here are the ones that keep this path from becoming a
// way to obtain a paid plan for free, or to pay for someone else's plan.

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
  return {
    poolQuery,
    connQuery,
    connection,
    getConnection: vi.fn(),
    session: vi.fn(),
    passport: vi.fn(),
    checkoutUrl: vi.fn(),
  };
});

vi.mock("../src/config/db.js", () => ({
  pool: { query: h.poolQuery, getConnection: h.getConnection },
}));
vi.mock("../src/services/safepay.service.js", () => ({
  createSafepayPaymentSession: (arg) => h.session(arg),
  createSafepayAuthToken: () => h.passport(),
  buildSafepayCheckoutUrl: (arg) => h.checkoutUrl(arg),
  getSafepayPaymentStatus: vi.fn(),
  refundSafepayPayment: vi.fn(),
}));

import { createCustomPlanCheckout } from "../src/controllers/orgSubscription.controller.js";

const REQ_UUID = "cccccccc-dddd-4eee-8fff-000000000001";
const PLAN_UUID = "aaaaaaaa-bbbb-4ccc-8ddd-000000000002";
const ORG_ID = 7;

const PLAN = {
  id: 55,
  uuid: PLAN_UUID,
  name: "Custom Plan — Acme",
  monthly_price: "25000.00",
  is_custom: 1,
  is_public: 0,
  is_free: 0,
};

function setupHappyPath(requestRow = {}, planRow = PLAN) {
  h.poolQuery.mockImplementation(async (sql) => {
    const stmt = String(sql);
    if (stmt.includes("FROM custom_plan_requests")) {
      return [[{
        id: 3,
        uuid: REQ_UUID,
        status: "approved",
        approved_plan_id: 55,
        approved_daily_quota: 50,
        approved_price: "25000.00",
        ...requestRow,
      }]];
    }
    if (stmt.includes("FROM subscription_plans")) return [[planRow]];
    if (stmt.includes("FROM organizations WHERE id=")) {
      return [[{
        id: ORG_ID,
        subscription_status: "active",
        subscription_expiry: "2026-12-01 00:00:00",
        subscription_plan_id: 2,
      }]];
    }
    if (stmt.includes("FROM subscription_plans WHERE id=? AND is_custom=1")) return [[planRow]];
    return [[]];
  });

  h.connQuery.mockImplementation(async (sql) => {
    const stmt = String(sql);
    if (/^\s*SELECT/i.test(stmt)) {
      if (stmt.includes("FROM organizations WHERE id=? FOR UPDATE")) {
        return [[{
          id: ORG_ID,
          subscription_status: "active",
          subscription_expiry: "2026-12-01 00:00:00",
          subscription_plan_id: 2,
        }]];
      }
      if (stmt.includes("FROM subscription_plans WHERE id=?")) {
        return [[{ id: 2, is_free: 0, monthly_price: "10000.00" }]];
      }
      if (stmt.includes("FROM subscription_checkouts WHERE id=?")) {
        return [[{ id: 90, uuid: "checkout-uuid", amount: "25000.00", currency: "PKR", status: "pending" }]];
      }
      return [[]];
    }
    if (/^\s*INSERT/i.test(stmt)) return [{ insertId: 90, affectedRows: 1 }];
    return [{ affectedRows: 1 }];
  });

  h.connection.beginTransaction.mockResolvedValue(undefined);
  h.connection.commit.mockResolvedValue(undefined);
  h.connection.rollback.mockResolvedValue(undefined);
  h.connection.release.mockImplementation(() => {});
  h.getConnection.mockResolvedValue(h.connection);
  h.session.mockResolvedValue({ token: "trk_custom_pay" });
  h.passport.mockResolvedValue("TBT");
  h.checkoutUrl.mockReturnValue("https://sandbox.example/checkout");
}

function req() {
  return {
    body: { custom_plan_request_uuid: REQ_UUID },
    user: { organization: ORG_ID, uuid: "user-uuid", org_role: "org_admin" },
  };
}
function res() {
  const r = {};
  r.status = vi.fn().mockReturnValue(r);
  r.json = vi.fn().mockReturnValue(r);
  return r;
}

const connSqls = () => h.connQuery.mock.calls.map(([sql]) => String(sql).replace(/\s+/g, " ").trim());

beforeEach(() => {
  vi.clearAllMocks();
  h.getConnection.mockReset();
  setupHappyPath();
});

describe("paying for an approved custom plan", () => {
  it("opens a checkout and returns a redirect to the gateway", async () => {
    const r = res();
    await createCustomPlanCheckout(req(), r);

    const payload = r.json.mock.calls[0][0];
    const data = payload?.data ?? payload;
    expect(data.redirect_url).toBe("https://sandbox.example/checkout");
    expect(data.checkout.uuid).toBe("checkout-uuid");
    expect(data.checkout.amount).toBe(25000);
  });

  it("charges the APPROVED price, not any client-supplied amount", async () => {
    // No amount is taken from the body at all: the price is read off the plan the
    // approval created. A client that could name its own amount could buy a
    // 2000/day plan for Rs 1.
    const r = res();
    await createCustomPlanCheckout(
      { ...req(), body: { custom_plan_request_uuid: REQ_UUID, amount: 1, price: 1 } },
      r
    );

    const insert = h.connQuery.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO subscription_checkouts")
    );
    expect(insert).toBeDefined();
    expect(insert[1][4]).toBe(25000);
  });

  it("records the approval it is paying for in the checkout metadata", async () => {
    await createCustomPlanCheckout(req(), res());

    const insert = h.connQuery.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO subscription_checkouts")
    );
    const metadata = JSON.parse(insert[1][5]);
    expect(metadata.custom_plan_request_uuid).toBe(REQ_UUID);
    expect(metadata.purchase_source).toBe("custom_plan_request");
  });

  it("does NOT activate the plan itself", async () => {
    await createCustomPlanCheckout(req(), res());

    // Same contract as approving: a checkout is not a grant. The plan is
    // activated by the webhook after the money clears, through the ordinary
    // upgrade/schedule comparison.
    for (const sql of connSqls()) {
      if (/UPDATE\s+organizations/i.test(sql)) {
        expect(sql).not.toMatch(/subscription_plan_id\s*=/);
        expect(sql).not.toMatch(/subscription_status\s*=/);
        expect(sql).not.toMatch(/pending_plan_id\s*=/);
      }
    }
    expect(connSqls().some((s) => /FROM organizations WHERE id=\? FOR UPDATE/.test(s))).toBe(true);
    // Only the checkout row is written.
    expect(connSqls().some((s) => /UPDATE\s+organizations\s+SET\s+subscription_start/i.test(s))).toBe(false);
  });
});

describe("paying for a custom plan is refused when it should be", () => {
  it("404s for a request belonging to another organization", async () => {
    // The lookup is scoped by organization_id, so another org's request is simply
    // absent — not a 403 that would confirm the uuid exists.
    h.poolQuery.mockImplementation(async (sql) => {
      if (String(sql).includes("FROM custom_plan_requests")) return [[]];
      return [[]];
    });
    await expect(createCustomPlanCheckout(req(), res())).rejects.toMatchObject({ statusCode: 404 });
  });

  it("409s on a request that is not approved yet", async () => {
    setupHappyPath({ status: "pending" });
    await expect(createCustomPlanCheckout(req(), res())).rejects.toMatchObject({ statusCode: 409 });
  });

  it("409s on a denied request", async () => {
    setupHappyPath({ status: "denied" });
    await expect(createCustomPlanCheckout(req(), res())).rejects.toMatchObject({ statusCode: 409 });
  });

  it("409s when the approval has no plan linked", async () => {
    // An approval whose plan could not be resolved has nothing to charge for.
    // Guessing a plan here would be the worst outcome: it could attach a payment
    // to an arbitrary plan.
    setupHappyPath({ approved_plan_id: null });
    await expect(createCustomPlanCheckout(req(), res())).rejects.toMatchObject({ statusCode: 409 });
    expect(h.connQuery.mock.calls.length).toBe(0);
  });

  it("409s when the linked plan is no longer a custom plan", async () => {
    setupHappyPath({}, null);
    await expect(createCustomPlanCheckout(req(), res())).rejects.toMatchObject({ statusCode: 409 });
  });

  it("400s without a request uuid", async () => {
    await expect(
      createCustomPlanCheckout({ ...req(), body: {} }, res())
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("400s for a malformed request uuid", async () => {
    await expect(
      createCustomPlanCheckout({ ...req(), body: { custom_plan_request_uuid: "not-a-uuid" } }, res())
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
