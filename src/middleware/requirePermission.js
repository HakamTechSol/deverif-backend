import ApiError from "../utils/ApiError.js";
import { hasPermission } from "../utils/permissions.js";

/**
 * Requires a feature_access permission, as route middleware.
 *
 * WHY THIS EXISTS. Until now a permission was only ever checked INSIDE a controller
 * (`requirePermission(req.user, "approve_request")` in verification.controller.js is
 * the one precedent). That works, but it puts the access rule a long way from the
 * route declaration, so reading the routes tells you the ROLE and not whether the
 * module is delegated. Every new HR module then shipped staff-open to any sub-admin
 * regardless of feature_access — which is exactly the "sub-admin can see everything
 * org_admin can" problem this is meant to end.
 *
 * The rule now lives where the route lives, so `router.get("/hr-letters",
 * hrLettersMgmt, ...)` can be read and the answer is in the same line.
 *
 * MUST RUN AFTER requireRole() or authUser(), both of which populate req.user.
 * Placed before, `req.user` is undefined and every request is denied — which fails
 * loudly, at least, but for a confusing reason.
 *
 * org_admin ALWAYS passes: hasPermission() short-circuits on the role, matching the
 * rule that an org_admin is fully entitled to the modules their plan includes.
 */
export default function requirePermission(permission) {
  return async function (req, res, next) {
    try {
      if (!req.user) throw new ApiError(401, "Unauthorized");
      if (!hasPermission(req.user, permission)) {
        // Names the missing permission, because a sub-admin told "forbidden" with no
        // reason cannot tell whether they need the permission or a different account.
        throw new ApiError(
          403,
          `You do not have the '${permission}' permission to access this module`,
        );
      }
      next();
    } catch (e) {
      next(e);
    }
  };
}