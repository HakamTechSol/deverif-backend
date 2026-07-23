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

export default async function authAny(req, res, next) {
  try {
    const token = getBearerToken(req);
    if (!token) throw new ApiError(401, "Unauthorized");

    const decoded = verifyAccessToken(token);
    if (await isBlacklisted(token)) throw new ApiError(401, "Token has been revoked");

    if (decoded.type === "user" && decoded.role === "user") {
      const [rows] = await pool.query(
        `SELECT id, uuid, full_name, email, phone, cnic, status,
                subscription_plan, subscription_expiry, organization,
                profile_image, is_verified, created_at
         FROM users WHERE uuid = ?`,
        [decoded.userId]
      );

      if (!rows.length) throw new ApiError(401, "Unauthorized");
      if (rows[0].status !== "active") throw new ApiError(403, "User inactive");

      req.user = rows[0];
      return next();
    }

    if (decoded.type === "admin" && decoded.role === "admin") {
      const [rows] = await pool.query(
        `SELECT id, uuid, email, full_name, phone, profile_image, status
         FROM admin_profiles WHERE uuid=?`,
        [decoded.userId]
      );

      if (!rows.length) throw new ApiError(401, "Unauthorized");

      if (rows[0].status && rows[0].status !== "active") {
        throw new ApiError(403, "Admin account is inactive");
      }

      req.admin = rows[0];
      return next();
    }

    throw new ApiError(401, "Unauthorized");
  } catch (e) {
    next(e);
  }
}