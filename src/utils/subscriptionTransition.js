import ApiError from "./ApiError.js";
import { resetDailyRequestUsage } from "./requestQuota.js";
import { isFreePlan, PLAN_SELECT_COLUMNS } from "./subscriptionPlans.js";
import { logAudit } from "./auditLog.js";

export { PLAN_SELECT_COLUMNS };

/**
 * Single source of truth for "what happens when this organization pays for /
 * is granted this plan?".
 *
 * Every path that activates a subscription goes through
 * `resolveSubscriptionChange` + `applySubscriptionChange`:
 *   - the Safepay webhook            (services/payment.service.js)
 *   - checkout completion / webhook reconciliation (same service)
 *   - admin manual override          (controllers/admin/organizations.controller.js)
 *   - custom-plan approval           (controllers/admin/subscription.controller.js)
 *   - legacy JazzCash/Easypaisa callback (controllers/payment.controller.js)
 *
 * Keeping the date math here is the whole point: the previous behaviour
 * computed `expiry = today + billing_period` on every path, which silently
 * discarded the remainder of the current period on a renewal and treated
 * upgrades exactly like downgrades.
 *
 * Every organization is always on a real plan, Free being the default (looked up
 * dynamically in utils/subscriptionPlans.js), so the transition is always a
 * comparison against whatever plan the org currently has -- there is no
 * "no plan" special case to reason about.
 */

const MONTHS_BY_BILLING_PERIOD = { monthly: 1, yearly: 12 };

/**
 * Add one billing period to `date`.
 *
 * Extracted from the copy-pasted `expiry.setMonth(expiry.getMonth() + n)` that
 * used to live in five separate files. The day-of-month is clamped so that
 * "31 January + 1 month" lands on 28/29 February instead of silently rolling
 * forward into March (JS `setMonth` overflows on short target months).
 */
export function addBillingPeriod(date, billingPeriod) {
  const base = new Date(date);
  if (Number.isNaN(base.getTime())) {
    throw new ApiError(400, "Cannot add a billing period to an invalid date");
  }
  const months = MONTHS_BY_BILLING_PERIOD[billingPeriod] ?? MONTHS_BY_BILLING_PERIOD.monthly;

  const dayOfMonth = base.getDate();
  const result = new Date(base.getTime());
  result.setMonth(result.getMonth() + months);
  if (result.getDate() < dayOfMonth) {
    // setMonth overflowed into the following month (e.g. 31 Jan + 1 month).
    // Walk back to the last day of the intended target month.
    result.setDate(0);
  }
  return result;
}

/** Months added by a billing period (exposed for audit/response details). */
export function billingPeriodMonths(billingPeriod) {
  return MONTHS_BY_BILLING_PERIOD[billingPeriod] ?? MONTHS_BY_BILLING_PERIOD.monthly;
}

/**
 * The expiry date a plan should carry once it starts (or continues) at
 * `baseDate`.
 *
 * The Free plan is Rs. 0 and never needs renewing, so it has no billing cycle
 * at all: its expiry is NULL, which means "indefinite" for a Free org rather
 * than "expired" (see isSubscriptionValid). Every paid plan gets the usual
 * month arithmetic.
 */
export function expiryForPlan(plan, baseDate) {
  if (isFreePlan(plan)) return null;
  return addBillingPeriod(baseDate, plan?.billing_period);
}

/**
 * Is this organization entitled to paid features right now?
 *
 * `active` + a NULL expiry is only legitimate for the Free plan (which never
 * expires). A PAID plan with a NULL expiry is a data bug, and a paid plan whose
 * expiry has passed has lapsed -- in both cases the org keeps working but on the
 * free daily allowance, not the paid quota.
 *
 * The lifecycle job (services/subscriptionLifecycle.service.js) moves genuinely
 * lapsed paid subscriptions onto the Free plan; this predicate is the
 * read-side mirror of that, so a lapse is never exploitable in the window
 * between the expiry passing and the next sweep.
 */
export function isSubscriptionValid(org, now = new Date()) {
  if (!org || org.subscription_status !== "active") return false;
  if (!org.subscription_expiry) {
    // No expiry: fine for Free, meaningless for a paid plan.
    return isFreePlan(org.current_plan);
  }
  const expiry = new Date(org.subscription_expiry);
  if (Number.isNaN(expiry.getTime())) return false;
  return expiry > now;
}

/**
 * Does the organization currently hold a valid subscription?
 *
 * This is true for the Free plan too -- Free is a real, active subscription, it
 * simply never expires. That is what lets every organization, Free included, run
 * through the ordinary tier comparison in resolveSubscriptionChange rather than
 * hitting a "no plan" special case.
 *
 * It is false for a lapsed paid subscription and for a 'none' org, i.e. exactly
 * the cases where there is no live period to extend or protect.
 */
