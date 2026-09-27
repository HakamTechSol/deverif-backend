import ApiError, { ERROR_CODES } from "../utils/ApiError.js";
import { pool } from "../config/db.js";
import { isSubscriptionValid } from "../utils/subscriptionTransition.js";

/**
 * Safety-net gate: confirms the organization holds SOME valid subscription.
 *
 * Every organization is always on a real plan (Free by default, and Free counts
 * as valid), so on a healthy database this should essentially never block
 * anyone. That is intentional. It exists to catch the genuine failure modes:
 * a corrupted planless/inactive row, or a paid plan that has lapsed and whose
 * lifecycle fallback has not run yet. In those cases writes are refused and
 * reads keep working.
 *
 * Per-module access is a SEPARATE concern handled by requireModuleFeature, which
 * answers "your plan does not include Payroll" with a distinct UPGRADE_REQUIRED
 * code rather than this blanket SUBSCRIPTION_INACTIVE one.
 */
const INACTIVE_MESSAGE =
  "Your organization does not have an active subscription. Please subscribe to use these modules.";

export default async function requireActiveSubscription(req, res, next) {
  try {
    if (req.method === "GET") return next();
    if (req.method === "OPTIONS") return next();

    const orgId = req.scopeOrgId ?? req.user?.organization;
    if (!orgId) throw new ApiError(403, "User has no organization", { code: ERROR_CODES.SUBSCRIPTION_INACTIVE });

    const [[org]] = await pool.query(
      `SELECT o.subscription_status, o.subscription_expiry,
              o.subscription_plan_id, sp.is_free
       FROM organizations o
       LEFT JOIN subscription_plans sp ON sp.id = o.subscription_plan_id
       WHERE o.id=?`,
      [orgId]
    );
    if (!org) {
      throw new ApiError(403, INACTIVE_MESSAGE, { code: ERROR_CODES.SUBSCRIPTION_INACTIVE });
    }

    // isSubscriptionValid reads the plan's is_free off `current_plan`: an
    // active Free org with a NULL expiry is valid, a paid plan past its expiry
    // is not.
    if (!isSubscriptionValid({ ...org, current_plan: { is_free: org.is_free } })) {
      throw new ApiError(403, INACTIVE_MESSAGE, { code: ERROR_CODES.SUBSCRIPTION_INACTIVE });
    }
    next();
  } catch (e) {
    next(e);
  }
}
