import ApiError from "../utils/ApiError.js";
import { pool } from "../config/db.js";
import { ok } from "../utils/response.js";
import { comparePassword } from "../utils/password.js";
import { signAccessToken, signRefreshToken } from "../utils/jwt.js";
import { storeRefreshToken } from "../utils/refreshToken.js";

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

const GENERIC_ERROR = "Invalid credentials";

export async function login(req, res) {
  const { email, password, rememberMe } = req.body;
  if (!email || !password) throw new ApiError(400, "Email and password are required");

  const [adminRows] = await pool.query(
    "SELECT id, uuid, email, password, full_name, status, profile_image FROM admin_profiles WHERE email=?",
    [email]
  );

  if (adminRows.length) {
    const admin = adminRows[0];
    if (admin.status && admin.status !== "active") throw new ApiError(403, "Account is inactive");

    const match = await comparePassword(password, admin.password);
    if (!match) throw new ApiError(401, GENERIC_ERROR);

    const accessToken = signAccessToken({ type: "admin", userId: admin.uuid, role: "admin", email: admin.email });
    const refreshToken = signRefreshToken({ type: "admin", userId: admin.uuid, role: "admin", email: admin.email });

    const decoded = JSON.parse(Buffer.from(refreshToken.split(".")[1], "base64url").toString());
    const expiresAt = new Date(decoded.exp * 1000);
    await storeRefreshToken({ token: refreshToken, type: "admin", identifier: admin.uuid, expiresAt });

    res.cookie("dvarif_admin_refresh", refreshToken, getAdminRefreshCookieOptions());

    return ok(res, {
      token: accessToken,
      user: { uuid: admin.uuid, email: admin.email, full_name: admin.full_name, profile_image: admin.profile_image, role: "admin" },
    }, "Login successful");
  }

  const [userRows] = await pool.query(
    "SELECT id, uuid, full_name, email, password, status, profile_image FROM users WHERE email=?",
    [email]
  );

  if (!userRows.length) throw new ApiError(401, GENERIC_ERROR);

  const user = userRows[0];
  if (user.status !== "active") throw new ApiError(403, "Account is inactive");

  const match = await comparePassword(password, user.password);
  if (!match) throw new ApiError(401, GENERIC_ERROR);

  const accessToken = signAccessToken({ type: "user", userId: user.uuid, role: "user" });
  const refreshToken = signRefreshToken({ type: "user", userId: user.uuid, role: "user" }, !!rememberMe);

  const decoded = JSON.parse(Buffer.from(refreshToken.split(".")[1], "base64url").toString());
  const expiresAt = new Date(decoded.exp * 1000);
  await storeRefreshToken({ token: refreshToken, type: "user", identifier: user.uuid, expiresAt });

  res.cookie("dvarif_refresh", refreshToken, getRefreshCookieOptions(!!rememberMe));

  return ok(res, {
    token: accessToken,
    user: { uuid: user.uuid, full_name: user.full_name, email: user.email, profile_image: user.profile_image, role: "user" },
  }, "Login successful");
}
