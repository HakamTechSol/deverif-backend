import Safepay from "@sfpy/node-core";
import ApiError from "../utils/ApiError.js";

let client = null;

export function getSafepayConfig() {
  const mode = process.env.PAYMENT_GATEWAY_MODE || "test";
  return {
    provider: "safepay",
    mode,
    merchantApiKey: process.env.PAYMENT_GATEWAY_PUBLIC_KEY || "",
    webhookSecret: process.env.PAYMENT_GATEWAY_WEBHOOK_SECRET || "",
    host: mode === "live" ? "https://api.getsafepay.com" : "https://sandbox.api.getsafepay.com",
  };
}

function getClient() {
  const secretKey = process.env.PAYMENT_GATEWAY_SECRET_KEY;
  if (!secretKey) {
    throw new ApiError(500, "Safepay is not configured (missing PAYMENT_GATEWAY_SECRET_KEY)");
  }
  if (!client) {
    const { host } = getSafepayConfig();
    client = new Safepay(secretKey, { authType: "secret", host, timeout: 80000 });
  }
  return client;
}

function unwrap(response) {
  if (response && typeof response === "object" && "data" in response) {
    return response.data;
  }
  return response;
}

export async function createSafepayPaymentSession({ amount, currency = "PKR", metadata = {} }) {
  const { merchantApiKey } = getSafepayConfig();
  if (!merchantApiKey) {
    throw new ApiError(500, "Safepay is not configured (missing PAYMENT_GATEWAY_PUBLIC_KEY)");
  }
  let response;
  try {
    response = await getClient().payments.session.setup({
      merchant_api_key: merchantApiKey,
      intent: "CYBERSOURCE",
      mode: "payment",
      entry_mode: "raw",
      currency,
      amount,
      metadata,
      include_fees: false,
    });
  } catch (err) {
    throw new ApiError(502, `Safepay payment session failed: ${err?.message || "unknown error"}`);
  }
  const tracker = unwrap(response)?.tracker;
  if (!tracker?.token) {
    throw new ApiError(502, "Safepay did not return a payment session token");
  }
  return tracker;
}

/**
 * Query Safepay for the authoritative status of a payment session by tracker.
 * Used to reconcile checkout rows when a webhook delivery is missed/failed.
 * Returns { paid: boolean, state: string|null, response }.
 */
export async function getSafepayPaymentStatus(tracker) {
  if (!tracker) throw new ApiError(400, "Tracker is required");
  let response;
  try {
    response = await getClient().reporter.payments.fetch(tracker);
  } catch (err) {
    throw new ApiError(502, `Safepay payment status lookup failed: ${err?.message || "unknown error"}`);
  }
  const data = response && typeof response === "object" && "data" in response ? response.data : response;
  const attempts = Array.isArray(data?.attempts) ? data.attempts : [];
  const captured =
    !!data?.charge?.capture ||
    attempts.some((a) => a?.capture && a?.is_success !== false);
  const paid = captured || data?.state === "TRACKER_ENDED" || data?.state === "SUCCESS";
  return { paid, state: data?.state ?? null, response: data };
}

export async function createSafepayAuthToken() {
  try {
    const response = await getClient().client.passport.create();
    return unwrap(response);
  } catch (err) {
    throw new ApiError(502, `Safepay authentication token failed: ${err?.message || "unknown error"}`);
  }
}

export function buildSafepayCheckoutUrl({ tracker, tbt, redirectUrl, cancelUrl }) {
  const { mode } = getSafepayConfig();
  const env = mode === "live" ? "production" : "sandbox";
  try {
    const url = getClient().checkout.createCheckoutUrl({
      env,
      tbt,
      tracker,
      source: "hosted",
      redirect_url: redirectUrl,
      cancel_url: cancelUrl,
    });
    if (!url) throw new Error("empty checkout url");
    return url;
  } catch (err) {
    throw new ApiError(502, `Safepay checkout URL generation failed: ${err?.message || "unknown error"}`);
  }
}

/**
 * Pull the gateway's own refund reference out of a payment payload.
 *
 * The key is intent-specific (`cybersource_refund`, `mpgs_refund`, ...), and the
 * refund reference appears in more than one place depending on whether the
 * payload came from the refund call or from the reporter. So this scans rather
 * than hardcodes a name, and returns null rather than guessing.
 */
