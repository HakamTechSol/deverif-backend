import ApiError from "../utils/ApiError.js";
import { pool } from "../config/db.js";
import { ok } from "../utils/response.js";
import { consumeOtp, generateOtp, hashOtp, storeOtp, invalidateOtps } from "../utils/otp.js";
import { signAccessToken, signRefreshToken } from "../utils/jwt.js";
import { storeRefreshToken } from "../utils/refreshToken.js";
import { sendLoginOtpEmail } from "../utils/mailer.js";
import { logLoginAttempt } from "../utils/loginHistory.js";

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

async function resolveInternalId(identityType, uuid) {
  if (identityType === "admin") {
    const [rows] = await pool.query("SELECT id FROM admin_profiles WHERE uuid=?", [uuid]);
    if (!rows.length) return null;
    return rows[0].id;
  }
  const [rows] = await pool.query("SELECT id FROM users WHERE uuid=?", [uuid]);
  if (!rows.length) return null;
  return rows[0].id;
}

export async function verifyOtp(req, res) {
  const { identity_type, identity_id, otp, rememberMe } = req.body;

  if (!identity_type || !identity_id || !otp) {
    throw new ApiError(400, "identity_type, identity_id, and otp are required");
  }
  if (!["admin", "user"].includes(identity_type)) {
    throw new ApiError(400, "identity_type must be 'admin' or 'user'");
  }

  const internalId = await resolveInternalId(identity_type, identity_id);
  if (!internalId) throw new ApiError(401, "Account not found");

  const result = await consumeOtp({ identityType: identity_type, identityId: internalId, otp });

  if (!result.ok) {
    logLoginAttempt({ req, identityType: identity_type, identityId: internalId, success: false });

    if (result.reason === "expired") throw new ApiError(401, "Verification code has expired. Please request a new one.");
    if (result.reason === "max_attempts") throw new ApiError(401, "Too many attempts. Please request a new code.");
    if (result.reason === "no_otp") throw new ApiError(401, "No verification code found. Please sign in again.");
    if (result.reason === "invalid") {
      throw new ApiError(401, `Invalid verification code. ${result.remaining} attempt(s) remaining.`);
    }
    throw new ApiError(401, "Invalid verification code");
  }

  if (identity_type === "admin") {
    const [adminRows] = await pool.query(
      "SELECT id, uuid, email, full_name, status, profile_image, preferred_language FROM admin_profiles WHERE uuid=?",
      [identity_id]
    );
    if (!adminRows.length) throw new ApiError(401, "Account not found");
    const admin = adminRows[0];
    if (admin.status && admin.status !== "active") throw new ApiError(403, "Account is inactive");

    const accessToken = signAccessToken({ type: "admin", userId: admin.uuid, role: "admin", email: admin.email });
    const refreshToken = signRefreshToken({ type: "admin", userId: admin.uuid, role: "admin", email: admin.email });

    const decoded = JSON.parse(Buffer.from(refreshToken.split(".")[1], "base64url").toString());
    const expiresAt = new Date(decoded.exp * 1000);
    await storeRefreshToken({ token: refreshToken, type: "admin", identifier: admin.uuid, expiresAt });

    res.cookie("dverif_admin_refresh", refreshToken, getAdminRefreshCookieOptions());

    logLoginAttempt({ req, identityType: "admin", identityId: admin.id, success: true });

    return ok(res, {
      token: accessToken,
      user: { uuid: admin.uuid, email: admin.email, full_name: admin.full_name, profile_image: admin.profile_image, role: "admin", preferred_language: admin.preferred_language || "en" },
    }, "Login successful");
  }

  const [userRows] = await pool.query(
    "SELECT id, uuid, full_name, email, status, profile_image, organization, org_role, feature_access, preferred_language FROM users WHERE uuid=?",
    [identity_id]
  );
  if (!userRows.length) throw new ApiError(401, "Account not found");
  const user = userRows[0];

  // NEW: Check if the linked employee record is inactive and the user is a platform user.
  // This blocks login immediately even if the users table status is still 'active'.
  const [employees] = await pool.query(
    `SELECT is_platform_user, status FROM employees WHERE linked_user_uuid = ?`,
    [identity_id]
  );
  if (employees.length && employees[0].is_platform_user === 'yes' && employees[0].status === 'inactive') {
    throw new ApiError(403, "Your account has been deactivated. Contact your organization admin.");
  }

  if (user.status !== "active") throw new ApiError(403, "Account is inactive");

  const accessToken = signAccessToken({
    type: "user",
    userId: user.uuid,
    role: "user",
    organization: user.organization,
    org_role: user.org_role,
  });
  const refreshToken = signRefreshToken({ type: "user", userId: user.uuid, role: "user" }, !!rememberMe);

  const decoded = JSON.parse(Buffer.from(refreshToken.split(".")[1], "base64url").toString());
  const expiresAt = new Date(decoded.exp * 1000);
  await storeRefreshToken({ token: refreshToken, type: "user", identifier: user.uuid, expiresAt });

  res.cookie("dverif_refresh", refreshToken, getRefreshCookieOptions(!!rememberMe));

  logLoginAttempt({ req, identityType: "user", identityId: user.id, success: true });

  return ok(res, {
    token: accessToken,
    user: {
      uuid: user.uuid,
      full_name: user.full_name,
      email: user.email,
      profile_image: user.profile_image,
      role: "user",
      organization: user.organization,
      org_role: user.org_role,
      feature_access: user.feature_access,
      preferred_language: user.preferred_language || "en",
    },
  }, "Login successful");
}

