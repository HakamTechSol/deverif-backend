import { pool } from "../../config/db.js";
import { ok } from "../../utils/response.js";
import { parsePagination, paginatedResponse } from "../../utils/pagination.js";

const ORG_USER_SELECT = `SELECT u.id, u.uuid, u.full_name, u.email, u.phone, u.cnic,
        u.status, u.org_role, u.feature_access, u.subscription_plan, u.created_at,
        e.uuid AS employee_uuid,
        e.designation,
        e.department
 FROM users u
 LEFT JOIN employees e ON e.linked_user_uuid = u.uuid`;

export async function listOrgUsers(req, res) {
  const { page, limit, offset } = parsePagination(req.query);
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";

  const conditions = ["u.organization = ?"];
  const params = [req.scopeOrgId];

  // Business rule: org-admins only see platform accounts created from employees
  // THEY personally added (per-admin visibility within one organization).
  conditions.push("e.added_by_uuid = ?");
  params.push(req.user.uuid);

  if (search) {
    conditions.push("(u.full_name LIKE ? OR u.email LIKE ? OR u.phone LIKE ? OR u.cnic LIKE ? OR e.designation LIKE ? OR e.department LIKE ?)");
    const like = `%${search}%`;
    params.push(like, like, like, like, like, like);
  }

  const whereClause = `WHERE ${conditions.join(" AND ")}`;

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM users u LEFT JOIN employees e ON e.linked_user_uuid = u.uuid ${whereClause}`,
    params
  );
  const [rows] = await pool.query(
    `${ORG_USER_SELECT} ${whereClause} ORDER BY u.created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  return ok(res, paginatedResponse(rows, total, page, limit), "Organization users list");
}