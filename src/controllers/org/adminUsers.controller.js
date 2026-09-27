import crypto from "crypto";
import ApiError from "../../utils/ApiError.js";
import { pool } from "../../config/db.js";
import { ok, created } from "../../utils/response.js";
import { assertUuid } from "../../utils/publicResponse.js";
import { hashPassword } from "../../utils/password.js";
import { parsePagination, paginatedResponse } from "../../utils/pagination.js";
import { sendInviteEmail } from "../../utils/mailer.js";
import { firstFrontendUrl } from "../../utils/frontendUrl.js";
import { logAudit, getActorFromReq } from "../../utils/auditLog.js";
import { normalizedFeatureAccess } from "../../utils/permissions.js";
import { assertIdentityAvailable, rethrowIdentityDuplicate } from "../../utils/identityUniqueness.js";

/**
 * Sub-admins are organization users with org_role='sub_admin'. They are
 * distinct from employees/members (no employee record) and from the primary
 * org_admin. A sub-admin has the same operational access as the org_admin
 * EXCEPT they cannot delete anything, manage other sub-admins, or access
 * organization-level settings. Every route here is protected by
 * requireRole("org_admin"), so only the primary org-admin can manage sub-admins.
 */

// `is_verified` and `invitation_pending` are what let the client tell a pending
// invite (Cancel / Remove available) from an accepted account (only the
// active/inactive toggle). They mirror the platform /admin/users list so both
// screens make the same distinction with the same fields.
const ADMIN_USER_SELECT = `SELECT u.id, u.uuid, u.full_name, u.email, u.phone, u.cnic, u.status,
        u.org_role, u.feature_access, u.is_verified, u.created_at,
        EXISTS (
          SELECT 1 FROM invite_tokens it WHERE it.user_uuid = u.uuid AND it.used_at IS NULL
        ) AS invitation_pending
 FROM users u`;

export async function listAdminUsers(req, res) {
  const { page, limit, offset } = parsePagination(req.query);
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";

  const conditions = ["organization = ?", "org_role='sub_admin'", "deleted_at IS NULL"];
  const params = [req.scopeOrgId];

  if (search) {
    conditions.push("(full_name LIKE ? OR email LIKE ? OR phone LIKE ? OR cnic LIKE ?)");
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }

  const whereClause = `WHERE ${conditions.join(" AND ")}`;

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM users ${whereClause}`,
    params
  );
  const [rows] = await pool.query(
    `${ADMIN_USER_SELECT} ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  return ok(res, paginatedResponse(rows, total, page, limit), "Organization sub-admins list");
}

