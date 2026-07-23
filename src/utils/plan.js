const PLAN_LABELS = {
  free: "Free",
  basic: "Basic",
  premium: "Premium"
};

export function normalizePlan(plan) {
  return ["free", "basic", "premium"].includes(plan) ? plan : "free";
}

export function getPlanSummary(user = {}) {
  const purchasedPlan = normalizePlan(user.subscription_plan);
  const expiry = user.subscription_expiry ? new Date(user.subscription_expiry) : null;
  const hasExpiry = expiry instanceof Date && !Number.isNaN(expiry.valueOf());
  const isExpired = hasExpiry ? expiry.getTime() < Date.now() : false;
  const activePlan = isExpired ? "free" : purchasedPlan;

  return {
    code: activePlan,
    label: PLAN_LABELS[activePlan],
    purchased_plan: purchasedPlan,
    purchased_plan_label: PLAN_LABELS[purchasedPlan],
    expires_at: user.subscription_expiry || null,
    has_expiry: hasExpiry,
    is_expired: isExpired,
    is_active: activePlan !== "free" && !isExpired,
    status: isExpired ? "expired" : activePlan === "free" ? "free" : "active"
  };
}