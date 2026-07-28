import { pool } from "../config/db.js";
import { ok } from "../utils/response.js";
import { parsePagination, paginatedResponse } from "../utils/pagination.js";

export async function listNotifications(req, res) {
  const { page, limit, offset } = parsePagination(req.query);

  const [[{ total }]] = await pool.query(
    "SELECT COUNT(*) AS total FROM notifications WHERE user_uuid=?",
    [req.user.uuid]
  );
  const [rows] = await pool.query(
    "SELECT * FROM notifications WHERE user_uuid=? ORDER BY created_at DESC LIMIT ? OFFSET ?",
    [req.user.uuid, limit, offset]
  );

  return ok(res, paginatedResponse(rows, total, page, limit), "Notifications");
}

export async function unreadCount(req, res) {
  const [[{ count }]] = await pool.query(
    "SELECT COUNT(*) AS count FROM notifications WHERE user_uuid=? AND read_at IS NULL",
    [req.user.uuid]
  );
  return ok(res, { count }, "Unread count");
}

export async function markRead(req, res) {
  const { id } = req.params;
  await pool.query(
    "UPDATE notifications SET read_at=NOW() WHERE id=? AND user_uuid=? AND read_at IS NULL",
    [id, req.user.uuid]
  );
  return ok(res, {}, "Marked as read");
}

export async function markAllRead(req, res) {
  await pool.query(
    "UPDATE notifications SET read_at=NOW() WHERE user_uuid=? AND read_at IS NULL",
    [req.user.uuid]
  );
  return ok(res, {}, "All marked as read");
}

export async function markReadByReference(req, res) {
  const { referenceId } = req.params;
  if (!referenceId) return ok(res, {}, "No reference");

  await pool.query(
    "UPDATE notifications SET read_at=NOW() WHERE user_uuid=? AND reference_id=? AND read_at IS NULL",
    [req.user.uuid, referenceId]
  );
  return ok(res, {}, "Marked as read");
}

export async function createNotificationForOrgUsers({ orgId, type, title, message, link, referenceId }) {
  if (!orgId) return;
  const [users] = await pool.query("SELECT uuid FROM users WHERE organization=? AND status='active'", [orgId]);
  if (!users.length) return;

  const values = users.map((u) => [u.uuid, type, title, message, link || null, referenceId || null]);
  await pool.query(
    "INSERT INTO notifications (user_uuid, type, title, message, link, reference_id) VALUES ?",
    [values]
  );
}

export async function createNotificationForUsers({ userIds, type, title, message, link, referenceId }) {
  if (!userIds?.length) return;

  const values = userIds.map((uuid) => [uuid, type, title, message, link || null, referenceId || null]);
  await pool.query(
    "INSERT INTO notifications (user_uuid, type, title, message, link, reference_id) VALUES ?",
    [values]
  );
}
