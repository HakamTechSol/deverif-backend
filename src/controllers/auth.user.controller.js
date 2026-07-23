import crypto from "crypto";
import ApiError from "../utils/ApiError.js";
import { pool } from "../config/db.js";
import { ok } from "../utils/response.js";
import { sendPasswordResetEmail } from "../utils/mailer.js";
import { signAccessToken } from "../utils/jwt.js";
import {
  validatePasswordPolicy,
  hashPassword,
  comparePassword,
} from "../utils/password.js";
import { blacklistToken } from "../utils/tokenBlacklist.js";
import { signRefreshToken } from "../utils/jwt.js";
import { storeRefreshToken, revokeRefreshToken as revokeRefreshRecord, revokeAllRefreshTokens } from "../utils/refreshToken.js";

function signUserToken(uuid) {
  return signAccessToken({ type: "user", userId: uuid, role: "user" });
}

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

export async function loginUser(req, res) {
  const { email, password, rememberMe } = req.body;
  if (!email || !password) throw new ApiError(400, "Email and password are required");

  const [rows] = await pool.query(
    "SELECT id, uuid, full_name, email, password, status FROM users WHERE email=?",
    [email]
  );
  if (!rows.length) throw new ApiError(401, "Invalid credentials");

  const user = rows[0];
  if (user.status !== "active") throw new ApiError(403, "User inactive");

  const match = await comparePassword(password, user.password);
  if (!match) throw new ApiError(401, "Invalid credentials");

  const accessToken = signAccessToken({ type: "user", userId: user.uuid, role: "user" });
  const refreshToken = signRefreshToken({ type: "user", userId: user.uuid, role: "user" }, !!rememberMe);

  const decoded = JSON.parse(Buffer.from(refreshToken.split(".")[1], "base64url").toString());
  const expiresAt = new Date(decoded.exp * 1000);
  await storeRefreshToken({ token: refreshToken, type: "user", identifier: user.uuid, expiresAt });

  res.cookie("dvarif_refresh", refreshToken, getRefreshCookieOptions(!!rememberMe));

  return ok(res, { token: accessToken, user: { uuid: user.uuid, full_name: user.full_name, email: user.email } }, "Login successful");
}

export async function forgotPassword(req, res) {
  const { email } = req.body;
  if (!email) throw new ApiError(400, "Email is required");

  const [rows] = await pool.query(
    "SELECT id, uuid, email, status FROM users WHERE email=?",
    [email]
  );

  if (!rows.length || rows[0].status !== "active") {
    return ok(res, {}, "If an account exists with this email, a reset link has been generated");
  }

  const user = rows[0];

  // Invalidate all previous unused tokens for this user
  await pool.query(
    "UPDATE password_reset_tokens SET used_at=NOW() WHERE user_uuid=? AND used_at IS NULL",
    [user.uuid]
  );

  // Generate a random token, store only its SHA-256 hash
  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  const expiresIn = parseInt(process.env.RESET_PASSWORD_EXPIRES_IN_MINUTES || "15", 10);

  await pool.query(
    "INSERT INTO password_reset_tokens (user_uuid, token_hash, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE))",
    [user.uuid, tokenHash, expiresIn]
  );

  const frontendResetBase = process.env.FRONTEND_RESET_URL || "http://localhost:5173/reset-password";
  const resetLink = `${frontendResetBase}?token=${encodeURIComponent(rawToken)}`;

  try {
    await sendPasswordResetEmail({ to: user.email, resetLink });
  } catch (e) {
    throw new ApiError(500, e.message || "Failed to send password reset email");
  }

  return ok(res, process.env.NODE_ENV === "production" ? {} : { resetLink }, "Password reset email sent");
}

export async function logoutUser(req, res) {
  const header = req.headers.authorization || "";
  const token = header.slice(7).trim();
  if (token) await blacklistToken(token);

  const refreshToken = req.cookies?.dvarif_refresh;
  if (refreshToken) {
    await revokeRefreshRecord(refreshToken);
  }
  res.clearCookie("dvarif_refresh", { path: "/api/v1" });
  return ok(res, {}, "Logged out successfully");
}

export async function resetPassword(req, res) {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) throw new ApiError(400, "Token and newPassword are required");

  validatePasswordPolicy(newPassword);

  const tokenHash = crypto.createHash("sha256").update(String(token)).digest("hex");

  const [tokenRows] = await pool.query(
    `SELECT id, user_uuid, expires_at, used_at
     FROM password_reset_tokens
     WHERE token_hash=?`,
    [tokenHash]
  );

  if (!tokenRows.length) throw new ApiError(400, "Reset token is invalid or expired");

  const record = tokenRows[0];
  if (record.used_at) throw new ApiError(400, "Reset token has already been used");
  if (new Date(record.expires_at) < new Date()) throw new ApiError(400, "Reset token has expired");

  // Fetch the user
  const [userRows] = await pool.query(
    "SELECT id, uuid, status FROM users WHERE uuid=?",
    [record.user_uuid]
  );
  if (!userRows.length || userRows[0].status !== "active") {
    throw new ApiError(400, "Reset token is invalid or expired");
  }

  const user = userRows[0];
  const hashed = await hashPassword(newPassword);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    await conn.query("UPDATE users SET password=? WHERE id=?", [hashed, user.id]);

    // Mark this token as used and invalidate all other unused tokens for this user
    await conn.query(
      "UPDATE password_reset_tokens SET used_at=NOW() WHERE user_uuid=? AND used_at IS NULL",
      [user.uuid]
    );

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  return ok(res, {}, "Password reset successful");
}

export async function setPassword(req, res) {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) throw new ApiError(400, "Token and newPassword are required");

  validatePasswordPolicy(newPassword);

  const tokenHash = crypto.createHash("sha256").update(String(token)).digest("hex");

  const [tokenRows] = await pool.query(
    `SELECT id, user_uuid, expires_at, used_at
     FROM invite_tokens
     WHERE token_hash=?`,
    [tokenHash]
  );

  if (!tokenRows.length) throw new ApiError(400, "Invite token is invalid or expired");

  const record = tokenRows[0];
  if (record.used_at) throw new ApiError(400, "Invite token has already been used");
  if (new Date(record.expires_at) < new Date()) throw new ApiError(400, "Invite token has expired");

  const [userRows] = await pool.query(
    "SELECT id, uuid, status FROM users WHERE uuid=?",
    [record.user_uuid]
  );
  if (!userRows.length) throw new ApiError(400, "Invite token is invalid or expired");

  const user = userRows[0];
  const hashed = await hashPassword(newPassword);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    await conn.query("UPDATE users SET password=?, status='active' WHERE id=?", [hashed, user.id]);

    await conn.query(
      "UPDATE invite_tokens SET used_at=NOW() WHERE user_uuid=? AND used_at IS NULL",
      [user.uuid]
    );

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  return ok(res, {}, "Password set successfully. You can now log in.");
}
