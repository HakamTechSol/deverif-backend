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

    const [rows] = await pool.query(
      `SELECT id, uuid, full_name, email, phone, cnic, status,
              subscription_plan, subscription_expiry, organization,
              profile_image, is_verified, created_at
       FROM users WHERE uuid=?`,
      [decoded.userId]
    );

    if (!rows.length) throw new ApiError(401, "Unauthorized");
    if (rows[0].status !== "active") throw new ApiError(403, "User inactive");

    req.user = rows[0];
    next();
  } catch (e) {
    next(e);
  }
}