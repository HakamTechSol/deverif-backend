import ApiError from "./ApiError.js";

/**
 * Canonical ordered list of feature-access permissions.
 *
 * ORDER MATTERS only in that the pre-existing keys are pinned by tests, so new keys
 * are APPENDED rather than inserted, or those tests fail on a reorder that changed
 * nothing.
 *
 * The four HR-module keys (hr_letters, manage_assets, manage_separation,
 * approve_expenses) exist because those modules were staff-open to EVERY sub-admin
 * regardless of feature_access: the role gate said "staff" and nothing said otherwise,
 * so a sub-admin holding none of these saw every one of them. That is delegation with
 * no dial on it.
 *
 * They deliberately default to FALSE, like manage_employees and the request
 * permissions, and NOT to TRUE like attendance/leave/payroll. The TRUE_BY_DEFAULT
 * three are an employee's own self-service (clocking in, asking for leave), where
 * denying by default would lock people out of the product for no reason. These grant
 * an org_admin the ability to attest to someone's employment to a third party, spend
 * company money, or terminate an employment — none of which should be handed to
 * a sub-admin who was not explicitly given it. Least privilege, and it is the
 * difference between "sub-admins are trusted" and "sub-admins are configured".
 *
 * ONE KEY FOR RECRUITMENT, not a split between managing and conducting. The split
 * was considered and rejected, and the reasoning is recorded because the question
 * will be asked again: a `conduct_interviews` key is only meaningful if the product
 * has a role that interviews without administering hiring. It does not — the roles
 * are org_admin and sub_admin, and recruiting is one workflow. Splitting would make
 * using the module require ticking two boxes, and would add a second key to keep in
 * step across the backend, ROUTE_ACCESS and the grant form. If a "hiring manager,
 * not a recruiter" persona appears, the pattern for splitting is already here.
 */
export const PERMISSION_KEYS = [
  "attendance",
  "leave",
  "payroll",
  "manage_employees",
  "generate_request",
  "approve_request",
  "hr_letters",
  "manage_assets",
  "manage_separation",
  "approve_expenses",
  "manage_recruitment",
  "override_failed_interview",
];

/**
 * Permissions that default to granted when feature_access is absent or the key
 * is omitted (keeps existing member behaviour for the pre-existing features).
 *
 * EXPORTED so the split can be asserted directly. It is the single most consequential
 * decision in this file — it is what makes an unlisted permission mean DENIED — and a
 * reader could not otherwise check it without re-deriving the list by hand. The
 * delegated keys were added with the default off deliberately; see PERMISSION_KEYS.
 */
export const TRUE_BY_DEFAULT = new Set(["attendance", "leave", "payroll"]);

/**
 * Parse a feature_access value (JSON string, object, or null) into a flat
 * map of booleans for every permission key. Missing keys fall back to their
 * default.
 */
export function parseFeatureAccess(value) {
  let obj = value;
  if (typeof value === "string") {
    try {
      obj = JSON.parse(value);
    } catch {
      obj = {};
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) obj = {};

  const out = {};
  for (const key of PERMISSION_KEYS) {
    out[key] = obj[key] === undefined ? TRUE_BY_DEFAULT.has(key) : !!obj[key];
  }
  return out;
}

/**
 * Build a normalized feature_access object from a request body. Only explicit
 * booleans are honoured; absent keys use the default.
 */
export function normalizedFeatureAccess(body = {}) {
  const src = body.feature_access ?? {};
  const out = {};
  for (const key of PERMISSION_KEYS) {
    out[key] = typeof src[key] === "boolean" ? src[key] : TRUE_BY_DEFAULT.has(key);
  }
  return out;
}

/** True when the user is org_admin (full access) or the given permission is granted. */
export function hasPermission(user, perm) {
  if (!user) return false;
  if (user.org_role === "org_admin") return true;
  return !!parseFeatureAccess(user.feature_access)[perm];
}

/** Like hasPermission but throws a 403 when not satisfied. */
export function requirePermission(user, perm) {
  if (!user) throw new ApiError(401, "Unauthorized");
  if (hasPermission(user, perm)) return true;
  throw new ApiError(403, `You do not have the '${perm}' permission to perform this action`);
}
