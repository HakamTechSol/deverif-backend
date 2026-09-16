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

export default async function authUser(req, res, next) {
  try {
    const token = getBearerToken(req);
    if (!token) throw new ApiError(401, "Unauthorized");

    const decoded = verifyAccessToken(token);
    if (decoded.type !== "user" || decoded.role !== "user") throw new ApiError(401, "Unauthorized");

    if (await isBlacklisted(token)) throw new ApiError(401, "Token has been revoked");

    // NEW: Check if the linked employee record is inactive and the user is a platform user.
    // This blocks login for platform users whose employee status has been set to 'inactive',
    // even if the users table status is still 'active'.
    const [employees] = await pool.query(
      `SELECT is_platform_user, status FROM employees WHERE linked_user_uuid = ?`,
      [decoded.userId]
    );
    if (employees.length && employees[0].is_platform_user === 'yes' && employees[0].status === 'inactive') {
      throw new ApiError(403, "Your account has been deactivated. Contact your organization admin.");
    }

    const [rows] = await pool.query(
      `SELECT id, uuid, full_name, email, phone, cnic, status, org_role, feature_access,
              organization,
              profile_image, is_verified, created_at
       FROM users WHERE uuid=?`,
      [decoded.userId]
    );

    if (!rows.length) throw new ApiError(401, "Unauthorized");
    if (rows[0].status !== "active") {
      throw new ApiError(403, "Your account has been deactivated by admin");
    }

    req.user = rows[0];
    next();
  } catch (e) {
    next(e);
  }
}