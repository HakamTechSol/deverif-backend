import crypto from "crypto";
import ApiError from "../../utils/ApiError.js";
import { pool } from "../../config/db.js";
import { ok, created } from "../../utils/response.js";
import { assertUuid } from "../../utils/publicResponse.js";
import { hashPassword, validatePasswordPolicy } from "../../utils/password.js";
import { parsePagination, paginatedResponse } from "../../utils/pagination.js";
import { sendInviteEmail } from "../../utils/mailer.js";
import { firstFrontendUrl } from "../../utils/frontendUrl.js";
import { logAudit, getActorFromReq } from "../../utils/auditLog.js";
import { getFreePlan } from "../../utils/subscriptionPlans.js";
import { assertIdentityAvailable, rethrowIdentityDuplicate, assertEmailAvailable } from "../../utils/identityUniqueness.js";
import { cnicError, normalizeCnic } from "../../utils/contactFormat.js";

const USER_SELECT = `SELECT u.id, u.uuid, u.full_name, u.email, u.phone, u.cnic, u.status,
        u.org_role, u.profile_image,
        u.is_verified, u.created_at,
        o.uuid AS organization_uuid,
        o.name AS organization_name,
        o.logo AS organization_logo,
        EXISTS (
          SELECT 1 FROM invite_tokens it WHERE it.user_uuid = u.uuid AND it.used_at IS NULL
        ) AS invitation_pending,
        e.uuid AS employee_uuid,
        dg.name AS designation,
        dp.name AS department,
        e.is_platform_user
 FROM users u
 LEFT JOIN organizations o ON o.id = u.organization
 LEFT JOIN employees e ON e.linked_user_uuid = u.uuid
 LEFT JOIN designations dg ON dg.id = e.designation_id
 LEFT JOIN departments dp ON dp.id = e.department_id`;

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

  let whereClause = "WHERE u.deleted_at IS NULL AND u.org_role = 'org_admin'";
  const params = [];

  if (search) {
    whereClause += ` AND (u.full_name LIKE ? OR u.email LIKE ? OR u.phone LIKE ? OR u.cnic LIKE ? OR o.name LIKE ?)`;
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
  if (!user?.full_name || !user?.email) {
    throw new ApiError(400, "user.full_name and user.email are required");
  }
  if (cnicError(user.cnic)) throw new ApiError(400, "CNIC must be 13 digits, e.g. 42101-2345678-9");
  user = { ...user, cnic: normalizeCnic(user.cnic) || null };

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    let orgId = null;
    const [orgExisting] = await conn.query("SELECT id FROM organizations WHERE name=?", [organization.name]);
    if (orgExisting.length) {
      orgId = orgExisting[0].id;
      const [existingAdmin] = await conn.query(
        "SELECT id FROM users WHERE organization=? AND org_role='org_admin'",
        [orgId]
      );
      if (existingAdmin.length) {
        throw new ApiError(409, "This organization already has an Org Admin. Only one Org Admin per organization is allowed.");
      }
    } else {
      const orgLogoFile = req.files?.org_logo?.[0];
      const orgLogoPath = orgLogoFile ? `uploads/organizations/${orgLogoFile.filename}` : null;
      const businessEmail = organization.business_email ? String(organization.business_email).trim() : null;
      if (businessEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(businessEmail)) {
        throw new ApiError(400, "organization.business_email must be a valid email address");
      }
      const [orgTypeRows] = await conn.query(
        "SELECT id FROM organization_types WHERE LOWER(name)=LOWER(?) ORDER BY id DESC LIMIT 1",
        [String(organization.organization_type || "").trim()]
      );
      // Every organization starts on the real Free plan, written as part of the
      // INSERT so the row is never momentarily planless. Free has no billing
      // cycle, so subscription_expiry stays NULL ("indefinite", not "expired").
      const freePlan = await getFreePlan(conn);
      const [orgRes] = await conn.query(
        `INSERT INTO organizations
           (name, verified, logo, organization_type, business_email,
            subscription_plan_id, subscription_status, subscription_start, subscription_expiry)
         VALUES (?, 'yes', ?, ?, ?, ?, 'active', NOW(), NULL)`,
        [
          organization.name,
          orgLogoPath,
          orgTypeRows.length ? orgTypeRows[0].id : null,
          businessEmail,
          freePlan.id,
        ]
      );
      orgId = orgRes.insertId;
    }

    const dummyHash = await hashPassword(crypto.randomBytes(16).toString("hex"));
    const isVerified = user.is_verified === "yes" ? "yes" : "no";
    const profileImagePath = req.file ? `uploads/profiles/${req.file.filename}` : (user.profile_image || null);

    // One person, one number, one CNIC. The index is the real guarantee; this
    // runs first so the admin is told whose phone or CNIC it already belongs to
    // instead of receiving a driver error naming an internal index.
    await assertIdentityAvailable({ phone: user.phone, cnic: user.cnic, executor: conn });

    // One email, one identity — and that spans `employees` too, which the
    // database cannot enforce (employees.email is not unique). Creating an
    // account for an address that already has an employee record leaves one
    // person as an unlinked employee plus an unrelated login.
    await assertEmailAvailable({ email: user.email, executor: conn });

    const [userRes] = await conn.query(
      `INSERT INTO users
       (full_name, email, phone, password, cnic, status, org_role,
        organization, profile_image, is_verified, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'org_admin', ?, ?, ?, NOW())`,
      [user.full_name, user.email, user.phone || null, dummyHash, user.cnic || null, "active", orgId, profileImagePath, isVerified]
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

    const setLinkBase = firstFrontendUrl(process.env.FRONTEND_SET_PASSWORD_URL, "http://localhost:8080/set-password");
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

    logAudit({
      ...getActorFromReq(req),
      action: "user.create",
      entityType: "user",
      entityId: createdUser[0].uuid,
      details: { email: createdUser[0].email, organization: createdUser[0].organization_name },
      req,
    });

    return created(res, payload, emailSent ? "User created. Invite email sent." : "User created but invite email failed. Use Resend Invite to retry.");
  } catch (err) {
    await conn.rollback();
    rethrowIdentityDuplicate(err);
    throw err;
  } finally {
    conn.release();
  }
}