export function isSubscriptionActive(org, now = new Date()) {
  return isSubscriptionValid(org, now);
}

/**
 * Compare the currently active plan with a requested plan.
 *
 * Plans are differentiated by `daily_request_quota` -- that is the functional
 * difference the customer actually buys (see requestQuota.js, which enforces
 * exactly that column). `monthly_price` is only the tie-breaker, so two plans
 * with an identical quota are treated as the same tier and a renewal rather
 * than an upgrade/downgrade, which is what keeps a "different id, same tier"
 * plan from being mistaken for a plan change.
 *
 * `is_free` is checked FIRST because the Free plan is a strictly lower tier by
 * definition, whatever its quota/price numbers happen to say. Without this, a
 * Free plan with a 0 quota would already compare as a downgrade, but a Free plan
 * that happened to be given a non-zero quota (or a paid plan given quota 0)
 * would compare as an upgrade and a deliberate move back to Free could take
 * effect immediately instead of being deferred.
 */
export function comparePlanTier(currentPlan, requestedPlan) {
  const currentIsFree = isFreePlan(currentPlan);
  const requestedIsFree = isFreePlan(requestedPlan);
  if (currentIsFree !== requestedIsFree) {
    return requestedIsFree ? "downgrade" : "upgrade";
  }

  const currentQuota = Number(currentPlan?.daily_request_quota ?? 0);
  const requestedQuota = Number(requestedPlan?.daily_request_quota ?? 0);
  if (requestedQuota !== currentQuota) {
    return requestedQuota > currentQuota ? "upgrade" : "downgrade";
  }

  const currentPrice = Number(currentPlan?.monthly_price ?? 0);
  const requestedPrice = Number(requestedPlan?.monthly_price ?? 0);
  if (requestedPrice !== currentPrice) {
    return requestedPrice > currentPrice ? "upgrade" : "downgrade";
  }

  return "same";
}

/**
 * Decide what should happen to an organization's subscription given a newly
 * paid/approved plan. Does NOT commit anything and does NOT touch the database
 * -- it returns a plan of action for the caller to apply inside its own
 * transaction.
 *
 * The three outcomes:
 *   activate_now        no live subscription -> fresh cycle starting today
 *   upgrade_now         higher tier, still active -> switch immediately on a
 *                       fresh cycle (no proration, no carry-over)
 *   change_scheduled    SAME or LOWER tier, still active -> keep everything as-is
 *                       and park the new plan in pending_plan_id until the
 *                       current period expires (applied by the lifecycle job)
 *
 * There is deliberately no "renew" outcome any more. A renewal is not a distinct
 * kind of change: it is a scheduled change whose target happens to be the plan the
 * org already has. Splitting it out is what previously let a same-plan purchase
 * extend subscription_expiry immediately, which silently discarded whatever the
 * customer had already paid for and made the behaviour depend on whether they
 * clicked "Renew" or "Change plan". Same-plan and lower-tier now take one path.
 *
 * @param org            organization row as loaded by loadOrganizationSubscriptionState
 *                       (must include subscription_status/_expiry/_plan_id and the
 *                       joined current plan's quota/price)
 * @param requestedPlan  plan row being bought/granted
 * @param options.force  admin-only override: always activate immediately
 * @param options.now    injectable clock (tests)
 */