export async function resendOtp(req, res) {
  const { identity_type, identity_id } = req.body;

  if (!identity_type || !identity_id) {
    throw new ApiError(400, "identity_type and identity_id are required");
  }
  if (!["admin", "user"].includes(identity_type)) {
    throw new ApiError(400, "identity_type must be 'admin' or 'user'");
  }

  const internalId = await resolveInternalId(identity_type, identity_id);
  if (!internalId) throw new ApiError(404, "Account not found");

  let email = null;
  let lang = "en";

  if (identity_type === "admin") {
    const [rows] = await pool.query(
      "SELECT id, email, status, preferred_language FROM admin_profiles WHERE uuid=?",
      [identity_id]
    );
    if (!rows.length) throw new ApiError(404, "Account not found");
    if (rows[0].status && rows[0].status !== "active") throw new ApiError(403, "Account is inactive");
    email = rows[0].email;
    lang = rows[0].preferred_language || "en";
  } else {
    const [rows] = await pool.query(
      "SELECT id, email, status, preferred_language FROM users WHERE uuid=?",
      [identity_id]
    );
    if (!rows.length) throw new ApiError(404, "Account not found");
    if (rows[0].status !== "active") throw new ApiError(403, "Account is inactive");

    // NEW: Check if the linked employee record is inactive and the user is a platform user.
    const [employees] = await pool.query(
      `SELECT is_platform_user, status FROM employees WHERE linked_user_uuid = ?`,
      [identity_id]
    );
    if (employees.length && employees[0].is_platform_user === 'yes' && employees[0].status === 'inactive') {
      throw new ApiError(403, "Your account has been deactivated. Contact your organization admin.");
    }

    email = rows[0].email;
    lang = rows[0].preferred_language || "en";
  }

  await invalidateOtps(identity_type, internalId);
  const otp = generateOtp();
  const otpHash = await hashOtp(otp);
  await storeOtp({ identityType: identity_type, identityId: internalId, otpHash });

  try {
    await sendLoginOtpEmail({ to: email, otp, lang });
  } catch (e) {
    await invalidateOtps(identity_type, internalId);
    console.error("Failed to send OTP email:", e.message);
    throw new ApiError(500, "We couldn't resend the verification code. Please try again.");
  }

  return ok(res, {}, "Verification code resent");
}
