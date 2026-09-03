const PLAN_LABELS = {
  free: "Free",
  basic: "Basic",
  premium: "Premium"
};

// Map plan names (from subscription_plans.name) back to codes when the
// org-level `subscription_plan` column is empty or missing.
const PLAN_NAME_TO_CODE = {};
for (const [code, label] of Object.entries(PLAN_LABELS)) {
  PLAN_NAME_TO_CODE[label.toLowerCase()] = code;
}

export function normalizePlan(plan) {
  return ["free", "basic", "premium"].includes(plan) ? plan : "free";
}

/**
 * Build a plan summary.  When an `orgSubscription` object is provided (from
 * the organizations table), it takes precedence over the user-level fields
 * because subscriptions are managed at the org level.
 */
export function getPlanSummary(user = {}, orgSubscription = null) {
  // Prefer org-level subscription data when available.
  const source = orgSubscription
    ? {
        subscription_plan: orgSubscription.plan ?? orgSubscription.subscription_plan ?? "free",
        subscription_expiry: orgSubscription.expiry ?? orgSubscription.subscription_expiry ?? null,
        plan_name: orgSubscription.plan_name ?? null,
        status: orgSubscription.status ?? null,
      }
    : user;

  // Resolve the plan code.  `org.subscription_plan` is often left blank —
  // the real data lives in subscription_plans.name (plan_name).
  let planCode = source.subscription_plan || "free";
  if (planCode === "free" && source.plan_name) {
    const derived = PLAN_NAME_TO_CODE[source.plan_name.toLowerCase()];
    if (derived) {
      planCode = derived;
    } else if (source.status === "active") {
      // Custom/unknown plan name (e.g. "Advance") but org is active — use
      // the name directly so the summary doesn't misleadingly say "free".
      planCode = source.plan_name;
    }
  }

  const expiry = source.subscription_expiry ? new Date(source.subscription_expiry) : null;
  const hasExpiry = expiry instanceof Date && !Number.isNaN(expiry.valueOf());
  const isExpired = hasExpiry ? expiry.getTime() < Date.now() : false;

  // For known plans use normalizePlan; for custom names keep as-is.
  const purchasedPlan = PLAN_LABELS[planCode] ? normalizePlan(planCode) : planCode;
  const activePlan = isExpired ? "free" : purchasedPlan;
  const isKnownPlan = !!PLAN_LABELS[activePlan];

  return {
    code: isKnownPlan ? activePlan : activePlan,
    label: PLAN_LABELS[activePlan] ?? activePlan,
    purchased_plan: purchasedPlan,
    purchased_plan_label: PLAN_LABELS[purchasedPlan] ?? purchasedPlan,
    expires_at: source.subscription_expiry || null,
    has_expiry: hasExpiry,
    is_expired: isExpired,
    is_active: activePlan !== "free" && !isExpired,
    status: isExpired ? "expired" : activePlan === "free" ? "free" : "active"
  };
}