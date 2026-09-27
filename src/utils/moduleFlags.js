/**
 * The org-scoped HR modules a plan can include or exclude.
 *
 * `subscription_plans.module_flags` is the AUTHORITATIVE include/exclude data:
 * it is what middleware/requireModuleFeature.js reads on every request to decide
 * whether a module is accessible. A plan's `features` array is free-text
 * marketing copy whose `highlight` flag is only a STYLING choice, so it must
 * never be used to decide whether a module is actually available.
 */
export const MODULE_FEATURE_KEYS = [
  "employee_management",
  "attendance_management",
  "user_management",
  "leave_management",
  "payroll_management",
];

/**
 * Parse a `module_flags` column value.
 *
 * Returns:
 *   null  -> the plan has no flags at all (legacy plan). requireModuleFeature
 *            treats this as "nothing is restricted", so callers must not render
 *            these modules as excluded.
 *   {}    -> flags are present but empty; every module is then blocked by the
 *            `flags[key] !== true` check, so an empty object is NOT the same as null.
 *   object-> parsed flags.
 */
export function parseModuleFlags(raw) {
  if (raw == null) return null;
  if (typeof raw === "object") return raw;
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Is `moduleKey` actually usable on a plan with these flags?
 *
 * Mirrors the enforcement in requireModuleFeature.js exactly:
 *   - no flags (null)  -> unrestricted, so included
 *   - flags[key] !== true -> blocked
 */
export function isModuleIncluded(flags, moduleKey) {
  if (flags == null) return true;
  return flags[moduleKey] === true;
}
