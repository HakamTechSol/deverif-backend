import ApiError from "../../utils/ApiError.js";
import { ok } from "../../utils/response.js";
import { pool } from "../../config/db.js";
import crypto from "crypto";
import { signAccessToken, signRefreshToken } from "../../utils/jwt.js";
import { validatePasswordPolicy, hashPassword, comparePassword } from "../../utils/password.js";
import { blacklistToken } from "../../utils/tokenBlacklist.js";
import { storeRefreshToken, revokeRefreshToken as revokeRefreshRecord } from "../../utils/refreshToken.js";
import { logAudit } from "../../utils/auditLog.js";
import { generateOtp, hashOtp, storeOtp, invalidateOtps, consumeOtp } from "../../utils/otp.js";
import { sendLoginOtpEmail, sendPasswordResetEmail } from "../../utils/mailer.js";
import { logLoginAttempt } from "../../utils/loginHistory.js";
import { firstFrontendUrl } from "../../utils/frontendUrl.js";

const GENERIC_ERROR = "Invalid admin credentials";

async function issueAdminOtp({ adminId, email, lang = "en" }) {
  await invalidateOtps("admin", adminId);
  const otp = generateOtp();
  const otpHash = await hashOtp(otp);
  await storeOtp({ identityType: "admin", identityId: adminId, otpHash });

  try {
    await sendLoginOtpEmail({ to: email, otp, lang });
  } catch (e) {
    await invalidateOtps("admin", adminId);
    console.error("Failed to send admin OTP email:", e.message);
    throw new ApiError(500, "We couldn't send the verification code to your email. Please try again.");
  }
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

export async function adminLogin(req, res) {
  const { email, password, rememberMe } = req.body;

  if (!email || !password) throw new ApiError(400, "Email and password are required");

  // Dedicated System Admin login. This never reveals whether an email exists —
  // invalid emails and invalid passwords both produce the same generic error.
  const [rows] = await pool.query(
    "SELECT id, uuid, email, password, full_name, status, profile_image, preferred_language FROM admin_profiles WHERE email=?",
    [email]
  );

  if (!rows.length) {
    throw new ApiError(401, GENERIC_ERROR);
  }

  const admin = rows[0];
  if (admin.status && admin.status !== "active") throw new ApiError(403, "Admin account is inactive");

  const match = await comparePassword(password, admin.password);
  if (!match) {
    logLoginAttempt({ req, identityType: "admin", identityId: admin.id, success: false });
    throw new ApiError(401, GENERIC_ERROR);
  }

  await issueAdminOtp({ adminId: admin.id, email: admin.email, lang: admin.preferred_language || "en" });

  return ok(res, {
    requiresOtp: true,
    identity_type: "admin",
    identity_id: admin.uuid,
    email: admin.email,
    full_name: admin.full_name,
    profile_image: admin.profile_image,
    rememberMe: !!rememberMe,
  }, "Verification code sent to your email");
}

export async function adminResendOtp(req, res) {
  const { identity_id } = req.body;
  if (!identity_id) throw new ApiError(400, "identity_id is required");

  const [rows] = await pool.query(
    "SELECT id, email, status, preferred_language FROM admin_profiles WHERE uuid=?",
    [identity_id]
  );
  if (!rows.length) throw new ApiError(404, "Admin account not found");
  if (rows[0].status && rows[0].status !== "active") throw new ApiError(403, "Admin account is inactive");

  await issueAdminOtp({ adminId: rows[0].id, email: rows[0].email, lang: rows[0].preferred_language || "en" });

  return ok(res, {}, "Verification code resent");
}

export async function adminForgotPassword(req, res) {
  const { email } = req.body;
  if (!email) throw new ApiError(400, "Email is required");

  const [rows] = await pool.query(
    "SELECT id, uuid, email, status, preferred_language FROM admin_profiles WHERE email=?",
    [email]
  );

  // Never reveal whether an admin account exists.
  if (!rows.length || (rows[0].status && rows[0].status !== "active")) {
    return ok(res, {}, "If an account exists with this email, a reset link has been generated");
  }

  const admin = rows[0];

  await pool.query(
    "UPDATE admin_password_reset_tokens SET used_at=NOW() WHERE admin_uuid=? AND used_at IS NULL",
    [admin.uuid]
  );

  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  const expiresIn = parseInt(process.env.RESET_PASSWORD_EXPIRES_IN_MINUTES || "15", 10);

  await pool.query(
    "INSERT INTO admin_password_reset_tokens (admin_uuid, token_hash, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE))",
    [admin.uuid, tokenHash, expiresIn]
  );

  const frontendResetBase = firstFrontendUrl(
    process.env.FRONTEND_ADMIN_RESET_URL,
    "http://localhost:5173/system-admin/reset-password"
  );
  const resetLink = `${frontendResetBase}?token=${encodeURIComponent(rawToken)}`;

  try {
    await sendPasswordResetEmail({ to: admin.email, resetLink, lang: admin.preferred_language || "en" });
  } catch (e) {
    throw new ApiError(500, e.message || "Failed to send password reset email");
  }

  return ok(res, process.env.NODE_ENV === "production" ? {} : { resetLink }, "Password reset email sent");
}

export async function adminResetPassword(req, res) {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) throw new ApiError(400, "Token and newPassword are required");

  validatePasswordPolicy(newPassword);

  const tokenHash = crypto.createHash("sha256").update(String(token)).digest("hex");

  const [tokenRows] = await pool.query(
    "SELECT id, admin_uuid, expires_at, used_at FROM admin_password_reset_tokens WHERE token_hash=?",
    [tokenHash]
  );

  if (!tokenRows.length) throw new ApiError(400, "Reset token is invalid or expired");

  const record = tokenRows[0];
  if (record.used_at) throw new ApiError(400, "Reset token has already been used");
  if (new Date(record.expires_at) < new Date()) throw new ApiError(400, "Reset token has expired");

  const [adminRows] = await pool.query(
    "SELECT id, uuid, status FROM admin_profiles WHERE uuid=?",
    [record.admin_uuid]
  );
  if (!adminRows.length || (adminRows[0].status && adminRows[0].status !== "active")) {
    throw new ApiError(400, "Reset token is invalid or expired");
  }

  const admin = adminRows[0];
  const hashed = await hashPassword(newPassword);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    await conn.query("UPDATE admin_profiles SET password=? WHERE id=?", [hashed, admin.id]);

    await conn.query(
      "UPDATE admin_password_reset_tokens SET used_at=NOW() WHERE admin_uuid=? AND used_at IS NULL",
      [admin.uuid]
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

export async function adminVerifyOtp(req, res) {
  const { identity_id, otp, rememberMe } = req.body;

  if (!identity_id || !otp) throw new ApiError(400, "identity_id and otp are required");
  if (typeof otp !== "string" || !/^\d{6}$/.test(otp)) {
    throw new ApiError(400, "Verification code must be 6 digits");
  }

  const [rows] = await pool.query(
    "SELECT id, uuid, email, full_name, status, profile_image, preferred_language FROM admin_profiles WHERE uuid=?",
    [identity_id]
  );
  if (!rows.length) throw new ApiError(401, "Admin account not found");

  const admin = rows[0];
  if (admin.status && admin.status !== "active") throw new ApiError(403, "Admin account is inactive");

  const result = await consumeOtp({ identityType: "admin", identityId: admin.id, otp });

  if (!result.ok) {
    logLoginAttempt({ req, identityType: "admin", identityId: admin.id, success: false });

    if (result.reason === "expired") throw new ApiError(401, "Verification code has expired. Please request a new one.");
    if (result.reason === "max_attempts") throw new ApiError(401, "Too many attempts. Please request a new code.");
    if (result.reason === "no_otp") throw new ApiError(401, "No verification code found. Please sign in again.");
    if (result.reason === "invalid") {
      throw new ApiError(401, `Invalid verification code. ${result.remaining} attempt(s) remaining.`);
    }
    throw new ApiError(401, "Invalid verification code");
  }

  const accessToken = signAccessToken({ type: "admin", userId: admin.uuid, role: "admin", email: admin.email });
  const refreshToken = signRefreshToken({ type: "admin", userId: admin.uuid, role: "admin", email: admin.email }, !!rememberMe);

  const decoded = JSON.parse(Buffer.from(refreshToken.split(".")[1], "base64url").toString());
  const expiresAt = new Date(decoded.exp * 1000);
  await storeRefreshToken({ token: refreshToken, type: "admin", identifier: admin.uuid, expiresAt });

  res.cookie("dverif_admin_refresh", refreshToken, getRefreshCookieOptions(!!rememberMe));

  logLoginAttempt({ req, identityType: "admin", identityId: admin.id, success: true });

  return ok(res, {
    token: accessToken,
    admin: { uuid: admin.uuid, email: admin.email, full_name: admin.full_name, profile_image: admin.profile_image, preferred_language: admin.preferred_language || "en" },
  }, "Admin login successful");
}

export async function logoutAdmin(req, res) {
  const header = req.headers.authorization || "";
  const token = header.slice(7).trim();
  if (token) await blacklistToken(token);

  const refreshToken = req.cookies?.dverif_admin_refresh;
  if (refreshToken) {
    await revokeRefreshRecord(refreshToken);
  }
  res.clearCookie("dverif_admin_refresh", { path: "/api/v1" });
  return ok(res, {}, "Logged out successfully");
}

export async function adminMe(req, res) {
  return ok(res, { admin: req.admin }, "Admin profile");
}

/** Persist the UI language preference for the logged-in platform admin. */
export async function setAdminPreferredLanguage(req, res) {
  const { language } = req.body || {};
  if (language !== "en" && language !== "ur") {
    throw new ApiError(400, "language must be 'en' or 'ur'");
  }
  await pool.query("UPDATE admin_profiles SET preferred_language=? WHERE id=?", [language, req.admin.id]);
  return ok(res, { preferred_language: language }, "Language preference updated");
}

export async function updateAdminProfile(req, res) {
  const { full_name, phone, password, old_password } = req.body;
  const adminUuid = req.admin.uuid;

  const [adminExists] = await pool.query(
    "SELECT id, uuid, email, password FROM admin_profiles WHERE uuid=?",
    [adminUuid]
  );
  if (!adminExists.length) throw new ApiError(404, "Admin not found");

  const adminId = adminExists[0].id;
  const existingPassword = adminExists[0].password;

  if (password) {
    if (!old_password) throw new ApiError(400, "old_password is required to change password");
    const isValid = await comparePassword(old_password, existingPassword);
    if (!isValid) throw new ApiError(401, "Old password is incorrect");
  }

  const updateFields = [];
  const updateValues = [];

  if (full_name !== undefined) {
    updateFields.push("full_name = ?");
    updateValues.push(full_name);
  }
  if (phone !== undefined) {
    updateFields.push("phone = ?");
    updateValues.push(phone);
  }
  if (req.file) {
    updateFields.push("profile_image = ?");
    updateValues.push(`uploads/profiles/${req.file.filename}`);
  }
  if (password) {
    validatePasswordPolicy(password);
    const hashed = await hashPassword(password);
    updateFields.push("password = ?");
    updateValues.push(hashed);
  }

  if (updateFields.length === 0) {
    throw new ApiError(400, "At least one field is required to update");
  }

  updateValues.push(adminId);

  await pool.query(
    `UPDATE admin_profiles SET ${updateFields.join(", ")} WHERE id=?`,
    updateValues
  );

  const [updated] = await pool.query(
    "SELECT id, uuid, email, full_name, phone, profile_image FROM admin_profiles WHERE id=?",
    [adminId]
  );

  logAudit({
    actorType: "admin",
    actorId: adminId,
    actorName: req.admin?.full_name || updated[0]?.full_name || "Admin",
    action: "admin.profile_update",
    entityType: "admin",
    entityId: adminUuid,
    details: { fields: Object.keys(req.body || {}) },
    req,
  });

  return ok(res, { admin: updated[0] }, "Admin profile updated successfully");
}


