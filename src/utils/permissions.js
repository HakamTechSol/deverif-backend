import ApiError from "./ApiError.js";

/**
 * Canonical ordered list of feature-access permissions.
 *
 * ORDER MATTERS only in that the pre-existing keys are pinned by tests, so new keys
 * are APPENDED rather than inserted, or those tests fail on a reorder that changed
 * nothing.
 *
 * The HR-module keys (hr_letters, manage_assets, manage_separation,
 * approve_expenses) and the separate create_expenses capability exist because
 * those modules were staff-open to EVERY sub-admin
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
  "create_expenses",
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
/**
 * Granular action permissions. These are deliberately separate from the legacy
 * feature keys above: existing feature_access rows remain readable and unchanged,
 * while new routes can require an exact module.action capability.
 */
export const GRANULAR_PERMISSION_CATALOG = Object.freeze({
  employees: ["view", "create", "edit", "archive", "manage_departments", "manage_designations"],
  document_verification: ["view_requests", "generate_request", "edit_draft", "approve", "reject"],
  attendance: ["view", "manual_entry", "correct_check_in_out", "manage_ips"],
  leave_management: ["view", "approve", "reject", "allocate_balance", "manage_leave_types"],
  payroll: ["view", "generate", "manage_settings", "manage_employee_components", "adjust_salary"],
  expenses: ["view", "create_own", "approve_employee", "process_payment"],
  hr_letters: ["view", "create_draft", "edit_draft", "issue", "revoke", "manage_templates"],
  assets: ["view", "create", "edit", "assign", "return", "retire", "manage_categories"],
  offboarding: ["view", "initiate", "manage_checklist", "draft_settlement", "approve_settlement", "complete_exit"],
  recruitment: ["view", "create_job", "edit_job", "manage_candidates", "schedule_interview", "record_feedback", "manage_offers", "hire"],
  reports: ["view", "export", "view_org_analytics"],
  organization_settings: ["view", "edit"],
});

export const DATA_SCOPES = Object.freeze(["own_records", "entire_organization"]);

const GRANULAR_KEYS = new Set(
  Object.entries(GRANULAR_PERMISSION_CATALOG).flatMap(([module, actions]) =>
    actions.map((action) => `${module}.${action}`),
  ),
);

const ACTION_REQUIRES_VIEW = Object.freeze({
  "employees.create": "employees.view",
  "document_verification.generate_request": "document_verification.view_requests",
  "leave_management.allocate_balance": "leave_management.view",
  "payroll.generate": "payroll.view",
  "payroll.manage_settings": "payroll.view",
  "payroll.manage_employee_components": "payroll.view",
  "payroll.adjust_salary": "payroll.view",
  "expenses.create_own": "expenses.view",
  "hr_letters.create_draft": "hr_letters.view",
  "hr_letters.edit_draft": "hr_letters.view",
  "hr_letters.issue": "hr_letters.view",
  "hr_letters.revoke": "hr_letters.view",
  "hr_letters.manage_templates": "hr_letters.view",
  "assets.create": "assets.view",
  "recruitment.create_job": "recruitment.view",
});

