import ApiError from "./ApiError.js";

/** The three fixed organization roles. */
export const ROLE_ORG_ADMIN = "org_admin";
export const ROLE_SUB_ADMIN = "sub_admin";
export const ROLE_EMPLOYEE = "employee";

/** All roles that operate on the rest of the org (everything but self-service). */
export const STAFF_ROLES = [ROLE_ORG_ADMIN, ROLE_SUB_ADMIN];

/** True when the user's org_role is one of the given roles. */
export function hasRole(user, roles) {
  if (!user) return false;
  return roles.includes(user.org_role);
}

/** Like hasRole but throws 403 when the user's role is not allowed. */
export function assertRole(user, roles) {
  if (!user) throw new ApiError(401, "Unauthorized");
  if (roles.includes(user.org_role)) return true;
  throw new ApiError(403, "You do not have permission to perform this action");
}