export async function updateUser(req, res) {
  const { uuid } = req.params;
  const { full_name, email, phone, cnic, status, organization_uuid, is_verified, password } = req.body;

  assertUuid(uuid, "User UUID");
  if ("organization" in req.body) {
    throw new ApiError(400, "organization_uuid is required; integer organization IDs are not accepted");
  }

  const [userExists] = await pool.query("SELECT id, phone, cnic FROM users WHERE uuid=?", [uuid]);
  if (!userExists.length) throw new ApiError(404, "User not found");
  const normalizedCnic = cnic === undefined ? undefined : normalizeCnic(cnic);
  if (cnic !== undefined && cnicError(cnic)) {
    throw new ApiError(400, "CNIC must be 13 digits, e.g. 42101-2345678-9");
  }

  const updateFields = [];
  const updateValues = [];

  if (full_name !== undefined) { updateFields.push("full_name = ?"); updateValues.push(full_name); }
  if (email !== undefined) { updateFields.push("email = ?"); updateValues.push(email); }
  if (phone !== undefined) { updateFields.push("phone = ?"); updateValues.push(phone); }
  if (cnic !== undefined) { updateFields.push("cnic = ?"); updateValues.push(normalizedCnic || null); }
  if (status !== undefined) { updateFields.push("status = ?"); updateValues.push(status === "inactive" ? "inactive" : "active"); }
  if (organization_uuid !== undefined) {
    updateFields.push("organization = ?");
    updateValues.push(await resolveOrganizationUuid(organization_uuid));
  }
  if (is_verified !== undefined) { updateFields.push("is_verified = ?"); updateValues.push(is_verified === "yes" ? "yes" : "no"); }
  if (password !== undefined) { validatePasswordPolicy(password); updateFields.push("password = ?"); updateValues.push(await hashPassword(password)); }

  if (updateFields.length === 0) throw new ApiError(400, "At least one field is required to update");

  // Only check identity fields that are actually changing, and exclude this user
  // so re-saving an unchanged profile is not reported as a self-duplicate.
  if (phone !== undefined || cnic !== undefined) {
    await assertIdentityAvailable({
      phone: phone !== undefined ? phone : userExists[0].phone,
      cnic: cnic !== undefined ? normalizedCnic : userExists[0].cnic,
      excludeUserId: userExists[0].id,
      executor: pool,
    });
  }

  // Same reasoning for email, against BOTH tables. `excludeUserUuid` keeps this
  // account from reading as a duplicate of itself when its email is unchanged;
  // the helper reuses that same uuid to skip the employee record this account
  // is legitimately paired with. Without it, every profile save would 409.
  if (email !== undefined) {
    await assertEmailAvailable({ email, executor: pool, excludeUserUuid: uuid });
  }

  updateValues.push(uuid);
  await pool.query(`UPDATE users SET ${updateFields.join(", ")} WHERE uuid=?`, updateValues);

  const [updatedUser] = await pool.query(`${USER_SELECT} WHERE u.uuid=?`, [uuid]);

  logAudit({
    ...getActorFromReq(req),
    action: "user.update",
    entityType: "user",
    entityId: uuid,
    details: { fields: Object.keys(req.body || {}) },
    req,
  });

  return ok(res, { user: updatedUser[0] }, "User updated successfully");
}

export async function deleteUser(req, res) {
  const { uuid } = req.params;
  assertUuid(uuid, "User UUID");

  const [userExists] = await pool.query(
    "SELECT id FROM users WHERE uuid=? AND deleted_at IS NULL",
    [uuid]
  );
  if (!userExists.length) throw new ApiError(404, "User not found");

  await pool.query("UPDATE users SET deleted_at = NOW() WHERE uuid=? AND deleted_at IS NULL", [uuid]);

  logAudit({
    ...getActorFromReq(req),
    action: "user.delete",
    entityType: "user",
    entityId: uuid,
    req,
  });

  return ok(res, {}, "User deleted successfully");
}

