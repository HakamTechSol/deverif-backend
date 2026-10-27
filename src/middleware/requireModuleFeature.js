import ApiError, { ERROR_CODES } from "../utils/ApiError.js";
import { pool } from "../config/db.js";
import requireActiveSubscription from "./requireActiveSubscription.js";
import { MODULE_FEATURE_KEYS, parseModuleFlags, isModuleIncluded } from "../utils/moduleFlags.js";

// Re-exported so existing importers keep working; the canonical definition now
// lives in utils/moduleFlags.js alongside parseModuleFlags().
export { MODULE_FEATURE_KEYS };

export const FEATURE_NOT_INCLUDED_MESSAGE =
  "This feature is not included in your current plan. Upgrade your plan to unlock it.";

export const NO_ACTIVE_SUBSCRIPTION_MESSAGE =
  "Your organization does not have an active subscription. Please subscribe to use these modules.";

/**
 * Human labels used in the UPGRADE_REQUIRED response, keyed by module.
 *
 * This string is user-facing: it becomes "Upgrade your plan to access X." and
 * also travels to the client as `module_label`, which the frontend renders in
 * the locked-module card. A missing key here is NOT a no-op — `upgradeRequiredError`
 * falls back to echoing the raw snake_case key, so a module that ships without a
 * label shows the user "recruitment_management". tests/hrModuleFlags.test.js
 * asserts every MODULE_FEATURE_KEYS entry has one.
 */
const MODULE_LABELS = {
  // --- Pre-existing core HR ---
  employee_management: "Employee Management",
  attendance_management: "Attendance Management",
  user_management: "User Management",
  leave_management: "Leave Management",
  payroll_management: "Payroll Management",

  // --- Workforce lifecycle ---
  manpower_management: "Manpower Management",
  recruitment_management: "Recruitment Management",
  onboarding_management: "Onboarding Management",
  separation_management: "Separation Management",
  training_management: "Training Management",

  // --- Performance & variable pay ---
  performance_management: "Performance Management",
  piece_work_management: "Piece Work Management",

  // --- Money ops ---
  expense_management: "Expense Management",
  travel_management: "Travel Management",
  asset_management: "Asset Management",
  helpdesk_management: "Help Desk Management",

  // --- Automation & documents ---
  scheduled_reports: "Scheduled Reports",
  hr_letters_management: "HR Letters Management",
};

/**
 * Build the distinctive "your plan doesn't include this module" error.
 *
 * The `code` and `module` fields are the whole point: without them this is the
 * same generic 403 as a dead subscription, and the frontend renders the same
 * blanket "your subscription is not active" banner for an organization that in
 * fact has a perfectly valid plan.
 */
export function upgradeRequiredError(moduleKey) {
  const label = MODULE_LABELS[moduleKey] || moduleKey;
  return new ApiError(403, `Upgrade your plan to access ${label}.`, {
    code: ERROR_CODES.UPGRADE_REQUIRED,
    module: moduleKey,
    module_label: label,
    // Tells the client it is safe to render an "upgrade" call to action, and
    // that retrying the request will never help.
    can_retry: false,
  });
}

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
  return { active: true, flags: parseModuleFlags(flags) };
}

/**
 * Programmatic gate (usable inside controllers, not only as route middleware).
 * Throws the same 403s the middleware returns:
 *   - no active subscription  -> SUBSCRIPTION_INACTIVE
 *   - plan flag false         -> UPGRADE_REQUIRED (with `module`)
 * Silently passes for legacy plans with no module_flags.
 */
export async function assertModuleFeature(moduleKey, orgId) {
  const { active, flags } = await resolveOrgPlanFlags(orgId);

  if (!active) {
    throw new ApiError(403, NO_ACTIVE_SUBSCRIPTION_MESSAGE, {
      code: ERROR_CODES.SUBSCRIPTION_INACTIVE,
    });
  }
  if (flags == null) return;
  if (!isModuleIncluded(flags, moduleKey)) throw upgradeRequiredError(moduleKey);
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
 * @param {string} moduleKey One of MODULE_FEATURE_KEYS (utils/moduleFlags.js). The
 *   factory throws synchronously on anything else, so a typo fails at route
 *   registration time rather than silently locking an organization out of a
 *   module that does not exist.
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

      if (!isModuleIncluded(flags, moduleKey)) {
        // Distinct from an inactive subscription on purpose: the org IS
        // subscribed, this plan just does not include this module.
        throw upgradeRequiredError(moduleKey);
      }

      next();
    } catch (e) {
      next(e);
    }
  };
}