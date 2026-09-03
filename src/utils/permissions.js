import ApiError from "./ApiError.js";

/** Canonical ordered list of feature-access permissions. */
export const PERMISSION_KEYS = [
  "attendance",
  "leave",
  "payroll",
  "manage_employees",
  "generate_request",
  "approve_request",
];

// Permissions that default to granted when feature_access is absent or the key
// is omitted (keeps existing member behaviour for the pre-existing features).
const TRUE_BY_DEFAULT = new Set(["attendance", "leave", "payroll"]);

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
