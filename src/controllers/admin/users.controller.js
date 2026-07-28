import crypto from "crypto";
import ApiError from "../../utils/ApiError.js";
import { pool } from "../../config/db.js";
import { ok, created } from "../../utils/response.js";
import { assertUuid } from "../../utils/publicResponse.js";
import { hashPassword, validatePasswordPolicy } from "../../utils/password.js";
import { parsePagination, paginatedResponse } from "../../utils/pagination.js";
import { sendInviteEmail } from "../../utils/mailer.js";

const USER_SELECT = `SELECT u.id, u.uuid, u.full_name, u.email, u.phone, u.cnic, u.status,
        u.subscription_plan, u.subscription_expiry, u.profile_image,
        u.is_verified, u.created_at,
        o.uuid AS organization_uuid,
        o.name AS organization_name
 FROM users u
 LEFT JOIN organizations o ON o.id = u.organization`;

async function resolveOrganizationUuid(uuid) {
  if (!uuid) return null;
  assertUuid(uuid, "Organization UUID");
  const [rows] = await pool.query("SELECT id FROM organizations WHERE uuid=?", [uuid]);
  if (!rows.length) throw new ApiError(404, "Organization not found");
  return rows[0].id;
}

export async function listUsers(req, res) {
  const { page, limit, offset } = parsePagination(req.query);
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";

  let whereClause = "";
  const params = [];

  if (search) {
    whereClause = `WHERE u.full_name LIKE ? OR u.email LIKE ? OR u.phone LIKE ? OR u.cnic LIKE ? OR o.name LIKE ?`;
    const like = `%${search}%`;
    params.push(like, like, like, like, like);
  }

  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM users u LEFT JOIN organizations o ON o.id = u.organization ${whereClause}`, params);
  const [rows] = await pool.query(`${USER_SELECT} ${whereClause} ORDER BY u.created_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return ok(res, paginatedResponse(rows, total, page, limit), "Users list");
}