export async function createAdminUser(req, res) {
  const { full_name, email, phone, cnic, feature_access } = req.body;
  // Persist the granted elevated permissions (normalized with safe defaults).
  const featureAccessJson = JSON.stringify(normalizedFeatureAccess(req.body));

  if (!full_name || !String(full_name).trim()) throw new ApiError(400, "full_name is required");
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ApiError(400, "email is required and must be valid");
  }
  const normalizedCnic = cnic ? String(cnic).replace(/\D/g, "") : "";
  if (!/^\d{13}$/.test(normalizedCnic)) {
    throw new ApiError(400, "cnic must be a valid 13-digit CNIC");
  }

  const [dupeEmail] = await pool.query("SELECT uuid FROM users WHERE email=?", [email]);
  if (dupeEmail.length) throw new ApiError(409, "A platform user with this email already exists");

  const [dupeCnic] = await pool.query(
    "SELECT uuid FROM users WHERE cnic=? AND deleted_at IS NULL",
    [normalizedCnic]
  );
  if (dupeCnic.length) throw new ApiError(409, "A platform user with this CNIC already exists");

  // A phone number identifies the person across the whole platform, not within
  // one organization, so inviting a colleague who is already a user elsewhere is
  // refused here rather than silently creating a second identity.
  await assertIdentityAvailable({ phone, cnic: normalizedCnic, executor: pool });

  const dummyHash = await hashPassword(crypto.randomBytes(16).toString("hex"));
  const rawToken = crypto.randomBytes(32).toString("hex");

  let createdUuid = null;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [userRes] = await conn.query(
      `INSERT INTO users
       (full_name, email, phone, password, cnic, status, org_role, feature_access,
        organization, profile_image, is_verified, created_at)
       VALUES (?, ?, ?, ?, ?, 'inactive', 'sub_admin', ?, ?, NULL, 'no', NOW())`,
      [
        String(full_name).trim(),
        email,
        phone ? String(phone).trim() : null,
        dummyHash,
        normalizedCnic,
        featureAccessJson,
        req.scopeOrgId,
      ]
    );

    const [[newUser]] = await conn.query("SELECT uuid FROM users WHERE id=?", [userRes.insertId]);
    createdUuid = newUser.uuid;

    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    const expiresInHours = parseInt(process.env.INVITE_EXPIRES_IN_HOURS || "72", 10);
    await conn.query(
      "INSERT INTO invite_tokens (user_uuid, token_hash, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? HOUR))",
      [createdUuid, tokenHash, expiresInHours]
    );

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    rethrowIdentityDuplicate(err);
    throw err;
  } finally {
    conn.release();
  }

  let emailSent = false;
  let emailError = null;
  const setLinkBase = firstFrontendUrl(process.env.FRONTEND_SET_PASSWORD_URL, "http://localhost:8080/set-password");
  const setLink = `${setLinkBase}?token=${encodeURIComponent(rawToken)}`;
  try {
    await sendInviteEmail({
      to: email,
      setLink,
      invitedByName: req.user?.full_name || "Org Admin",
    });
    emailSent = true;
  } catch (e) {
    emailError = e.message;
    console.error("Failed to send sub-admin invite email:", e.message);
  }

  const [rows] = await pool.query(`${ADMIN_USER_SELECT} WHERE uuid=?`, [createdUuid]);

  logAudit({
    ...getActorFromReq(req),
    action: "subadmin.create",
    entityType: "user",
    entityId: createdUuid,
    details: { full_name: String(full_name).trim(), email, email_sent: emailSent },
    req,
  });

  const payload = { user: rows[0] };
  let message = emailSent
    ? "Sub-admin created. Set-password email sent."
    : "Sub-admin created but invite email failed.";
  if (!emailSent) {
    payload._email_warning = `Invite email failed: ${emailError}. The sub-admin cannot sign in until they set a password.`;
  }

  return created(res, payload, message);
}

async function loadSubAdminInScope(uuid, scopeOrgId, selfUuid) {
  assertUuid(uuid, "User UUID");

  const [rows] = await pool.query(
    `SELECT id, uuid, full_name, email, organization, org_role, status, feature_access, is_verified
     FROM users WHERE uuid=?`,
    [uuid]
  );
  if (!rows.length) throw new ApiError(404, "User not found");
  const user = rows[0];

  if (user.organization !== scopeOrgId) {
    throw new ApiError(403, "You can only manage sub-admins within your organization");
  }
  if (user.org_role !== "sub_admin") {
    throw new ApiError(409, "Only sub-admins can be managed here");
  }
  if (user.uuid === selfUuid) {
    throw new ApiError(409, "You cannot modify your own sub-admin account");
  }
  return user;
}

export async function updateAdminUser(req, res) {
  const { uuid } = req.params;
  await loadSubAdminInScope(uuid, req.scopeOrgId, req.user.uuid);

  const featureAccessJson = JSON.stringify(normalizedFeatureAccess(req.body));
  await pool.query(
    "UPDATE users SET feature_access=? WHERE uuid=?",
    [featureAccessJson, uuid]
  );

  const [rows] = await pool.query(`${ADMIN_USER_SELECT} WHERE uuid=?`, [uuid]);

  logAudit({
    ...getActorFromReq(req),
    action: "subadmin.access_update",
    entityType: "user",
    entityId: uuid,
    details: {
      full_name: rows[0].full_name,
      email: rows[0].email,
      feature_access: JSON.parse(featureAccessJson),
    },
    req,
  });

  return ok(res, { user: rows[0] }, "Sub-admin permissions updated");
}

