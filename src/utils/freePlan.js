import { pool } from "../config/db.js";
import { getFreePlan, isFreePlan } from "./subscriptionPlans.js";

/**
 * Put an organization on the Free plan.
 *
 * The Free plan is looked up dynamically (subscription_plans WHERE is_free=1),
 * never by a hardcoded id, name or price, so recreating or renaming it needs no
 * code change.
 *
 * Free has no billing cycle, so `subscription_expiry` is set to NULL: for a Free
 * org NULL means "indefinite", NOT "expired" (see isSubscriptionValid in
 * subscriptionTransition.js). Any scheduled plan change is cleared because the
 * org is now on a concrete plan.
 *
 * `executor` may be the pool or a transaction connection.
 */
export async function assignFreePlanToOrg(executor = pool, orgId) {
  const freePlan = await getFreePlan(executor);
  await executor.query(
    `UPDATE organizations
     SET subscription_status='active', subscription_start=NOW(), subscription_expiry=NULL,
         subscription_plan_id=?, pending_plan_id=NULL,
         reminder_2d_sent='no', reminder_2h_sent='no'
     WHERE id=?`,
    [freePlan.id, orgId]
  );
  return freePlan;
}

/**
 * Columns to set on a brand-new `INSERT INTO organizations` so the org is on a
 * real plan from the very first moment -- there is no window in which it exists
 * with a NULL subscription_plan_id or status='none'.
 */
export function freePlanInsertColumns(freePlan) {
  if (!isFreePlan(freePlan)) {
    throw new Error("freePlanInsertColumns requires the plan flagged is_free=1");
  }
  return {
    subscription_plan_id: freePlan.id,
    subscription_status: "active",
    // Free never expires, so there is no billing period to start.
    subscription_expiry: null,
  };
}
