import ApiError from "../utils/ApiError.js";
import { pool } from "../config/db.js";
import requireActiveSubscription from "./requireActiveSubscription.js";

export const MODULE_FEATURE_KEYS = [
  "employee_management",
  "attendance_management",
  "user_management",
  "leave_management",
  "payroll_management",
];

export const FEATURE_NOT_INCLUDED_MESSAGE =
  "This feature is not included in your current plan. Contact your admin to upgrade.";

export const NO_ACTIVE_SUBSCRIPTION_MESSAGE =
  "Your organization does not have an active subscription. Please subscribe to use these modules.";

/**
 * Freshly read (never cached) the org's CURRENT plan and its flags.
 * Returns { active: boolean, flags: object|null }.
 *   - active=false  → no active subscription (org row missing / status != active)
 *   - flags=null    → active subscription, but the plan has no module_flags
 *                     (legacy plan) → everything stays unrestricted
 *   - flags=object  → parsed subscription_plans.module_flags
 */
export async function resolveOrgPlanFlags(orgId) {
  const [[row]] = await pool.query(
    `SELECT o.subscription_status AS subscription_status,
            sp.module_flags AS module_flags
     FROM organizations o
     LEFT JOIN subscription_plans sp ON sp.id = o.subscription_plan_id
     WHERE o.id = ?`,
    [orgId]
  );
  if (!row || row.subscription_status !== "active") {
    return { active: false, flags: null };
  }
  let flags = row.module_flags;
  if (flags == null) return { active: true, flags: null };
  if (typeof flags === "string") {
    try {
      flags = JSON.parse(flags);
    } catch {
      flags = {};
    }
  }
  return { active: true, flags };
}

/**
 * Programmatic gate (usable inside controllers, not only as route middleware).
 * Throws the same 403s the middleware returns:
 *   - no active subscription  → standard "subscription not active" message
 *   - plan flag false         → "not included in your current plan"
 * Silently passes for legacy plans with no module_flags.
 */
export async function assertModuleFeature(moduleKey, orgId) {
  const { active, flags } = await resolveOrgPlanFlags(orgId);
  if (!active) throw new ApiError(403, NO_ACTIVE_SUBSCRIPTION_MESSAGE);
  if (flags == null) return;
  if (flags[moduleKey] !== true) throw new ApiError(403, FEATURE_NOT_INCLUDED_MESSAGE);
}

/**
 * Gate a route behind a specific HR module being included in the organization's
 * CURRENT ACTIVE plan (subscription_plans.module_flags).
 *
 * The plan is read from the LIVE database on every single request — never from
 * a cached JWT claim, memory, or session — so when an admin toggles a plan's
 * flags the change takes effect on the very next request with zero propagation
 * delay (no re-login required).
 *
 * MUST be placed after requireRole(...) / authUser(...) so that req.scopeOrgId
 * (or req.user.organization) is set.
 *
 * Subscription expiry edge: when the organization has NO active subscription at
 * all, this middleware delegates to the EXISTING requireActiveSubscription lock
 * (no separate error path): reads stay available, writes return the standard
 * "subscription not active" 403. Only when a plan IS active do the plan's
 * module_flags decide access.
 *
 * @param {"employee_management"|"attendance_management"|"user_management"|"leave_management"|"payroll_management"} moduleKey
 */
export default function requireModuleFeature(moduleKey) {
  if (!MODULE_FEATURE_KEYS.includes(moduleKey)) {
    throw new Error(`Invalid module feature key: "${moduleKey}". Expected one of: ${MODULE_FEATURE_KEYS.join(", ")}`);
  }

  return async function (req, res, next) {
    try {
      const orgId = req.scopeOrgId ?? req.user?.organization;
      if (!orgId) throw new ApiError(403, "User has no organization");

      const { active, flags } = await resolveOrgPlanFlags(orgId);

      // No active subscription at all → reuse the existing subscription lock
      // behavior exactly as built (real-time read, read-only for GET).
      if (!active) {
        return requireActiveSubscription(req, res, next);
      }

      // Legacy plans without module_flags: nothing is restricted.
      if (flags == null) return next();

      if (flags[moduleKey] !== true) {
        throw new ApiError(403, FEATURE_NOT_INCLUDED_MESSAGE);
      }

      next();
    } catch (e) {
      next(e);
    }
  };
}