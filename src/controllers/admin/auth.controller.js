import ApiError from "../../utils/ApiError.js";
import { ok } from "../../utils/response.js";
import { pool } from "../../config/db.js";
import { signAccessToken, signRefreshToken } from "../../utils/jwt.js";
import { validatePasswordPolicy, hashPassword, comparePassword } from "../../utils/password.js";
import { blacklistToken } from "../../utils/tokenBlacklist.js";
import { storeRefreshToken, revokeRefreshToken as revokeRefreshRecord } from "../../utils/refreshToken.js";

function getRefreshCookieOptions() {
  const isProd = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    path: "/api/v1",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  };
}

export async function adminLogin(req, res) {
  const { email, password } = req.body;

  if (!email || !password) throw new ApiError(400, "Email and password are required");

  const [rows] = await pool.query(
    "SELECT id, uuid, email, password, full_name, status FROM admin_profiles WHERE email=?",
    [email]
  );
  if (!rows.length) throw new ApiError(401, "Invalid admin credentials");

  const admin = rows[0];
  if (admin.status && admin.status !== "active") throw new ApiError(403, "Admin account is inactive");

  const match = await comparePassword(password, admin.password);
  if (!match) throw new ApiError(401, "Invalid admin credentials");

  const accessToken = signAccessToken({ type: "admin", userId: admin.uuid, role: "admin", email: admin.email });
  const refreshToken = signRefreshToken({ type: "admin", userId: admin.uuid, role: "admin", email: admin.email });

  const decoded = JSON.parse(Buffer.from(refreshToken.split(".")[1], "base64url").toString());
  const expiresAt = new Date(decoded.exp * 1000);
  await storeRefreshToken({ token: refreshToken, type: "admin", identifier: admin.uuid, expiresAt });

  res.cookie("dvarif_admin_refresh", refreshToken, getRefreshCookieOptions());

  return ok(res, { token: accessToken, admin: { uuid: admin.uuid, email: admin.email, full_name: admin.full_name } }, "Admin login successful");
}

export async function logoutAdmin(req, res) {
  const header = req.headers.authorization || "";
  const token = header.slice(7).trim();
  if (token) await blacklistToken(token);

  const refreshToken = req.cookies?.dvarif_admin_refresh;
  if (refreshToken) {
    await revokeRefreshRecord(refreshToken);
  }
  res.clearCookie("dvarif_admin_refresh", { path: "/api/v1" });
  return ok(res, {}, "Logged out successfully");
}

export async function adminMe(req, res) {
  return ok(res, { admin: req.admin }, "Admin profile");
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

  return ok(res, { admin: updated[0] }, "Admin profile updated successfully");
}


