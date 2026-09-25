import { verifyWebhookSignature } from "../utils/webhookSignature.js";
import { logPaymentEvent } from "../utils/paymentLogger.js";
import { findCheckoutByTracker } from "../services/subscriptionCheckout.service.js";
import { finalizeSuccessfulCheckout, markCheckoutFailed } from "../services/payment.service.js";
import { createNotificationForOrgUsers } from "./notification.controller.js";

export async function handlePaymentWebhook(req, res) {
  const rawBody = typeof req.rawBody === "string" ? req.rawBody : (req.rawBody?.toString?.("utf8") ?? "");
  const signature = req.headers["x-sfpy-signature"] || "";
  const timestamp = req.headers["x-sfpy-timestamp"] || "";

  const startedAt = Date.now();

  const verification = verifyWebhookSignature({ rawBody, signature, timestamp });
  if (!verification.ok) {
    await logPaymentEvent({
      message: `webhook signature rejected: ${verification.error}`,
      level: "warn",
    });
    return res.status(401).json({ success: false, message: "Invalid webhook signature" });
  }

  let payload;
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    await logPaymentEvent({ message: "webhook payload is not valid JSON", level: "warn" });
    return res.status(400).json({ success: false, message: "Invalid webhook payload" });
  }

  const type = typeof payload?.type === "string" ? payload.type : "";
  const eventId =
    typeof payload?.token === "string"
      ? payload.token
      : typeof payload?.id === "string"
        ? payload.id
        : "";
  // Safepay places the tracker in different locations depending on the API
  // generation: nested under `data`, under `notification`, or at the top level.
  const tracker =
    typeof payload?.data?.tracker === "string"
      ? payload.data.tracker
      : typeof payload?.notification?.tracker === "string"
        ? payload.notification.tracker
        : typeof payload?.tracker === "string"
          ? payload.tracker
          : "";
  const state =
    payload?.data?.state ??
    payload?.notification?.state ??
    payload?.state ??
    null;
  const amount =
    payload?.data?.amount ??
    payload?.notification?.amount ??
    payload?.amount ??
    null;
  const currency =
    payload?.data?.currency ??
    payload?.notification?.currency ??
    payload?.currency ??
    null;

  await logPaymentEvent({
    message: `webhook received: type=${type}, event=${eventId}, tracker=${tracker}`,
    level: "info",
    event_id: eventId,
    tracker,
    type,
    state,
    amount,
    currency,
  });

  if (!eventId || !tracker) {
    await logPaymentEvent({ message: "ignoring webhook without event id or tracker", level: "warn" });
    return res.status(200).json({ success: true });
  }

  const checkout = await findCheckoutByTracker(tracker);
  if (!checkout) {
    await logPaymentEvent({
      message: `ignoring webhook for unknown tracker ${tracker}`,
      level: "warn",
      event_id: eventId,
    });
    return res.status(200).json({ success: true });
  }

  const SUCCESS_TYPES = new Set(["payment.succeeded", "payment.completed", "payment.authorized"]);
  const FAILURE_TYPES = new Set(["payment.failed", "payment.rejected"]);

  if (SUCCESS_TYPES.has(type)) {
    const expectedAmountPaisa = Math.round(Number(checkout.amount) * 100);
    const actualAmountPaisa = Number(amount);
    if (!Number.isFinite(actualAmountPaisa) || actualAmountPaisa !== expectedAmountPaisa) {
      await logPaymentEvent({
        message: `amount mismatch for tracker ${tracker}: expected ${expectedAmountPaisa}, got ${amount}`,
        level: "warn",
        event_id: eventId,
      });
      return res.status(400).json({ success: false, message: "Payment amount does not match the checkout" });
    }
    if (currency && String(currency).toUpperCase() !== String(checkout.currency || "PKR").toUpperCase()) {
      await logPaymentEvent({
        message: `currency mismatch for tracker ${tracker}`,
        level: "warn",
        event_id: eventId,
      });
      return res.status(400).json({ success: false, message: "Payment currency does not match the checkout" });
    }

    const result = await finalizeSuccessfulCheckout({ checkoutId: checkout.id, eventId });

    if (!result.already_processed) {
      createNotificationForOrgUsers({
        orgId: checkout.organization_id,
        type: "self_subscription_confirmed",
        title: "Subscription activated",
        message: `Your subscription to ${result.subscription?.plan} is now active (expires ${new Date(
          result.subscription?.expiry
        )
          .toISOString()
          .slice(0, 10)}).`,
        link: "/payments",
        referenceId: checkout.uuid,
        orgRoles: ["org_admin"],
      }).catch(() => {});
    }

    await logPaymentEvent({
      message: `payment succeeded for tracker ${tracker} (${result.already_processed ? "already processed" : "activated"})`,
      level: "info",
      event_id: eventId,
      tracker,
      latency_ms: Date.now() - startedAt,
    });
    return res.status(200).json({ success: true });
  }

  if (FAILURE_TYPES.has(type)) {
    await markCheckoutFailed({ checkoutId: checkout.id, eventId });
    await logPaymentEvent({
      message: `payment failed for tracker ${tracker}`,
      level: "warn",
      event_id: eventId,
      tracker,
      state,
    });
    return res.status(200).json({ success: true });
  }

  await logPaymentEvent({ message: `ignoring unsupported webhook type ${type}`, level: "info", event_id: eventId });
  return res.status(200).json({ success: true });
}