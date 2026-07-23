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

export default async function authAdminEnv(req, res, next) {
  try {
    const token = getBearerToken(req);
    if (!token) throw new ApiError(401, "Unauthorized");

    const decoded = verifyAccessToken(token);
    if (decoded.type !== "admin" || decoded.role !== "admin") throw new ApiError(401, "Unauthorized");

    if (await isBlacklisted(token)) throw new ApiError(401, "Token has been revoked");

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
    next();
  } catch (e) {
    next(e);
  }
}
