import ApiError from "../utils/ApiError.js";
import { pool } from "../config/db.js";
import { verifyAccessToken } from "../utils/jwt.js";
import { isBlacklisted } from "../utils/tokenBlacklist.js";

function getBearerToken(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  return token && !token.includes(" ") ? token : null;
}

/**
 * Requires an authenticated, active user whose org_role is one of the given
 * roles. Org-scoped access is bound to the JWT's `organization` claim and
 * cross-checked against the live DB row. Sets:
 *   req.user      — full user row (includes organization, org_role)
 *   req.scopeOrgId — the user's own organization_id (integer)
 *
 * @param {...string} allowedRoles e.g. requireRole("org_admin", "sub_admin")
 */
export default function requireRole(...allowedRoles) {
  return async function (req, res, next) {
    try {
      const token = getBearerToken(req);
      if (!token) throw new ApiError(401, "Unauthorized");

      const decoded = verifyAccessToken(token);
      if (decoded.type !== "user" || decoded.role !== "user") throw new ApiError(401, "Unauthorized");

      const claimedOrg = decoded.organization;
      if (!claimedOrg || typeof claimedOrg !== "number") {
        throw new ApiError(403, "Token is missing an organization claim");
      }

      if (await isBlacklisted(token)) throw new ApiError(401, "Token has been revoked");

      const [rows] = await pool.query(
        `SELECT id, uuid, full_name, email, phone, cnic, status, org_role,
                organization,
                profile_image, is_verified, created_at
         FROM users WHERE uuid=?`,
        [decoded.userId]
      );

      if (!rows.length) throw new ApiError(401, "Unauthorized");
      const user = rows[0];

      if (user.status !== "active") {
        throw new ApiError(403, "Your account has been deactivated by admin");
      }
      if (!user.organization) throw new ApiError(403, "User has no organization");
      if (user.organization !== claimedOrg) {
        throw new ApiError(403, "Token organization does not match your account");
      }
      if (!allowedRoles.includes(user.org_role)) {
        throw new ApiError(403, "You do not have permission to perform this action");
      }

      req.user = user;
      req.scopeOrgId = user.organization;
      next();
    } catch (e) {
      next(e);
    }
  };
}
