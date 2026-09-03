import { pool } from "../../config/db.js";
import { ok } from "../../utils/response.js";
import { parsePagination, paginatedResponse } from "../../utils/pagination.js";
import { normalizeIp } from "../../utils/ip.js";

export async function listLoginHistory(req, res) {
  const { page, limit, offset } = parsePagination(req.query);
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const successFilter = typeof req.query.success === "string" ? req.query.success.trim() : "";
  const dateFrom = typeof req.query.date_from === "string" ? req.query.date_from.trim() : "";
  const dateTo = typeof req.query.date_to === "string" ? req.query.date_to.trim() : "";

  let whereClause = "WHERE 1=1";
  const params = [];

  if (search) {
    whereClause += ` AND (
      lh.identity_type LIKE ? OR
      lh.ip_address LIKE ? OR
      lh.user_agent LIKE ? OR
      lh.uuid LIKE ? OR
      (lh.identity_type = 'admin' AND EXISTS (SELECT 1 FROM admin_profiles ap WHERE ap.id = lh.identity_id AND (ap.email LIKE ? OR ap.full_name LIKE ?))) OR
      (lh.identity_type = 'user' AND EXISTS (SELECT 1 FROM users u WHERE u.id = lh.identity_id AND (u.email LIKE ? OR u.full_name LIKE ?)))
    )`;
    const like = `%${search}%`;
    params.push(like, like, like, like, like, like, like, like);
  }

  if (successFilter === "yes" || successFilter === "no") {
    whereClause += " AND lh.success = ?";
    params.push(successFilter);
  }

  if (dateFrom) {
    whereClause += " AND lh.login_at >= ?";
    params.push(dateFrom);
  }
  if (dateTo) {
    whereClause += " AND lh.login_at <= ?";
    params.push(dateTo + " 23:59:59");
  }

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM login_history lh ${whereClause}`,
    params
  );

  const [rows] = await pool.query(
    `SELECT lh.id, lh.uuid, lh.identity_type, lh.identity_id, lh.ip_address, lh.user_agent, lh.login_at, lh.success,
            CASE
              WHEN lh.identity_type = 'admin' THEN (SELECT ap.email FROM admin_profiles ap WHERE ap.id = lh.identity_id LIMIT 1)
              WHEN lh.identity_type = 'user' THEN (SELECT u.email FROM users u WHERE u.id = lh.identity_id LIMIT 1)
            END AS email,
            CASE
              WHEN lh.identity_type = 'admin' THEN (SELECT ap.full_name FROM admin_profiles ap WHERE ap.id = lh.identity_id LIMIT 1)
              WHEN lh.identity_type = 'user' THEN (SELECT u.full_name FROM users u WHERE u.id = lh.identity_id LIMIT 1)
            END AS full_name
     FROM login_history lh
     ${whereClause}
     ORDER BY lh.login_at DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  const normalized = rows.map((r) => ({ ...r, ip_address: normalizeIp(r.ip_address) }));

  return ok(res, paginatedResponse(normalized, total, page, limit), "Login history");
}
