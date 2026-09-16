import ApiError from "../utils/ApiError.js";
import { pool } from "../config/db.js";
import { ok } from "../utils/response.js";
import { comparePassword } from "../utils/password.js";
import { generateOtp, hashOtp, storeOtp, invalidateOtps } from "../utils/otp.js";
import { sendLoginOtpEmail } from "../utils/mailer.js";
import { logLoginAttempt } from "../utils/loginHistory.js";

const GENERIC_ERROR = "Invalid credentials";

async function issueOtp({ identityType, identityId, email, lang = "en" }) {
  await invalidateOtps(identityType, identityId);
  const otp = generateOtp();
  const otpHash = await hashOtp(otp);
  await storeOtp({ identityType, identityId, otpHash });

  try {
    await sendLoginOtpEmail({ to: email, otp, lang });
  } catch (e) {
    await invalidateOtps(identityType, identityId);
    console.error("Failed to send OTP email:", e.message);
    throw new ApiError(500, "We couldn't send the verification code to your email. Please try again.");
  }
}

export async function login(req, res) {
  const { email, password, rememberMe } = req.body;
  if (!email || !password) throw new ApiError(400, "Email and password are required");

  // NOTE: This endpoint is strictly for platform users. System Admin accounts
  // (admin_profiles) are deliberately NOT authenticated here — they must use
  // the dedicated admin login endpoint. An admin's email entered on the regular
  // login page falls through to the users lookup and returns a generic error,
  // so it never reveals that the email belongs to an admin.
  const [userRows] = await pool.query(
    "SELECT id, uuid, full_name, email, password, status, profile_image, preferred_language FROM users WHERE email=?",
    [email]
  );

  if (!userRows.length) {
    throw new ApiError(401, GENERIC_ERROR);
  }

  const user = userRows[0];

  // NEW: Check if the linked employee record is inactive and the user is a platform user.
  // This blocks login immediately even if the users table status is still 'active'.
  const [employees] = await pool.query(
    `SELECT is_platform_user, status FROM employees WHERE linked_user_uuid = ?`,
    [user.id]
  );
  if (employees.length && employees[0].is_platform_user === 'yes' && employees[0].status === 'inactive') {
    throw new ApiError(403, "Your account has been deactivated. Contact your organization admin.");
  }

  if (user.status !== "active") throw new ApiError(403, "Your account has been deactivated by admin");

  const match = await comparePassword(password, user.password);
  if (!match) {
    logLoginAttempt({ req, identityType: "user", identityId: user.id, success: false });
    throw new ApiError(401, GENERIC_ERROR);
  }

  await issueOtp({ identityType: "user", identityId: user.id, email: user.email, lang: user.preferred_language || "en" });

  return ok(res, {
    requiresOtp: true,
    identity_type: "user",
    identity_id: user.uuid,
    email: user.email,
    full_name: user.full_name,
    profile_image: user.profile_image,
    rememberMe: !!rememberMe,
  }, "Verification code sent to your email");
}