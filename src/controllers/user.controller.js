import ApiError from "../utils/ApiError.js";
import { pool } from "../config/db.js";
import { ok } from "../utils/response.js";

export async function getMe(req, res) {
  const [rows] = await pool.query(
    `SELECT u.id, u.uuid, u.full_name, u.email, u.phone, u.cnic,
u.status, u.org_role, u.feature_access, u.preferred_language,
             u.profile_image, u.is_verified, u.created_at,
            o.uuid AS organization_uuid,
            o.name AS organization_name,
            o.logo AS organization_logo
     FROM users u
     LEFT JOIN organizations o ON o.id = u.organization
     WHERE u.id=?`,
    [req.user.id]
  );

  if (!rows.length) return ok(res, { user: req.user }, "Profile fetched");
  return ok(res, { user: rows[0] }, "Profile fetched");
}

export async function updateMe(req, res) {
  const body = req.body || {};

  if ("email" in body) throw new ApiError(400, "Email cannot be changed");

  const updates = {};
  if (body.full_name !== undefined) updates.full_name = body.full_name;
  if (body.phone !== undefined) updates.phone = body.phone;
  if (req.file) updates.profile_image = `uploads/profiles/${req.file.filename}`;

  if (!Object.keys(updates).length) throw new ApiError(400, "No valid fields to update");

  const fields = Object.keys(updates).map((k) => `${k}=?`).join(", ");
  const values = Object.values(updates);

  await pool.query(`UPDATE users SET ${fields} WHERE id=?`, [...values, req.user.id]);

  const [rows] = await pool.query(
    `SELECT u.id, u.uuid, u.full_name, u.email, u.phone, u.cnic,
u.status, u.org_role, u.preferred_language,
             u.profile_image, u.is_verified, u.created_at,
            o.uuid AS organization_uuid,
            o.name AS organization_name
     FROM users u
     LEFT JOIN organizations o ON o.id = u.organization
     WHERE u.id=?`,
    [req.user.id]
  );

  if (!rows.length) throw new ApiError(404, "User not found after update");
  return ok(res, { user: rows[0] }, "Profile updated");
}

/** Persist the UI language preference for the logged-in platform user. */
export async function setPreferredLanguage(req, res) {
  const { language } = req.body || {};
  if (language !== "en" && language !== "ur") {
    throw new ApiError(400, "language must be 'en' or 'ur'");
  }
  await pool.query("UPDATE users SET preferred_language=? WHERE id=?", [language, req.user.id]);
  return ok(res, { preferred_language: language }, "Language preference updated");
}