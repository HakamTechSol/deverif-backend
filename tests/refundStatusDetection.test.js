import { describe, it, expect, vi, beforeEach } from "vitest";

// The refund-reference extraction and settlement detection that decide whether a
// customer is told their money came back.
//
// Both shapes are taken from the gateway's real payloads: the refund CALL's
// response nests the reference under action.<intent>_refund, while the REPORTER
// exposes it at attempts[*].refund.token and charge.cybersource_refunds. Hard
// coding either one loses the reference depending on which endpoint answered.

const fetchMock = vi.fn();
vi.mock("@sfpy/node-core", () => ({
  default: class {
    constructor() {
      this.reporter = { payments: { fetch: (t) => fetchMock(t) } };
      this.order = { cancel: { refund: vi.fn() } };
    }
  },
}));

import { getSafepayRefundStatus } from "../src/services/safepay.service.js";

/** Shape the reporter returns for a tracker that WAS refunded. */
const REFUNDED_REPORT = {
  state: "TRACKER_REFUNDED",
  events: [{ type: "ENROLLMENT" }, { type: "CAPTURE" }, { type: "REFUND" }],
  attempts: [
    { capture: { token: "cap_1", totals: { currency: "PKR", amount: 3000000 } } },
    { refund: { token: "refund_from_reporter", attempt: "attemp_1", totals: { amount: 3000000 } } },
  ],
  charge: { cybersource_refunds: [{ token: "refund_from_reporter" }] },
};

/** Shape for a tracker that was captured but never refunded. */
const UNREFUNDED_REPORT = {
  state: "TRACKER_ENDED",
  events: [{ type: "ENROLLMENT" }, { type: "CAPTURE" }],
  attempts: [{ capture: { token: "cap_2", totals: { amount: 1000000 } } }],
  charge: { capture: { token: "cap_2" } },
};

beforeEach(() => {
  fetchMock.mockReset();
  process.env.PAYMENT_GATEWAY_SECRET_KEY = "x".repeat(64);
});

describe("getSafepayRefundStatus — reads the gateway's own record", () => {
  it("reports settled and surfaces the refund reference for a refunded tracker", async () => {
    fetchMock.mockResolvedValue({ data: REFUNDED_REPORT });

    const result = await getSafepayRefundStatus("track_x");

    expect(result.settled).toBe(true);
    expect(result.state).toBe("TRACKER_REFUNDED");
    expect(result.refundReference).toBe("refund_from_reporter");
    expect(result.hasRefundEvent).toBe(true);
  });

  it("reports NOT settled for a captured-but-never-refunded tracker", async () => {
    // The critical discrimination. If this ever returned true, a customer would be
    // told they had been refunded for a charge that was never reversed.
    fetchMock.mockResolvedValue({ data: UNREFUNDED_REPORT });

    const result = await getSafepayRefundStatus("track_y");

    expect(result.settled).toBe(false);
    expect(result.state).toBe("TRACKER_ENDED");
    expect(result.refundReference).toBeNull();
    expect(result.hasRefundEvent).toBe(false);
  });

  it("falls back to charge.cybersource_refunds when attempts carry no refund", async () => {
    fetchMock.mockResolvedValue({
      data: { ...REFUNDED_REPORT, attempts: [{ capture: { token: "cap_1" } }] },
    });

    const result = await getSafepayRefundStatus("track_z");
    expect(result.refundReference).toBe("refund_from_reporter");
  });

  it("treats a REFUND event alone as settled, without a reference", async () => {
    // A settled refund must never be downgraded to "pending" just because the
    // reference has not been indexed yet.
    fetchMock.mockResolvedValue({
      data: { state: "TRACKER_ENDED", events: [{ type: "REFUND" }], attempts: [] },
    });

    const result = await getSafepayRefundStatus("track_w");
    expect(result.settled).toBe(true);
    expect(result.refundReference).toBeNull();
  });

  it("throws 502 when the reporter cannot be reached, rather than reporting not-refunded", async () => {
    // Returning {settled:false} on a lookup failure would be a lie: it reads as a
    // confirmed "no refund" and could be taken as permission to refund again.
    fetchMock.mockRejectedValue(new Error("network down"));

    await expect(getSafepayRefundStatus("track_v")).rejects.toMatchObject({ statusCode: 502 });
  });

  it("rejects a missing tracker", async () => {
    await expect(getSafepayRefundStatus("")).rejects.toMatchObject({ statusCode: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("survives a payload with no events/attempts arrays", async () => {
    fetchMock.mockResolvedValue({ data: { state: "TRACKER_ENDED" } });

    const result = await getSafepayRefundStatus("track_u");
    expect(result.settled).toBe(false);
    expect(result.refundReference).toBeNull();
  });
});
