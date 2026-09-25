import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/config/db.js", () => ({
  pool: { query: vi.fn(), getConnection: vi.fn() },
}));

import { pool } from "../src/config/db.js";
import { resetDailyRequestUsage, todayStr } from "../src/utils/requestQuota.js";
import { activateOrgSubscription } from "../src/services/payment.service.js";

beforeEach(() => {
  vi.resetAllMocks();
  pool.query.mockResolvedValue([[], []]);
});

describe("resetDailyRequestUsage", () => {
  it("deletes today's bucket for the organization", async () => {
    await resetDailyRequestUsage(7);

    const call = pool.query.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("DELETE FROM daily_request_usage")
    );
    expect(call).toBeDefined();
    expect(call[1]).toEqual([7, todayStr()]);
  });

  it("uses the caller's transaction connection when one is supplied", async () => {
    const connection = { query: vi.fn().mockResolvedValue([[], []]) };
    await resetDailyRequestUsage(7, connection);

    expect(connection.query).toHaveBeenCalledTimes(1);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe("plan activation refreshes the daily allowance", () => {
  it("clears today's usage when a subscription is activated", async () => {
    const connection = { query: vi.fn().mockResolvedValue([[], []]) };
    const plan = { id: 5, billing_period: "monthly" };

    await activateOrgSubscription(connection, { organizationId: 42, plan });

    const statements = connection.query.mock.calls.map(([sql]) => sql);
    expect(statements.some((s) => typeof s === "string" && s.includes("UPDATE organizations"))).toBe(true);
    // The reset must happen as part of activation, otherwise the org keeps the
    // previous plan's already-consumed slots against the new plan's quota.
    const deleteCall = connection.query.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("DELETE FROM daily_request_usage")
    );
    expect(deleteCall).toBeDefined();
    expect(deleteCall[1]).toEqual([42, todayStr()]);
  });
});