// A legacy module grant keeps its former broad access until an Org Admin replaces
// it with explicit granular grants. New granular permissions always default deny.
const LEGACY_GRANT_MAP = Object.freeze({
  "attendance.view": "attendance",
  "attendance.manual_entry": "attendance",
  "attendance.correct_check_in_out": "attendance",
  "attendance.manage_ips": "attendance",
  "leave_management.view": "leave",
  "leave_management.approve": "leave",
  "leave_management.reject": "leave",
  "leave_management.allocate_balance": "leave",
  "leave_management.manage_leave_types": "leave",
  "payroll.view": "payroll",
  "payroll.generate": "payroll",
  "payroll.manage_settings": "payroll",
  "payroll.manage_employee_components": "payroll",
  "payroll.adjust_salary": "payroll",
  "employees.view": "manage_employees",
  "employees.create": "manage_employees",
  "employees.edit": "manage_employees",
  "employees.archive": "manage_employees",
  "employees.manage_departments": "manage_employees",
  "employees.manage_designations": "manage_employees",
  "document_verification.view_requests": "approve_request",
  "document_verification.generate_request": "generate_request",
  "document_verification.edit_draft": "generate_request",
  "document_verification.approve": "approve_request",
  "document_verification.reject": "approve_request",
  "expenses.view": "approve_expenses",
  "expenses.create_own": "create_expenses",
  "expenses.approve_employee": "approve_expenses",
  "expenses.process_payment": "approve_expenses",
  "expenses.approve_employee": "approve_expenses",
  "hr_letters.view": "hr_letters",
  "hr_letters.create_draft": "hr_letters",
  "hr_letters.edit_draft": "hr_letters",
  "hr_letters.issue": "hr_letters",
  "hr_letters.revoke": "hr_letters",
  "hr_letters.manage_templates": "hr_letters",
  "assets.view": "manage_assets",
  "assets.create": "manage_assets",
  "assets.edit": "manage_assets",
  "assets.assign": "manage_assets",
  "assets.return": "manage_assets",
  "assets.retire": "manage_assets",
  "assets.manage_categories": "manage_assets",
  "offboarding.view": "manage_separation",
  "offboarding.initiate": "manage_separation",
  "offboarding.manage_checklist": "manage_separation",
  "offboarding.draft_settlement": "manage_separation",
  "offboarding.approve_settlement": "manage_separation",
  "offboarding.complete_exit": "manage_separation",
  "recruitment.view": "manage_recruitment",
  "recruitment.create_job": "manage_recruitment",
  "recruitment.edit_job": "manage_recruitment",
  "recruitment.manage_candidates": "manage_recruitment",
  "recruitment.schedule_interview": "manage_recruitment",
  "recruitment.record_feedback": "manage_recruitment",
  "recruitment.manage_offers": "manage_recruitment",
  "recruitment.hire": "manage_recruitment",
});

/** Read granular grants from the JSON feature_access column; absent/malformed = deny. */
export function parseGranularPermissions(value) {
  let obj = value;
  if (typeof value === "string") {
    try { obj = JSON.parse(value); } catch { obj = {}; }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) obj = {};
  const raw = obj.granular_permissions;
  const grants = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const key of GRANULAR_KEYS) out[key] = grants[key] === true;
  for (const [action, view] of Object.entries(ACTION_REQUIRES_VIEW)) {
    if (out[action]) out[view] = true;
  }
  return out;
}

/**
 * Build a normalized feature_access object while retaining old flat booleans.
 * Scopes are stored separately from action grants and default to own records.
 */
export function normalizedFeatureAccess(body = {}) {
  const src = body.feature_access ?? {};
  const out = {};
  for (const key of PERMISSION_KEYS) {
    out[key] = typeof src[key] === "boolean" ? src[key] : TRUE_BY_DEFAULT.has(key);
  }
  const supplied = body.granular_permissions ?? src.granular_permissions;
  if (supplied && typeof supplied === "object" && !Array.isArray(supplied)) {
    out.granular_permissions = parseGranularPermissions({ granular_permissions: supplied });
  }
  const scopes = body.data_scopes ?? src.data_scopes;
  if (scopes && typeof scopes === "object" && !Array.isArray(scopes)) {
    out.data_scopes = {};
    for (const module of Object.keys(GRANULAR_PERMISSION_CATALOG)) {
      out.data_scopes[module] = DATA_SCOPES.includes(scopes[module]) ? scopes[module] : "own_records";
    }
  }
  return out;
}

/** True when the user is org_admin (full access) or the given permission is granted. */
export function hasPermission(user, perm) {
  if (!user) return false;
  if (user.org_role === "org_admin") return true;
  if (GRANULAR_KEYS.has(perm)) {
    let raw = user.feature_access;
    if (typeof raw === "string") {
      try { raw = JSON.parse(raw); } catch { raw = {}; }
    }
    const hasGranularConfig =
      raw && typeof raw === "object" && !Array.isArray(raw) &&
      raw.granular_permissions && typeof raw.granular_permissions === "object" &&
      !Array.isArray(raw.granular_permissions);
    // Once an admin has saved a granular matrix, it is authoritative: an
    // unchecked action must override any legacy broad module grant.
    if (hasGranularConfig) return parseGranularPermissions(raw)[perm] === true;
    const legacyKey = LEGACY_GRANT_MAP[perm];
    return legacyKey ? !!parseFeatureAccess(raw)[legacyKey] : false;
  }
  return !!parseFeatureAccess(user.feature_access)[perm];
}

/** Like hasPermission but throws a 403 when not satisfied. */
export function requirePermission(user, perm) {
  if (!user) throw new ApiError(401, "Unauthorized");
  if (hasPermission(user, perm)) return true;
  throw new ApiError(403, `You do not have the '${perm}' permission to perform this action`);
}