export async function cancelInvite(req, res) {
  const { uuid } = req.params;
  assertUuid(uuid, "User UUID");

  const [userRows] = await pool.query(
    "SELECT id, uuid, email, full_name, is_verified FROM users WHERE uuid=? AND deleted_at IS NULL",
    [uuid]
  );
  if (!userRows.length) throw new ApiError(404, "User not found");

  const user = userRows[0];
  if (user.is_verified === "yes") {
    throw new ApiError(400, "Cannot cancel — this user has already accepted their invitation. Use deactivate instead.");
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // Delete EVERY invite token for this user (pending AND superseded ones).
    // Only deleting unused rows would leave behind tokens that a previous
    // resend had marked "used", which then blocks a later resend after cancel.
    await conn.query(
      "DELETE FROM invite_tokens WHERE user_uuid=?",
      [user.uuid]
    );
    await conn.query(
      "UPDATE users SET status='inactive' WHERE uuid=? AND is_verified='no'",
      [user.uuid]
    );
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  logAudit({
    ...getActorFromReq(req),
    action: "user.invite_cancelled",
    entityType: "user",
    entityId: user.uuid,
    details: { email: user.email, full_name: user.full_name },
    req,
  });

  return ok(res, {}, "Invitation cancelled. User marked inactive.");
}

export async function removeUserPermanently(req, res) {
  const { uuid } = req.params;
  assertUuid(uuid, "User UUID");

  const [userRows] = await pool.query(
    "SELECT id, uuid, email, full_name, is_verified FROM users WHERE uuid=? AND deleted_at IS NULL",
    [uuid]
  );
  if (!userRows.length) throw new ApiError(404, "User not found");

  const user = userRows[0];
  if (user.is_verified === "yes") {
    throw new ApiError(400, "Cannot permanently remove an account that already accepted its invitation.");
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query("DELETE FROM invite_tokens WHERE user_uuid=?", [user.uuid]);
    await conn.query(
      "UPDATE employees SET linked_user_uuid=NULL, is_platform_user='no' WHERE linked_user_uuid=?",
      [user.uuid]
    );
    const [del] = await conn.query(
      "DELETE FROM users WHERE uuid=? AND is_verified='no'",
      [user.uuid]
    );
    if (del.affectedRows === 0) {
      await conn.rollback();
      throw new ApiError(409, "User could not be removed. The record may have changed concurrently.");
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  logAudit({
    ...getActorFromReq(req),
    action: "user.removed_permanently",
    entityType: "user",
    entityId: user.uuid,
    details: { email: user.email, full_name: user.full_name },
    req,
  });

  return ok(res, {}, "User permanently removed");
}

export async function resendInvite(req, res) {
  const { uuid } = req.params;
  assertUuid(uuid, "User UUID");

  const [userRows] = await pool.query(
    "SELECT id, uuid, email, full_name, status, is_verified FROM users WHERE uuid=?",
    [uuid]
  );
  if (!userRows.length) throw new ApiError(404, "User not found");

  const user = userRows[0];

  // setPassword flips is_verified to 'yes' in the same transaction that consumes
  // the invite token. A used token alone does not prove acceptance: older versions
  // of this resend handler marked superseded links as used, so that check blocked
  // every later resend even though the account was still unverified.
  if (user.is_verified === "yes") {
    throw new ApiError(400, "Invitation already accepted. Use forgot password instead.");
  }

  // Keep existing pending links valid until the replacement email is confirmed
  // sent. If SMTP fails, the user can still use the previous invitation link.
  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  const expiresInHours = parseInt(process.env.INVITE_EXPIRES_IN_HOURS || "72", 10);

  await pool.query(
    "INSERT INTO invite_tokens (user_uuid, token_hash, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? HOUR))",
    [user.uuid, tokenHash, expiresInHours]
  );

  const setLinkBase = firstFrontendUrl(process.env.FRONTEND_SET_PASSWORD_URL, "http://localhost:8080/set-password");
  const setLink = `${setLinkBase}?token=${encodeURIComponent(rawToken)}`;

  try {
    await sendInviteEmail({ to: user.email, setLink, invitedByName: req.admin?.full_name || "Admin" });
  } catch (e) {
    // Leave this token and earlier pending tokens intact: a connection reset can
    // happen after the provider accepted the message, so deleting it could make
    // an invitation that was actually delivered unusable.
    throw new ApiError(500, e.message || "Failed to send invite email");
  }

  // Only retire older links after SMTP confirms the replacement was sent.
  await pool.query(
    "DELETE FROM invite_tokens WHERE user_uuid=? AND token_hash<>? AND used_at IS NULL",
    [user.uuid, tokenHash]
  );

  logAudit({
    ...getActorFromReq(req),
    action: "user.invite_resend",
    entityType: "user",
    entityId: user.uuid,
    details: { email: user.email },
    req,
  });

  return ok(res, {}, "Invite resent successfully");
}
