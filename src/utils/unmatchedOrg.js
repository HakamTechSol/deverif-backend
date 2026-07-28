import { pool } from "../config/db.js";

/**
 * Finds or creates an unmatched_organizations row by name (case-insensitive).
 * If the name exists, returns its id. Otherwise creates a new row.
 * Returns the unmatched_organizations.id.
 */
export async function resolveUnmatchedOrg(name, email, phone, website) {
  const trimmed = String(name).trim();

  const [existing] = await pool.query(
    "SELECT id FROM unmatched_organizations WHERE name = ? COLLATE utf8mb4_general_ci",
    [trimmed]
  );

  if (existing.length) {
    const id = existing[0].id;
    // Update contact fields if new values are provided (prefer non-null)
    const updates = [];
    const params = [];
    if (email)  { updates.push("email = COALESCE(?, email)");  params.push(email); }
    if (phone)  { updates.push("phone = COALESCE(?, phone)");  params.push(phone); }
    if (website){ updates.push("website = COALESCE(?, website)"); params.push(website); }
    if (updates.length) {
      params.push(id);
      await pool.query(`UPDATE unmatched_organizations SET ${updates.join(", ")} WHERE id = ?`, params);
    }
    return id;
  }

  const [result] = await pool.query(
    "INSERT INTO unmatched_organizations (name, email, phone, website) VALUES (?, ?, ?, ?)",
    [trimmed, email || null, phone || null, website || null]
  );
  return result.insertId;
}
