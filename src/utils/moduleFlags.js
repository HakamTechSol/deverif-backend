/**
 * The org-scoped HR modules a plan can include or exclude.
 *
 * `subscription_plans.module_flags` is the AUTHORITATIVE include/exclude data:
 * it is what middleware/requireModuleFeature.js reads on every request to decide
 * whether a module is accessible. A plan's `features` array is free-text
 * marketing copy whose `highlight` flag is only a STYLING choice, so it must
 * never be used to decide whether a module is actually available.
 *
 * ORDER IS LOAD-BEARING. The first five are the pre-existing HR modules and are
 * kept first so that diffs against older revisions stay small; tests/assertions
 * in tests/requireModuleFeature.test.js pin the exact order. Append new modules
 * to the end of their natural group, never in the middle.
 */
export const MODULE_FEATURE_KEYS = [
  // --- Pre-existing core HR -------------------------------------------------
  "employee_management",
  "attendance_management",
  "user_management",
  "leave_management",
  "payroll_management",

  // --- Workforce lifecycle --------------------------------------------------
  "manpower_management",
  "recruitment_management",
  "onboarding_management",
  "separation_management",
  "training_management",

  // --- Performance & variable pay ------------------------------------------
  "performance_management",
  "piece_work_management",

  // --- Money ops ------------------------------------------------------------
  "expense_management",
  "travel_management",
  "asset_management",
  "helpdesk_management",

  // --- Automation & documents ----------------------------------------------
  "scheduled_reports",
  "hr_letters_management",
];

/**
 * Presentation-only grouping of MODULE_FEATURE_KEYS for the platform-admin plan
 * editor and the pricing comparison table.
 *
 * This exists purely because eighteen flat toggles on one screen is unusable.
 * It carries NO enforcement meaning: `isModuleIncluded()` below is the single
 * source of truth for access, and this grouping must never be consulted to
 * decide it. Every key listed here MUST also appear in MODULE_FEATURE_KEYS —
 * `allModulesDeclaredExactlyOnce()` is the guard, and tests/hrModuleFlags.test.js
 * asserts it.
 */
export const MODULE_GROUPS = [
  { key: "core_hr", label: "Core HR", moduleKeys: [
    "employee_management",
    "attendance_management",
    "user_management",
    "leave_management",
    "payroll_management",
  ] },
  { key: "workforce", label: "Workforce", moduleKeys: [
    "manpower_management",
    "recruitment_management",
    "onboarding_management",
    "separation_management",
    "training_management",
  ] },
  { key: "performance_pay", label: "Performance & Pay", moduleKeys: [
    "performance_management",
    "piece_work_management",
  ] },
  { key: "money_ops", label: "Money Ops", moduleKeys: [
    "expense_management",
    "travel_management",
    "asset_management",
    "helpdesk_management",
  ] },
  { key: "automation", label: "Automation", moduleKeys: [
    "scheduled_reports",
    "hr_letters_management",
  ] },
];

/**
 * Every module granted access — the value a plan gets when it is created with
 * no explicit module_flags.
 *
 * Kept as a function rather than a frozen module-level constant so callers
 * cannot mutate a shared object across requests (a caller doing
 * `DEFAULT_MODULE_FLAGS.x = false` would otherwise silently corrupt every
 * subsequent plan creation in the process).
 */
export function allModulesEnabledFlags() {
  return Object.fromEntries(MODULE_FEATURE_KEYS.map((key) => [key, true]));
}

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
 *
 * Note the ABSENCE case: a key that is simply missing from the JSON reads as
 * `undefined`, which is `!== true`, so it is BLOCKED. That is why adding a key
 * to MODULE_FEATURE_KEYS requires a backfill migration — otherwise every
 * existing plan silently locks the new module. See
 * migrations/20261101_hr_modules_backfill_module_flags.sql.
 */
export function isModuleIncluded(flags, moduleKey) {
  if (flags == null) return true;
  return flags[moduleKey] === true;
}

/**
 * Development guard: MODULE_GROUPS must partition MODULE_FEATURE_KEYS exactly —
 * every key grouped, none listed twice, none invented.
 *
 * Cheap to call and worth calling anywhere the grouping is rendered or consumed,
 * because a drifted grouping would show an admin a module that either cannot be
 * toggled (missing from every group) or is toggled twice (listed in two groups).
 */
export function allModulesDeclaredExactlyOnce() {
  const grouped = MODULE_GROUPS.flatMap((group) => group.moduleKeys);
  const known = new Set(MODULE_FEATURE_KEYS);
  return {
    ok:
      grouped.length === MODULE_FEATURE_KEYS.length &&
      new Set(grouped).size === grouped.length &&
      grouped.every((key) => known.has(key)),
    missing: MODULE_FEATURE_KEYS.filter((key) => !grouped.includes(key)),
    unknown: grouped.filter((key) => !known.has(key)),
    duplicated: grouped.filter((key, i) => grouped.indexOf(key) !== i),
  };
}