import ApiError from "../utils/ApiError.js";
import { ok } from "../utils/response.js";
import { signAccessToken, verifyRefreshToken as verifyRefreshJWT } from "../utils/jwt.js";
import { signRefreshToken } from "../utils/jwt.js";
import { verifyRefreshToken, revokeRefreshToken, storeRefreshToken } from "../utils/refreshToken.js";
import { pool } from "../config/db.js";

function getRefreshCookieOptions(rememberMe) {
  const isProd = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    path: "/api/v1",
    maxAge: rememberMe ? 30 * 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000,
  };
}

function getAdminRefreshCookieOptions() {
  const isProd = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    path: "/api/v1",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  };
}

export async function refreshAccessToken(req, res) {
  const refreshTokenValue = req.cookies?.dverif_refresh || req.cookies?.dverif_admin_refresh;

  if (!refreshTokenValue) {
    throw new ApiError(401, "Please sign in again.");
  }

  const isUserRefresh = !!req.cookies?.dverif_refresh;
  const type = isUserRefresh ? "user" : "admin";
  const cookieName = isUserRefresh ? "dverif_refresh" : "dverif_admin_refresh";

  let decoded;
  try {
    decoded = verifyRefreshJWT(refreshTokenValue);
  } catch {
    res.clearCookie(cookieName, { path: "/api/v1" });
    throw new ApiError(401, "Please sign in again.");
  }

  if (decoded.type !== type || decoded.role !== type) {
res.clearCookie(cookieName, { path: "/api/v1" });
    throw new ApiError(401, "Please sign in again.");
  }

  const dbRecord = await verifyRefreshToken({ token: refreshTokenValue, type });
  if (!dbRecord) {
    res.clearCookie(cookieName, { path: "/api/v1" });
    throw new ApiError(401, "Refresh token has been revoked. Please log in again.");
  }

  await revokeRefreshToken(refreshTokenValue);

  if (type === "user") {
    const [rows] = await pool.query(
      "SELECT id, uuid, status, organization, org_role FROM users WHERE uuid=?",
      [decoded.userId]
    );
    if (!rows.length || rows[0].status !== "active") {
      throw new ApiError(401, "User account is no longer active");
    }

    const rememberMe = (decoded.exp - decoded.iat) > 8 * 24 * 60 * 60;

    const newAccessToken = signAccessToken({ type: "user", userId: decoded.userId, role: "user", organization: rows[0].organization, org_role: rows[0].org_role });
    const newRefreshToken = signRefreshToken({ type: "user", userId: decoded.userId, role: "user" }, rememberMe);

    const refreshDecoded = JSON.parse(Buffer.from(newRefreshToken.split(".")[1], "base64url").toString());
    const expiresAt = new Date(refreshDecoded.exp * 1000);
    await storeRefreshToken({ token: newRefreshToken, type: "user", identifier: decoded.userId, expiresAt });

    res.cookie(cookieName, newRefreshToken, getRefreshCookieOptions(rememberMe));
    return ok(res, { accessToken: newAccessToken }, "Token refreshed");
  } else {
    const [rows] = await pool.query(
      "SELECT id, uuid, email, full_name, status FROM admin_profiles WHERE uuid=?",
      [decoded.userId]
    );
    if (!rows.length) {
      throw new ApiError(401, "Admin account is no longer active");
    }
    if (rows[0].status && rows[0].status !== "active") {
      throw new ApiError(401, "Admin account is no longer active");
    }

    const admin = rows[0];
    const newAccessToken = signAccessToken({ type: "admin", userId: admin.uuid, role: "admin", email: admin.email });
    const newRefreshToken = signRefreshToken({ type: "admin", userId: admin.uuid, role: "admin", email: admin.email });

    const refreshDecoded = JSON.parse(Buffer.from(newRefreshToken.split(".")[1], "base64url").toString());
    const expiresAt = new Date(refreshDecoded.exp * 1000);
    await storeRefreshToken({ token: newRefreshToken, type: "admin", identifier: admin.uuid, expiresAt });

    res.cookie(cookieName, newRefreshToken, getAdminRefreshCookieOptions());
    return ok(res, { accessToken: newAccessToken }, "Token refreshed");
  }
}
