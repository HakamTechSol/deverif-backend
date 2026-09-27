/**
 * Build a plan summary for `GET /payment/plan`.
 *
 * Subscriptions are managed at the ORG level only, so everything here is derived
 * from the organization's current plan row. The Free plan is identified purely by
 * its `is_free` flag -- never by a hardcoded id, a name match ("Free") or a
 * price check -- so renaming or recreating it needs no code change.
 */

/**
 * @param orgSubscription the org_subscription payload built by the controller.
 *        Must carry `is_free` (from the joined subscription_plans row) for the
 *        Free plan to be recognised.
 */
export function getPlanSummary(orgSubscription = null) {
  if (!orgSubscription) {
    // No org-managed subscription at all (orgless user): the free tier.
    return {
      code: "free",
      label: null,
      is_free: true,
      plan_name: null,
      plan_uuid: null,
      expires_at: null,
      has_expiry: false,
      is_expired: false,
      is_active: false,
      status: "free",
    };
  }

  const isFree = orgSubscription.is_free === 1 || orgSubscription.is_free === true;
  const expiry = orgSubscription.expiry ? new Date(orgSubscription.expiry) : null;
  const hasExpiry = expiry instanceof Date && !Number.isNaN(expiry.valueOf());
  // A Free plan has no billing cycle, so a NULL expiry is the normal, valid
  // state for it -- NOT an expiry. A paid plan with no expiry is a data bug, so
  // it is reported as expired rather than treated as perpetual access.
  const isExpired = isFree ? false : !hasExpiry || expiry.getTime() < Date.now();

  return {
    code: isFree ? "free" : "paid",
    label: orgSubscription.plan_name ?? null,
    is_free: isFree,
    plan_name: orgSubscription.plan_name ?? null,
    plan_uuid: orgSubscription.plan_uuid ?? null,
    expires_at: hasExpiry ? orgSubscription.expiry : null,
    has_expiry: hasExpiry,
    is_expired: isExpired,
    is_active: orgSubscription.status === "active" && !isExpired,
    status: isExpired ? "expired" : isFree ? "free" : "active",
  };
}