export async function createUserWithOrganization(req, res) {
  let { organization, user } = req.body;

  if (typeof organization === "string") {
    try { organization = JSON.parse(organization); } catch { throw new ApiError(400, "organization must be a valid JSON object"); }
  }
  if (typeof user === "string") {
    try { user = JSON.parse(user); } catch { throw new ApiError(400, "user must be a valid JSON object"); }
  }

  if (!organization?.name) throw new ApiError(400, "organization.name is required");
  if (!user?.full_name || !user?.email || !user?.cnic) {
    throw new ApiError(400, "user.full_name, user.email, user.cnic are required");
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    let orgId = null;
    const [orgExisting] = await conn.query("SELECT id FROM organizations WHERE name=?", [organization.name]);
    if (orgExisting.length) {
      orgId = orgExisting[0].id;
    } else {
      const orgLogoFile = req.files?.org_logo?.[0];
      const orgLogoPath = orgLogoFile ? `uploads/organizations/${orgLogoFile.filename}` : null;
      const [orgRes] = await conn.query(
        "INSERT INTO organizations (name, verified, logo, organization_type) VALUES (?, 'yes', ?, ?)",
        [organization.name, orgLogoPath, organization.organization_type || null]
      );
      orgId = orgRes.insertId;
    }

    const dummyHash = await hashPassword(crypto.randomBytes(16).toString("hex"));
    const plan = ["free", "basic", "premium"].includes(user.subscription_plan) ? user.subscription_plan : "free";
    const isVerified = user.is_verified === "yes" ? "yes" : "no";
    const profileImagePath = req.file ? `uploads/profiles/${req.file.filename}` : (user.profile_image || null);

    const [userRes] = await conn.query(
      `INSERT INTO users
       (full_name, email, phone, password, cnic, status,
        subscription_plan, subscription_expiry, organization, profile_image, is_verified, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [user.full_name, user.email, user.phone || null, dummyHash, user.cnic, "inactive", plan,
        user.subscription_expiry || null, orgId, profileImagePath, isVerified]
    );

    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    const expiresInHours = parseInt(process.env.INVITE_EXPIRES_IN_HOURS || "72", 10);

    const [[newUser]] = await conn.query("SELECT uuid FROM users WHERE id=?", [userRes.insertId]);
    await conn.query(
      "INSERT INTO invite_tokens (user_uuid, token_hash, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? HOUR))",
      [newUser.uuid, tokenHash, expiresInHours]
    );

    await conn.commit();

    const [createdUser] = await pool.query(`${USER_SELECT} WHERE u.id=?`, [userRes.insertId]);

    const setLinkBase = process.env.FRONTEND_SET_PASSWORD_URL || "http://localhost:8080/set-password";
    const setLink = `${setLinkBase}?token=${encodeURIComponent(rawToken)}`;

    let emailSent = false;
    let emailError = null;
    try {
      await sendInviteEmail({ to: user.email, setLink, invitedByName: req.admin?.full_name || "Admin" });
      emailSent = true;
    } catch (e) {
      emailError = e.message;
      console.error("Failed to send invite email:", e.message);
    }

    const payload = { user: createdUser[0] };
    if (!emailSent) payload._email_warning = `Invite email failed: ${emailError}. The user can be re-invited from the Users list.`;
    return created(res, payload, emailSent ? "User created. Invite email sent." : "User created but invite email failed. Use Resend Invite to retry.");
  } catch (err) {
    await conn.rollback();
    if (String(err.message).includes("Duplicate")) throw new ApiError(409, err.message);
    throw err;
  } finally {
    conn.release();
  }
}

export async function updateUser(req, res) {
  const { uuid } = req.params;
  const { full_name, email, phone, cnic, status, subscription_plan, subscription_expiry, organization_uuid, is_verified, password } = req.body;

  assertUuid(uuid, "User UUID");
  if ("organization" in req.body) {
    throw new ApiError(400, "organization_uuid is required; integer organization IDs are not accepted");
  }

  const [userExists] = await pool.query("SELECT id FROM users WHERE uuid=?", [uuid]);
  if (!userExists.length) throw new ApiError(404, "User not found");

  const updateFields = [];
  const updateValues = [];

  if (full_name !== undefined) { updateFields.push("full_name = ?"); updateValues.push(full_name); }
  if (email !== undefined) { updateFields.push("email = ?"); updateValues.push(email); }
  if (phone !== undefined) { updateFields.push("phone = ?"); updateValues.push(phone); }
  if (cnic !== undefined) { updateFields.push("cnic = ?"); updateValues.push(cnic); }
  if (status !== undefined) { updateFields.push("status = ?"); updateValues.push(status === "inactive" ? "inactive" : "active"); }
  if (subscription_plan !== undefined) {
    updateFields.push("subscription_plan = ?");
    updateValues.push(["free", "basic", "premium"].includes(subscription_plan) ? subscription_plan : "free");
  }
  if (subscription_expiry !== undefined) { updateFields.push("subscription_expiry = ?"); updateValues.push(subscription_expiry); }
  if (organization_uuid !== undefined) {
    updateFields.push("organization = ?");
    updateValues.push(await resolveOrganizationUuid(organization_uuid));
  }
  if (is_verified !== undefined) { updateFields.push("is_verified = ?"); updateValues.push(is_verified === "yes" ? "yes" : "no"); }
  if (password !== undefined) { validatePasswordPolicy(password); updateFields.push("password = ?"); updateValues.push(await hashPassword(password)); }

  if (updateFields.length === 0) throw new ApiError(400, "At least one field is required to update");

  updateValues.push(uuid);
  await pool.query(`UPDATE users SET ${updateFields.join(", ")} WHERE uuid=?`, updateValues);

  const [updatedUser] = await pool.query(`${USER_SELECT} WHERE u.uuid=?`, [uuid]);
  return ok(res, { user: updatedUser[0] }, "User updated successfully");
}

export async function deleteUser(req, res) {
  const { uuid } = req.params;
  assertUuid(uuid, "User UUID");

  const [userExists] = await pool.query("SELECT id FROM users WHERE uuid=?", [uuid]);
  if (!userExists.length) throw new ApiError(404, "User not found");

  await pool.query("DELETE FROM users WHERE uuid=?", [uuid]);
  return ok(res, {}, "User deleted successfully");
}

export async function resendInvite(req, res) {
  const { uuid } = req.params;
  assertUuid(uuid, "User UUID");

  const [userRows] = await pool.query("SELECT id, uuid, email, full_name, status FROM users WHERE uuid=?", [uuid]);
  if (!userRows.length) throw new ApiError(404, "User not found");

  const user = userRows[0];
  if (user.status === "active") throw new ApiError(400, "User is already active. Use forgot password instead.");

  await pool.query(
    "UPDATE invite_tokens SET used_at=NOW() WHERE user_uuid=? AND used_at IS NULL",
    [user.uuid]
  );

  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  const expiresInHours = parseInt(process.env.INVITE_EXPIRES_IN_HOURS || "72", 10);

  await pool.query(
    "INSERT INTO invite_tokens (user_uuid, token_hash, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? HOUR))",
    [user.uuid, tokenHash, expiresInHours]
  );

  const setLinkBase = process.env.FRONTEND_SET_PASSWORD_URL || "http://localhost:8080/set-password";
  const setLink = `${setLinkBase}?token=${encodeURIComponent(rawToken)}`;

  try {
    await sendInviteEmail({ to: user.email, setLink, invitedByName: req.admin?.full_name || "Admin" });
  } catch (e) {
    throw new ApiError(500, e.message || "Failed to send invite email");
  }

  return ok(res, {}, "Invite resent successfully");
}