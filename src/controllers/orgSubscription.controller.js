import ApiError from "../utils/ApiError.js";
import { pool } from "../config/db.js";
import { ok } from "../utils/response.js";
import { assertUuid } from "../utils/publicResponse.js";
import {
  createOrgCheckout,
  getOrgSubscriptionStatus,
  getCheckoutByUuid,
  refundScheduledChange,
} from "../services/subscriptionCheckout.service.js";
import { PLAN_SELECT_COLUMNS } from "../utils/subscriptionTransition.js";
import { logAudit, getActorFromReq } from "../utils/auditLog.js";

export async function createCheckout(req, res) {
  const { plan_uuid, purpose } = req.body || {};
  if (!plan_uuid) throw new ApiError(400, "plan_uuid is required");
  assertUuid(plan_uuid, "Plan UUID");

  const normalizedPurpose = purpose === "change_plan" ? "change_plan" : "subscribe";

  const [[plan]] = await pool.query(
    `SELECT ${PLAN_SELECT_COLUMNS} FROM subscription_plans
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

/**
 * Org admin: open a payment session for an APPROVED custom plan.
 *
 * Approving a custom-plan request does not grant the plan — it only records the
 * negotiated terms. The plan is activated by paying for it, exactly like any
 * other plan, so the org is never moved onto a paid plan it has not paid for.
 *
 * This endpoint is the missing half of that flow. The normal
 * `POST /org/subscription/checkout` deliberately refuses custom plans
 * (`is_custom=0 AND is_public=1`), because a custom plan must never be
 * self-service — it is not public and its price was negotiated. Without a
 * separate path, an approved request could be recorded but never paid for.
 *
 * Guard rails:
 *   - org admin only (enforced by the route)
 *   - the request must belong to THIS organization
 *   - it must be approved, and must have a plan actually linked to it
 *   - the plan must still be a custom plan
 */
export async function createCustomPlanCheckout(req, res) {
  const { custom_plan_request_uuid: requestUuid } = req.body || {};
  if (!requestUuid) throw new ApiError(400, "custom_plan_request_uuid is required");
  assertUuid(requestUuid, "Custom plan request UUID");

  const organizationId = req.user.organization;
  if (!organizationId) {
    throw new ApiError(400, "Your account is not linked to an organization");
  }

  const [[request]] = await pool.query(
    `SELECT cpr.id, cpr.uuid, cpr.status, cpr.approved_plan_id,
            cpr.approved_daily_quota, cpr.approved_price
       FROM custom_plan_requests cpr
      WHERE cpr.uuid=? AND cpr.organization_id=?`,
    [requestUuid, organizationId]
  );
  // Scoped to the organization in the WHERE clause, so a request belonging to
  // another org is simply "not found" rather than a leak of its existence.
  if (!request) throw new ApiError(404, "Custom plan request not found");
  if (request.status !== "approved") {
    throw new ApiError(
      409,
      request.status === "pending"
        ? "This custom plan request has not been approved yet"
        : "This custom plan request was denied"
    );
  }
  if (!request.approved_plan_id) {
    throw new ApiError(
      409,
      "This approved request has no plan attached. Please ask the System Admin to re-approve it."
    );
  }

  const [[plan]] = await pool.query(
    `SELECT ${PLAN_SELECT_COLUMNS} FROM subscription_plans WHERE id=? AND is_custom=1`,
    [request.approved_plan_id]
  );
  if (!plan) {
    throw new ApiError(409, "The plan for this request is no longer available. Please contact the System Admin.");
  }

  const result = await createOrgCheckout({
    organizationId,
    plan,
    requestedByUuid: req.user.uuid,
    // Billing effect is recomputed inside createOrgCheckout from the org's live
    // state, so this only records provenance.
    customPlanRequestUuid: requestUuid,
  });

  logAudit({
    ...getActorFromReq(req),
    action: "custom_plan.checkout_started",
    entityType: "custom_plan_request",
    entityId: requestUuid,
    details: {
      organization_id: organizationId,
      plan_id: plan.id,
      plan_name: plan.name,
      approved_daily_quota: request.approved_daily_quota,
      approved_price: request.approved_price,
      checkout_uuid: result.checkout.uuid,
      amount: Number(result.checkout.amount),
      // Same contract as approving: a checkout is not an activation.
      subscription_activated: false,
    },
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

/**
 * Cancel a deferred downgrade before it takes effect. The org keeps its current
 * (higher) plan and the pending plan change is simply dropped.
 */
export async function cancelPendingPlan(req, res) {
  const organizationId = req.user.organization;
  if (!organizationId) {
    throw new ApiError(400, "Your account is not linked to an organization");
  }

  // Throws 400 when there is nothing scheduled. That is the desired contract: a
  // cancel request that silently reports success while leaving the scheduled
  // change in place is indistinguishable from a working cancel to the caller.
  //
  // This also covers the "too late" case for free — once the lifecycle sweep has
  // applied the change, pending_plan_id is NULL and there is no longer anything
  // to cancel or refund.
  const outcome = await refundScheduledChange({ organizationId });

  const data = await getOrgSubscriptionStatus(organizationId);
  // Cleared only when the gateway has CONFIRMED the refund. A submitted-but-
  // unsettled refund leaves the scheduled change in place, so recording
  // cleared_pending_plan: true there would be a false claim in the audit trail.
  const clearedPendingPlan = !outcome.pending_confirmation;

  logAudit({
    ...getActorFromReq(req),
    action:
      outcome.pending_confirmation
        ? "subscription.scheduled_change_refund_submitted"
        : "subscription.scheduled_change_cancelled_refunded",
    entityType: "organization",
    entityId: organizationId,
    details: {
      cleared_pending_plan: clearedPendingPlan,
      checkout_uuid: outcome.checkout?.uuid ?? null,
      checkout_status: outcome.checkout?.status ?? null,
      refund_submitted: Boolean(outcome.refund),
      refund_confirmed: !outcome.pending_confirmation && Boolean(outcome.refund),
      refund_pending_confirmation: Boolean(outcome.pending_confirmation),
      refund_transaction_reference: outcome.refund_reference ?? null,
      gateway_state: outcome.refund_state ?? null,
      already_refunded: outcome.already_refunded,
    },
    req,
  });

  // Three genuinely different outcomes, and the customer must be told which one
  // actually happened. Collapsing "submitted" into "refunded" is precisely the
  // bug this flow is meant not to have.
  if (outcome.pending_confirmation) {
    return ok(
      res,
      {
        ...data,
        refund_status: "pending",
        refund_transaction_reference: outcome.refund_reference ?? null,
        pending_plan_still_scheduled: true,
      },
      "Your refund has been submitted to the payment provider and is being confirmed. " +
        "Your plan is unchanged and the scheduled renewal is still in place — it will be " +
        "dropped automatically as soon as the refund is confirmed. Please do not retry."
    );
  }

  return ok(
    res,
    {
      ...data,
      refund_status: outcome.already_refunded ? "refunded" : outcome.refund ? "refunded" : "not_required",
      refund_transaction_reference: outcome.refund_reference ?? null,
      pending_plan_still_scheduled: false,
    },
    outcome.refund
      ? "Scheduled change cancelled and refunded. You are staying on your current plan."
      : outcome.already_refunded
        ? "Scheduled change cancelled. This payment was already refunded."
        : "Scheduled change cancelled. You are staying on your current plan."
  );
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