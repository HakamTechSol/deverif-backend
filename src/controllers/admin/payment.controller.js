import ApiError from "../../utils/ApiError.js";
import { pool } from "../../config/db.js";
import { ok, created } from "../../utils/response.js";
import { assertUuid } from "../../utils/publicResponse.js";
import { parsePagination, paginatedResponse } from "../../utils/pagination.js";
import { logAudit, getActorFromReq } from "../../utils/auditLog.js";

// Gateway-sourced transactions (e.g. Safepay self-service checkouts) live in
// the Self-subscriptions tab; Payment History shows ONLY admin-recorded/manual
// payments, so gateway records are always excluded here.
const GATEWAY_PAYMENT_METHODS = ["safepay"];

export async function listPayments(req, res) {
  const { page, limit, offset } = parsePagination(req.query);
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const methodFilter = typeof req.query.method === "string" ? req.query.method.trim() : "";
  const dateFrom = typeof req.query.date_from === "string" ? req.query.date_from.trim() : "";
  const dateTo = typeof req.query.date_to === "string" ? req.query.date_to.trim() : "";

  let whereClause = "";
  const params = [];

  const conditions = [];
  if (GATEWAY_PAYMENT_METHODS.length) {
    conditions.push(`p.payment_method NOT IN (${GATEWAY_PAYMENT_METHODS.map(() => "?").join(", ")})`);
    params.push(...GATEWAY_PAYMENT_METHODS);
  }
  if (search) {
    conditions.push(`(u.full_name LIKE ? OR u.email LIKE ? OR p.transaction_reference LIKE ? OR p.purpose LIKE ?)`);
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }
  if (methodFilter && methodFilter !== "all") {
    conditions.push(`p.payment_method = ?`);
    params.push(methodFilter);
  }
  if (dateFrom) {
    conditions.push(`p.paid_at >= ?`);
    params.push(dateFrom);
  }
  if (dateTo) {
    conditions.push(`p.paid_at <= ?`);
    params.push(`${dateTo} 23:59:59`);
  }
  if (conditions.length) {
    whereClause = `WHERE ${conditions.join(" AND ")}`;
  }

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM payment p JOIN users u ON u.id = p.user_id ${whereClause}`,
    params
  );
  const [rows] = await pool.query(
    `SELECT p.*, u.uuid AS user_uuid, u.full_name, u.email
     FROM payment p
     JOIN users u ON u.id = p.user_id
     ${whereClause}
     ORDER BY p.paid_at DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return ok(res, paginatedResponse(rows, total, page, limit), "Payments list");
}

export async function createPayment(req, res) {
  const { user_uuid, amount, payment_method, transaction_reference, purpose } = req.body;

  if ("user_id" in req.body) {
    throw new ApiError(400, "user_uuid is required; integer IDs are not accepted");
  }
  if (!user_uuid || amount === undefined) throw new ApiError(400, "user_uuid and amount are required");
  assertUuid(user_uuid, "User UUID");

  const [users] = await pool.query("SELECT id, organization FROM users WHERE uuid=?", [user_uuid]);
  if (!users.length) throw new ApiError(404, "User not found");

  const [result] = await pool.query(
    `INSERT INTO payment (user_id, organization_id, amount, payment_method, transaction_reference, paid_at, purpose)
     VALUES (?, ?, ?, ?, ?, NOW(), ?)`,
    [users[0].id, users[0].organization, amount, payment_method || "manual", transaction_reference || null, purpose || null]
  );

  const [rows] = await pool.query(
    `SELECT p.*, u.uuid AS user_uuid, u.full_name, u.email
     FROM payment p
     JOIN users u ON u.id = p.user_id
     WHERE p.id=?`,
    [result.insertId]
  );

  logAudit({
    ...getActorFromReq(req),
    action: "payment.create",
    entityType: "payment",
    entityId: rows[0].uuid,
    details: { user_uuid, amount, payment_method: payment_method || "manual", purpose: purpose || null },
    req,
  });

  return created(res, { payment: rows[0] }, "Payment created");
}