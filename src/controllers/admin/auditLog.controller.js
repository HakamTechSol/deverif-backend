import { pool } from "../../config/db.js";
import { ok } from "../../utils/response.js";
import { parsePagination, paginatedResponse } from "../../utils/pagination.js";
import { normalizeIp } from "../../utils/ip.js";

export async function listAuditLogs(req, res) {
  const { page, limit, offset } = parsePagination(req.query);
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const actionFilter = typeof req.query.action === "string" ? req.query.action.trim() : "";
  const actorTypeFilter = typeof req.query.actor_type === "string" ? req.query.actor_type.trim() : "";
  const dateFrom = typeof req.query.date_from === "string" ? req.query.date_from.trim() : "";
  const dateTo = typeof req.query.date_to === "string" ? req.query.date_to.trim() : "";

  const conditions = [];
  const params = [];

  if (search) {
    conditions.push("(al.actor_name LIKE ? OR al.action LIKE ? OR al.entity_type LIKE ? OR al.entity_id LIKE ? OR al.ip_address LIKE ?)");
    const like = `%${search}%`;
    params.push(like, like, like, like, like);
  }
  if (actionFilter) {
    conditions.push("al.action = ?");
    params.push(actionFilter);
  }
  if (actorTypeFilter === "admin" || actorTypeFilter === "user") {
    conditions.push("al.actor_type = ?");
    params.push(actorTypeFilter);
  }
  if (dateFrom) {
    conditions.push("al.created_at >= ?");
    params.push(dateFrom);
  }
  if (dateTo) {
    conditions.push("al.created_at <= ?");
    params.push(`${dateTo} 23:59:59`);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM audit_logs al ${whereClause}`,
    params
  );

  const [rows] = await pool.query(
    `SELECT al.id, al.uuid, al.actor_type, al.actor_id, al.actor_name, al.actor_role,
            al.action, al.entity_type, al.entity_id, al.details, al.ip_address, al.created_at
     FROM audit_logs al
     ${whereClause}
     ORDER BY al.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  // Normalize historical rows too (e.g. IPv6-mapped IPv4 stored before normalization existed).
  const normalized = rows.map((r) => ({ ...r, ip_address: normalizeIp(r.ip_address) }));

  return ok(res, paginatedResponse(normalized, total, page, limit), "Audit logs");
}

export async function listAuditActions(req, res) {
  const [rows] = await pool.query(
    "SELECT DISTINCT action FROM audit_logs ORDER BY action ASC"
  );
  return ok(res, { items: rows.map((r) => r.action) }, "Audit actions");
}