export function resolveSubscriptionChange(org, requestedPlan, { force = false, now = new Date() } = {}) {
  if (!requestedPlan?.id) {
    throw new ApiError(400, "A subscription plan is required");
  }
  if (!org) {
    throw new ApiError(404, "Organization not found");
  }

  const months = billingPeriodMonths(requestedPlan.billing_period);
  const previousExpiry = org.subscription_expiry ? new Date(org.subscription_expiry) : null;
  const currentlyActive = isSubscriptionActive(org, now);

  // How the requested plan ranks against the one the org has now. Every org is
  // on a real plan (Free by default), so this comparison always has something to
  // work with -- there is no "no plan" case. It is recorded on the result for
  // audit/notification wording even when the short-circuit below decides the
  // action differently.
  const relation = comparePlanTier(org.current_plan, requestedPlan);

  const buildImmediate = (action, baseDate) => ({
    action,
    relation,
    apply_immediately: true,
    // subscription_start is only (re)stamped when the org had no live
    // subscription; an upgrade does not reset the day they became a subscriber.
    restamp_start: action === "activate_now",
    subscription_plan_id: requestedPlan.id,
    // The Free plan carries no expiry (it never needs renewing); a paid plan
    // gets the usual month arithmetic from the base date.
    subscription_expiry: expiryForPlan(requestedPlan, baseDate),
    subscription_status: "active",
    pending_plan_id: null,
    previous_status: org.subscription_status ?? null,
    previous_plan_id: org.subscription_plan_id ?? null,
    previous_expiry: previousExpiry,
    period_base_date: new Date(baseDate),
    months_added: months,
  });

  if (!currentlyActive) {
    // The org has no live paid period: it is on Free, or its paid plan has
    // already lapsed. There is nothing to extend and nothing to protect, so the
    // new period starts today.
    //
    // This deliberately happens BEFORE the tier comparison rather than folding
    // into it. If it did not, buying a lower-tier plan after the current one had
    // already expired would be classified as a downgrade and deferred into
    // pending_plan_id -- scheduling a change to be applied at an expiry date
    // that is already in the past, against paid time that no longer exists.
    // The comparison still runs (see `relation`) so callers can report it.
    return buildImmediate("activate_now", now);
  }

  if (force) {
    // Admin override: force the change to take effect right now on a fresh
    // cycle, discarding whatever was left on the previous plan.
    return buildImmediate("activate_now", now);
  }

  if (relation === "upgrade") {
    // The only case that acts immediately. A strictly higher quota is a strictly
    // better product, so there is no reason to make the customer wait out the
    // rest of a period they are paying for anyway.
    return buildImmediate("upgrade_now", now);
  }

  // Everything else while a subscription is live: SAME tier or LOWER tier.
  //
  // Both are scheduled, and both are safe to schedule at any point during the
  // current period -- there is no "near expiry" window, because the customer has
  // already paid and their live period is protected either way.
  //
  // `pending_plan_id` is allowed to equal the current `subscription_plan_id`.
  // That is the renewal case, and it is a real value rather than a no-op: at
  // expiry the lifecycle job applies the normal path and computes
  // new_expiry = old_expiry + billing_period, which is exactly the renewal the
  // customer paid for.
  //
  // Note nothing about the Free plan is special-cased here. A deliberate move
  // back to Free flows through this same path; the only Free-specific behaviour
  // anywhere is that its expiry is NULL (no billing cycle) when the lifecycle
  // job eventually applies it.
  return {
    action: "change_scheduled",
    relation,
    apply_immediately: false,
    restamp_start: false,
    subscription_plan_id: org.subscription_plan_id,
    subscription_expiry: previousExpiry,
    subscription_status: org.subscription_status,
    pending_plan_id: requestedPlan.id,
    previous_status: org.subscription_status ?? null,
    previous_plan_id: org.subscription_plan_id ?? null,
    previous_expiry: previousExpiry,
    period_base_date: previousExpiry,
    months_added: months,
    // A same-plan renewal is the one case where pending_plan_id equals the
    // current plan. Callers use this to word the response ("renewal" vs
    // "downgrade") and the cancel/refund path uses it to keep a single mechanism.
    is_renewal: relation === "same",
  };
}

/**
 * Load an organization's current subscription state for a transition decision.
 *
 * The organization row is locked `FOR UPDATE` so a concurrent duplicate webhook
 * -- or a competing activation from the manual admin path for the same org --
 * queues behind the first commit instead of both extending the subscription.
 * The plan lookup is deliberately a separate, non-locking read so the lock is
 * not widened onto subscription_plans (which admins edit via /admin/plans).
 */
export async function loadOrganizationSubscriptionState(connection, organizationId) {
  const [[org]] = await connection.query(
    `SELECT id, uuid, subscription_status, subscription_start, subscription_expiry,
            subscription_plan_id, pending_plan_id
     FROM organizations
     WHERE id=?
     FOR UPDATE`,
    [organizationId]
  );
  if (!org) throw new ApiError(404, "Organization not found");

  org.current_plan = null;
  if (org.subscription_plan_id != null) {
    const [[plan]] = await connection.query(
      `SELECT ${PLAN_SELECT_COLUMNS} FROM subscription_plans WHERE id=?`,
      [org.subscription_plan_id]
    );
    org.current_plan = plan || null;
  }
  return org;
}

/** Same shape as loadOrganizationSubscriptionState, resolved by org uuid. */
export async function loadOrganizationSubscriptionStateByUuid(connection, organizationUuid) {
  const [[row]] = await connection.query(
    "SELECT id FROM organizations WHERE uuid=?",
    [organizationUuid]
  );
  if (!row) throw new ApiError(404, "Organization not found");
  return loadOrganizationSubscriptionState(connection, row.id);
}

