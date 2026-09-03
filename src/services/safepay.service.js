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