export async function revokeAdminUser(req, res) {
  const { uuid } = req.params;
  const action = req.body?.action === "deactivate" ? "deactivate" : "demote";
  const target = await loadSubAdminInScope(uuid, req.scopeOrgId, req.user.uuid);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    if (action === "deactivate") {
      await conn.query("UPDATE users SET status='inactive' WHERE uuid=?", [uuid]);
    } else {
      // Demote to a regular employee. Sub-admins created via createAdminUser
      // have NO employees record — we must create one so they remain visible
      // in the Employees / My Team table. Without this, the demoted person
      // vanishes from the org's employee list entirely.
      const [[empCheck]] = await conn.query(
        "SELECT uuid FROM employees WHERE linked_user_uuid=?",
        [uuid]
      );

      if (!empCheck) {
        const [userRow] = await conn.query(
          "SELECT full_name, email, phone, cnic, organization FROM users WHERE uuid=?",
          [uuid]
        );
        const u = userRow[0];
        await conn.query(
          `INSERT INTO employees
           (uuid, organization_id, full_name, email, phone, cnic,
            status, joining_date, emergency_contact,
            is_platform_user, linked_user_uuid, added_by_uuid, created_at)
           VALUES (UUID(), ?, ?, ?, ?, ?, 'active', NULL, NULL,
                   'yes', ?, ?, NOW())`,
          [u.organization, u.full_name, u.email, u.phone, u.cnic, uuid, req.user.uuid]
        );
      }

      await conn.query(
        "UPDATE users SET org_role='employee', feature_access=NULL WHERE uuid=?",
        [uuid]
      );
    }

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  const [rows] = await pool.query(`${ADMIN_USER_SELECT} WHERE uuid=?`, [uuid]);

  logAudit({
    ...getActorFromReq(req),
    action: "subadmin.revoke",
    entityType: "user",
    entityId: uuid,
    details: { full_name: rows[0].full_name, email: rows[0].email, action },
    req,
  });

  return ok(res, { user: rows[0] }, action === "deactivate" ? "Sub-admin deactivated" : "Sub-admin demoted to employee");
}

/**
 * Cancel a pending sub-admin invitation.
 *
 * Mirrors the platform DELETE /admin/users/:uuid/cancel-invite, but every read
 * and write goes through loadSubAdminInScope, so an org admin can only cancel
 * an invite belonging to their OWN organization and only for a sub_admin. A
 * platform admin cancelling someone is not reachable from here.
 *
 * "Pending" is defined by is_verified='no' — the flag flipped when the invitee
 * sets a password. Once accepted, cancelling is meaningless and deactivating is
 * the correct action instead, so we refuse rather than silently doing the wrong
 * thing.
 */
export async function cancelAdminUserInvite(req, res) {
  const { uuid } = req.params;
  const target = await loadSubAdminInScope(uuid, req.scopeOrgId, req.user.uuid);

  if (target.is_verified === "yes") {
    throw new ApiError(
      400,
      "Cannot cancel — this sub-admin has already accepted their invitation. Use deactivate instead."
    );
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // Delete EVERY invite token for this user, not just the unused ones. A
    // previous "resend" marks the old token used, and leaving it behind would
    // block a later resend after this cancel.
    await conn.query("DELETE FROM invite_tokens WHERE user_uuid=?", [target.uuid]);
    await conn.query(
      "UPDATE users SET status='inactive' WHERE uuid=? AND is_verified='no'",
      [target.uuid]
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
    action: "subadmin.invite_cancelled",
    entityType: "user",
    entityId: target.uuid,
    details: { email: target.email, full_name: target.full_name },
    req,
  });

  return ok(res, {}, "Invitation cancelled. Sub-admin marked inactive.");
}

/**
 * Permanently delete a sub-admin who never accepted their invitation.
 *
 * Same shape as the platform removeUserPermanently, with the org scope check
 * added. Refuses once accepted: an accepted account carries real history
 * (sessions, decisions, documents) and deactivating it is the safe action.
 */
export async function removeAdminUserPermanently(req, res) {
  const { uuid } = req.params;
  const target = await loadSubAdminInScope(uuid, req.scopeOrgId, req.user.uuid);

  if (target.is_verified === "yes") {
    throw new ApiError(
      400,
      "Cannot permanently remove a sub-admin who has already accepted their invitation."
    );
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query("DELETE FROM invite_tokens WHERE user_uuid=?", [target.uuid]);
    // employees.linked_user_uuid is a foreign key to users; unlink first or the
    // DELETE below fails on the constraint.
    await conn.query(
      "UPDATE employees SET linked_user_uuid=NULL, is_platform_user='no' WHERE linked_user_uuid=?",
      [target.uuid]
    );
    const [del] = await conn.query(
      "DELETE FROM users WHERE uuid=? AND is_verified='no'",
      [target.uuid]
    );
    if (del.affectedRows === 0) {
      // Thrown, not rolled back here: the catch below owns the single rollback
      // for every failure path. (The platform version rolls back and then rolls
      // back again in its catch; one rollback is enough.)
      throw new ApiError(
        409,
        "Sub-admin could not be removed. The record may have changed concurrently."
      );
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
    action: "subadmin.removed_permanently",
    entityType: "user",
    entityId: target.uuid,
    details: { email: target.email, full_name: target.full_name },
    req,
  });

  return ok(res, {}, "Sub-admin permanently removed");
}