/**
 * Apply a decision from `resolveSubscriptionChange` inside the caller's
 * transaction. This is the only place that writes organizations.subscription_*,
 * so no call site can drift back to its own copy of the date math.
 *
 * Every application writes an audit_logs row recording the BEFORE and AFTER
 * subscription state. This module deliberately does NOT log itself -- a
 * transition is frequently only half-done at this point (the caller's
 * transaction may still roll back), so the caller logs after its commit, where
 * the row is known to be durable. See logSubscriptionChangeApplied().
 */
export async function applySubscriptionChange(connection, { organizationId, change, now = new Date() }) {
  if (!change) throw new ApiError(400, "No subscription change to apply");

  if (!change.apply_immediately) {
    // Deferred downgrade: the current plan, expiry and status are deliberately
    // left untouched. Only the pending plan is recorded.
    await connection.query(
      "UPDATE organizations SET pending_plan_id=? WHERE id=?",
      [change.pending_plan_id ?? null, organizationId]
    );
    return { expiry: change.subscription_expiry, action: change.action };
  }

  await connection.query(
    `UPDATE organizations
     SET subscription_status='active',
         subscription_start=CASE WHEN ? THEN ? ELSE subscription_start END,
         subscription_expiry=?, subscription_plan_id=?, pending_plan_id=NULL,
         reminder_2d_sent='no', reminder_2h_sent='no'
     WHERE id=?`,
    [
      change.restamp_start ? 1 : 0,
      now,
      change.subscription_expiry,
      change.subscription_plan_id,
      organizationId,
    ]
  );

  // An activation grants a fresh entitlement, so today's usage is cleared: the
  // org starts on the full daily quota of the plan they just paid for rather
  // than the new quota minus whatever the previous plan already consumed.
  await resetDailyRequestUsage(organizationId, connection);

  return { expiry: change.subscription_expiry, action: change.action };
}

/**
 * Write the audit trail for a committed subscription change.
 *
 * This exists because an unexplained subscription mutation once left two
 * organizations planless with no trace of what wrote it: the only writer of
 * organizations.subscription_* is applySubscriptionChange, and until now it
 * wrote no log at all, so a regression (or a stray script) was undetectable.
 * Now every state change records the previous status/plan/expiry alongside the
 * new one, plus which code path performed it via `source`.
 *
 * Call this AFTER the caller's transaction commits. It is deliberately outside
 * the transaction and never throws: losing an audit row is better than rolling
 * back a customer's payment.
 *
 * @param source a stable identifier for the code path, e.g. "safepay_webhook",
 *               "admin_override", "custom_plan_approve", "self_subscribe_confirm".
 */
export function logSubscriptionChangeApplied({
  orgUuid,
  organizationId,
  change,
  source,
  actor = null,
  extra = {},
}) {
  try {
    logAudit({
      // actorId is deliberately null, not `source`. `source` is a code-path
      // label ("safepay_webhook"), not a user id: putting it in an INT column
      // only ever produced actor_id=0 by silent coercion, which reads as a real
      // user id in the audit trail. The label belongs in actorName, and is also
      // recorded in details.source below.
      ...(actor || { actorType: "system", actorId: null, actorName: source, actorRole: "system" }),
      action: "subscription.applied",
      entityType: "organization",
      entityId: orgUuid ?? String(organizationId ?? ""),
      details: {
        source,
        transition: change?.action ?? null,
        relation: change?.relation ?? null,
        before: {
          status: change?.previous_status ?? null,
          plan_id: change?.previous_plan_id ?? null,
          expiry: change?.previous_expiry ?? null,
        },
        after: {
          status: change?.subscription_status ?? null,
          plan_id: change?.subscription_plan_id ?? null,
          expiry: change?.subscription_expiry ?? null,
          pending_plan_id: change?.pending_plan_id ?? null,
        },
        ...extra,
      },
    });
  } catch (err) {
    console.error("Subscription audit log failed:", err.message);
  }
}

/** Human-readable one-liner describing the outcome, for API/audit details. */
export function describeSubscriptionChange(change) {
  const expiry = change.subscription_expiry
    ? new Date(change.subscription_expiry).toISOString().slice(0, 10)
    : "no expiry";

  switch (change.action) {
    case "upgrade_now":
      return `upgraded immediately to plan ${change.subscription_plan_id} (${change.relation}): fresh cycle ends ${expiry}`;
    case "change_scheduled":
      // One mechanism, two meanings. Say which, because "renewal at expiry" and
      // "downgrade at expiry" read very differently to a customer even though the
      // mechanism and the resulting date arithmetic are identical.
      return change.relation === "same"
        ? `renewal of plan ${change.pending_plan_id} scheduled for ${expiry}: the new period runs from when the current one ends, not from today`
        : `downgrade to plan ${change.pending_plan_id} (${change.relation}) scheduled for ${expiry}`;
    default:
      return `subscription activated (${change.relation}): new cycle ends ${expiry}`;
  }
}