function extractRefundReference(payload) {
  if (!payload || typeof payload !== "object") return null;

  // Reporter shape: attempts[*].refund.token
  const attempts = Array.isArray(payload.attempts) ? payload.attempts : [];
  for (const attempt of attempts) {
    const refund = attempt?.refund;
    if (refund?.token) return refund.token;
  }

  // Charge shape: charge.cybersource_refunds (an array or a single object)
  const chargeRefunds = payload.charge?.cybersource_refunds;
  const list = Array.isArray(chargeRefunds) ? chargeRefunds : chargeRefunds ? [chargeRefunds] : [];
  for (const r of list) {
    if (r?.token) return r.token;
  }

  // Refund-call shape: action.<anything>_refund.token
  const action = payload.action;
  if (action && typeof action === "object") {
    for (const [key, value] of Object.entries(action)) {
      if (/_refund$/i.test(key) && value && typeof value === "object" && value.token) {
        return value.token;
      }
    }
  }

  return null;
}

/** Has the gateway recorded a REFUND event for this tracker? */
function hasRefundEvent(payload) {
  const events = Array.isArray(payload?.events) ? payload.events : [];
  return events.some((e) => String(e?.type ?? "").toUpperCase() === "REFUND");
}

/**
 * Refund a captured payment by its Safepay tracker.
 *
 * Used when a customer backs out of a SCHEDULED subscription change (a renewal or
 * a downgrade that was paid for but has not taken effect).
 *
 * UNITS: `amount` is in the gateway's MINOR unit (paisa), matching
 * createSafepayPaymentSession. Callers holding a major-unit figure (e.g. the
 * subscription_checkouts.amount column, which is DECIMAL in rupees) must multiply
 * by 100. Passing rupees through would request a refund one hundred times too
 * small — a silent, expensive mistake.
 *
 * `amount` and `currency` are MANDATORY: the endpoint validates the payload
 * server-side and answers "could not prepare payload for action 'REFUND': amount:
 * cannot be blank; currency: cannot be blank" without them.
 *
 * SUBMIT vs SETTLE: this only SUBMITS the refund. Acceptance here is not proof
 * the money moved. Callers must confirm settlement with getSafepayRefundStatus()
 * before recording that a refund happened, because a gateway may settle
 * asynchronously and a caller that trusted the submit response would tell a
 * customer their money was returned when it was not.
 *
 * IDEMPOTENCY: the refund endpoint is NOT safe to call twice for one tracker, so
 * the caller MUST gate this on the checkout's refund_status and only submit while
 * it is 'none'. This function performs no deduplication of its own.
 *
 * @returns {{ refundReference: string|null, raw: object }} the gateway's own
 *          refund reference when it returns one, plus the unwrapped response.
 */
export async function refundSafepayPayment(
  tracker,
  { amount, currency = "PKR", metadata = {} } = {}
) {
  if (!tracker || typeof tracker !== "string" || !tracker.trim()) {
    throw new ApiError(400, "A payment tracker is required to issue a refund");
  }
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw new ApiError(400, "A positive refund amount is required to issue a refund");
  }
  if (!currency || typeof currency !== "string" || !currency.trim()) {
    throw new ApiError(400, "A refund currency is required to issue a refund");
  }

  let response;
  try {
    response = await getClient().order.cancel.refund(tracker.trim(), {
      amount: Math.round(numericAmount),
      currency: currency.trim().toUpperCase(),
      metadata,
    });
  } catch (err) {
    throw new ApiError(502, `Safepay refund failed: ${err?.message || "unknown error"}`);
  }

  const raw = unwrap(response);
  return { refundReference: extractRefundReference(raw), raw };
}

/**
 * Ask the gateway whether a refund on `tracker` has actually SETTLED.
 *
 * This is the only call in the codebase allowed to be the basis for telling a
 * customer their money was returned. It reads the gateway's own record, which is
 * what makes it safe against an asynchronous settlement: three independent
 * signals are checked, so none of them being briefly absent can be mistaken for
 * "not refunded":
 *
 *   - tracker state is TRACKER_REFUNDED
 *   - a REFUND event exists in the event list
 *   - an attempt carries a refund token (this is the reference to store)
 *
 * A tracker that was never refunded reports TRACKER_ENDED with no REFUND event and
 * no refund token, so the three are genuinely distinguishing rather than
 * always-true.
 *
 * @returns {{ settled: boolean, state: string|null, refundReference: string|null,
 *   hasRefundEvent: boolean }}
 */
export async function getSafepayRefundStatus(tracker) {
  if (!tracker || typeof tracker !== "string" || !tracker.trim()) {
    throw new ApiError(400, "Tracker is required");
  }
  let response;
  try {
    response = await getClient().reporter.payments.fetch(tracker.trim());
  } catch (err) {
    throw new ApiError(502, `Safepay refund status lookup failed: ${err?.message || "unknown error"}`);
  }
  const data = response && typeof response === "object" && "data" in response ? response.data : response;

  const refundReference = extractRefundReference(data);
  const refundEvent = hasRefundEvent(data);
  const state = data?.state ?? null;
  const settled = state === "TRACKER_REFUNDED" || refundEvent || Boolean(refundReference);

  return { settled, state, refundReference, hasRefundEvent: refundEvent };
}