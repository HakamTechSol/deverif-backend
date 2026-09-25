import ApiError from "../utils/ApiError.js";
import { pool } from "../config/db.js";
import { ok } from "../utils/response.js";
import { assertUuid } from "../utils/publicResponse.js";
import {
  createOrgCheckout,
  getOrgSubscriptionStatus,
  getCheckoutByUuid,
} from "../services/subscriptionCheckout.service.js";

export async function createCheckout(req, res) {
  const { plan_uuid, purpose } = req.body || {};
  if (!plan_uuid) throw new ApiError(400, "plan_uuid is required");
  assertUuid(plan_uuid, "Plan UUID");

  const normalizedPurpose = purpose === "change_plan" ? "change_plan" : "subscribe";

  const [[plan]] = await pool.query(
    `SELECT id, uuid, name, monthly_price, daily_request_quota, billing_period, is_free
     FROM subscription_plans
     WHERE uuid=? AND is_custom=0 AND is_public=1`,
    [plan_uuid]
  );
  if (!plan) throw new ApiError(404, "Plan not found or not available for self-subscription");
  if (plan.is_free === 1) {
    throw new ApiError(400, "The free plan is assigned automatically and cannot be purchased or renewed");
  }

  const result = await createOrgCheckout({
    organizationId: req.user.organization,
    plan,
    requestedByUuid: req.user.uuid,
    purpose: normalizedPurpose,
  });

  return ok(
    res,
    {
      checkout: {
        uuid: result.checkout.uuid,
        status: result.checkout.status,
        amount: Number(result.checkout.amount),
        currency: result.checkout.currency,
        plan_name: plan.name,
      },
      redirect_url: result.redirect_url,
    },
    "Checkout created. Redirect the user to the payment page."
  );
}

export async function getSubscriptionStatus(req, res) {
  const data = await getOrgSubscriptionStatus(req.user.organization);
  return ok(res, data, "Subscription status");
}

export async function getCheckout(req, res) {
  const { checkoutId } = req.params;
  assertUuid(checkoutId, "Checkout UUID");
  const checkout = await getCheckoutByUuid({
    organizationId: req.user.organization,
    checkoutUuid: checkoutId,
  });
  return ok(res, { checkout }, "Checkout status");
}