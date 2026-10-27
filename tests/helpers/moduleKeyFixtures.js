/**
 * Shared module-key fixtures for the plan-gating tests.
 *
 * This file exists to kill a specific recurring failure: every time a module was
 * added to MODULE_FEATURE_KEYS, each test file carried its OWN hardcoded copy of
 * the key list, and the copies drifted. tests/requireModuleFeature.test.js
 * asserted an exact five-element array while
 * tests/freePlanModuleGating.test.js iterated a separate five-element const, so
 * adding a sixth module broke the first and silently left the second untested.
 *
 * Nothing here is exported from `src/`. The canonical list lives in
 * utils/moduleFlags.js; this only mirrors it for assertions, and
 * tests/hrModuleFlags.test.js asserts the mirror still matches the source of
 * truth. Delete this indirection the moment the tests stop caring about the exact
 * module inventory.
 */

/** The five modules that shipped before the HR expansion (2026-09-17). */
export const ORIGINAL_MODULE_KEYS = [
  "employee_management",
  "attendance_management",
  "user_management",
  "leave_management",
  "payroll_management",
];

/**
 * The thirteen modules added by the Step 0 HR expansion (2026-11-01). Split out
 * so tests can assert specifically that the NEW keys are gated and labelled,
 * which is where the real regression risk lives.
 */
export const NEW_MODULE_KEYS = [
  "manpower_management",
  "recruitment_management",
  "onboarding_management",
  "separation_management",
  "training_management",
  "performance_management",
  "piece_work_management",
  "expense_management",
  "travel_management",
  "asset_management",
  "helpdesk_management",
  "scheduled_reports",
  "hr_letters_management",
];

/** Every module key, originals first — mirrors MODULE_FEATURE_KEYS exactly. */
export const ALL_MODULE_KEYS = [...ORIGINAL_MODULE_KEYS, ...NEW_MODULE_KEYS];

/** Human label for each key, mirroring MODULE_LABELS in requireModuleFeature.js. */
export const MODULE_LABELS = {
  employee_management: "Employee Management",
  attendance_management: "Attendance Management",
  user_management: "User Management",
  leave_management: "Leave Management",
  payroll_management: "Payroll Management",
  manpower_management: "Manpower Management",
  recruitment_management: "Recruitment Management",
  onboarding_management: "Onboarding Management",
  separation_management: "Separation Management",
  training_management: "Training Management",
  performance_management: "Performance Management",
  piece_work_management: "Piece Work Management",
  expense_management: "Expense Management",
  travel_management: "Travel Management",
  asset_management: "Asset Management",
  helpdesk_management: "Help Desk Management",
  scheduled_reports: "Scheduled Reports",
  hr_letters_management: "HR Letters Management",
};

/** `module_flags` for a plan that grants everything (post-backfill shape). */
export function allEnabledFlags() {
  return Object.fromEntries(ALL_MODULE_KEYS.map((key) => [key, true]));
}

/**
 * `module_flags` exactly as stored by a plan created BEFORE the Step 0 backfill
 * — only the original five keys. Used to pin why
 * migrations/20261101_hr_modules_backfill_module_flags.sql is mandatory rather
 * than cosmetic.
 */
export function legacyPreBackfillFlags() {
  return Object.fromEntries(ORIGINAL_MODULE_KEYS.map((key) => [key, true]));
}

/** The seeded Free plan: Employee Management is the only included module. */
export function freePlanFlags() {
  return { employee_management: true };
}