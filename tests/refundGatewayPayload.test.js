import { describe, it, expect, vi, beforeEach } from "vitest";

// Regression: DELETE /org/subscription/pending-plan returned a bare 502.
//
// The root cause sat in refundSafepayPayment: it sent only `metadata`, and the
// refund endpoint validates its payload SERVER-SIDE, answering
// "could not prepare payload for action 'REFUND': amount: cannot be blank;
// currency: cannot be blank". That rejection is indistinguishable from a gateway
// outage at the edge, so the request looked like an infrastructure failure.
//
// The SDK is stubbed here so the arguments actually forwarded to Safepay can be
// inspected without calling the gateway. The real refundSafepayPayment runs
// unmodified.

const sdkOrderCancelRefund = vi.fn();
vi.mock("@sfpy/node-core", () => ({
  default: class {
    constructor() {
      this.order = { cancel: { refund: sdkOrderCancelRefund } };
    }
  },
}));

import { refundSafepayPayment } from "../src/services/safepay.service.js";
import errorHandler from "../src/middleware/errorHandler.js";

const forwarded = () => sdkOrderCancelRefund.mock.calls[0];

function mockRes() {
  const r = {};
  r.status = vi.fn().mockReturnValue(r);
  r.json = vi.fn().mockReturnValue(r);
  return r;
}

describe("refundSafepayPayment — the payload the gateway actually requires", () => {
  beforeEach(() => {
    sdkOrderCancelRefund.mockReset();
    sdkOrderCancelRefund.mockResolvedValue({ data: { state: "TRACKER_REFUNDED" } });
    process.env.PAYMENT_GATEWAY_SECRET_KEY = "x".repeat(64);
  });

  it("sends amount and currency, which are mandatory", async () => {
    await refundSafepayPayment("track_abc", { amount: 3000000, currency: "PKR" });

    const [, params] = forwarded();
    expect(params).toBeDefined();
    // The original failure: both of these were blank and the gateway refused.
    expect(params.amount).toBe(3000000);
    expect(params.currency).toBe("PKR");
  });

  it("treats the amount as the MINOR unit, never rupees", async () => {
    // A PKR 30,000 charge is 3,000,000 paisa. Passing 30000 would have requested
    // a refund one hundred times too small — a silent, expensive mistake.
    await refundSafepayPayment("track_abc", { amount: 3000000, currency: "PKR" });
    expect(forwarded()[1].amount).toBe(3_000_000);
  });

  it("rounds a fractional paisa amount to an integer", async () => {
    await refundSafepayPayment("track_abc", { amount: 3000000.4, currency: "PKR" });
    expect(forwarded()[1].amount).toBe(3000000);
  });

  it("normalises the currency to upper case", async () => {
    await refundSafepayPayment("track_abc", { amount: 100, currency: "pkr" });
    expect(forwarded()[1].currency).toBe("PKR");
  });

  it("forwards the reconciliation metadata", async () => {
    await refundSafepayPayment("track_abc", {
      amount: 100,
      currency: "PKR",
      metadata: { checkout_uuid: "co-1", reason: "scheduled_change_cancelled" },
    });
    expect(forwarded()[1].metadata).toMatchObject({ checkout_uuid: "co-1" });
  });

  it("rejects a missing tracker before touching the gateway", async () => {
    await expect(refundSafepayPayment("", { amount: 100, currency: "PKR" })).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(sdkOrderCancelRefund).not.toHaveBeenCalled();
  });

  it("rejects a non-positive amount before touching the gateway", async () => {
    // Caught locally so a bad figure is an obvious 400 rather than a gateway 502.
    for (const amount of [0, -100, undefined, NaN]) {
      await expect(
        refundSafepayPayment("track_abc", { amount, currency: "PKR" })
      ).rejects.toMatchObject({ statusCode: 400 });
    }
    expect(sdkOrderCancelRefund).not.toHaveBeenCalled();
  });

  it("rejects a blank currency before touching the gateway", async () => {
    await expect(
      refundSafepayPayment("track_abc", { amount: 100, currency: "  " })
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(sdkOrderCancelRefund).not.toHaveBeenCalled();
  });

  it("wraps a gateway rejection as a 502 that names the gateway's own reason", async () => {
    sdkOrderCancelRefund.mockRejectedValue(
      new Error("could not prepare payload for action 'REFUND': amount: cannot be blank")
    );
    await expect(
      refundSafepayPayment("track_abc", { amount: 100, currency: "PKR" })
    ).rejects.toMatchObject({
      statusCode: 502,
      message: expect.stringContaining("could not prepare payload"),
    });
  });
});

describe("errorHandler — a 5xx may carry an explicitly safe publicMessage", () => {
  it("surfaces publicMessage instead of the generic body when the thrower set one", () => {
    const err = Object.assign(new Error("Safepay refund failed: upstream 500 at /payments/v3"), {
      statusCode: 502,
      // Deliberately written by the thrower as safe for a customer.
      publicMessage: "We could not complete your refund, so nothing has changed.",
    });
    const res = mockRes();
    errorHandler(err, { method: "DELETE", originalUrl: "/api/v1/org/subscription/pending-plan" }, res, () => {});

    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json.mock.calls[0][0].message).toBe(
      "We could not complete your refund, so nothing has changed."
    );
  });

  it("still refuses to leak the internal message into the body", () => {
    const res = mockRes();
    errorHandler(
      Object.assign(new Error("ER_LOCK_DEADLOCK on organizations"), { statusCode: 500 }),
      { method: "DELETE", originalUrl: "/x" },
      res,
      () => {}
    );

    const body = res.json.mock.calls[0][0];
    expect(body.message).toBe("Internal Server Error");
    expect(JSON.stringify(body)).not.toContain("ER_LOCK_DEADLOCK");
  });

  it("ignores a non-string publicMessage rather than emitting it", () => {
    const res = mockRes();
    errorHandler(
      Object.assign(new Error("boom"), { statusCode: 500, publicMessage: { leak: "stack" } }),
      { method: "DELETE", originalUrl: "/x" },
      res,
      () => {}
    );
    expect(res.json.mock.calls[0][0].message).toBe("Internal Server Error");
  });

  it("leaves 4xx handling untouched", () => {
    const res = mockRes();
    errorHandler(
      Object.assign(new Error("There is no scheduled subscription change to cancel."), { statusCode: 400 }),
      { method: "DELETE", originalUrl: "/x" },
      res,
      () => {}
    );
    expect(res.json.mock.calls[0][0].message).toContain("no scheduled subscription change");
  });
});
