import { pool } from "../config/db.js";
import { ok } from "../utils/response.js";
import { parsePagination, paginatedResponse } from "../utils/pagination.js";
import { hasPermission } from "../utils/permissions.js";
import { queueNotificationEmail } from "../services/notificationEmail.service.js";
import ApiError from "../utils/ApiError.js";

export async function getNotificationPreferences(req, res) {
  const [[row]] = await pool.query(
    `SELECT email_leave, email_support, email_recruitment, email_payroll,
            email_attendance, email_onboarding
       FROM notification_preferences WHERE user_uuid=?`,
    [req.user.uuid]
  );
  return ok(res, {
    preferences: Object.fromEntries([
      "leave", "support", "recruitment", "payroll", "attendance", "onboarding",
    ].map((key) => [key, row ? Boolean(row[`email_${key}`]) : true])),
  }, "Notification preferences");
}

export async function updateNotificationPreferences(req, res) {
  const allowed = ["leave", "support", "recruitment", "payroll", "attendance", "onboarding"];
  const input = req.body?.preferences;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ApiError(400, "preferences must be an object");
  }
  const keys = Object.keys(input);
  if (!keys.length || keys.some((key) => !allowed.includes(key) || typeof input[key] !== "boolean")) {
    throw new ApiError(400, "Provide one or more supported email preferences as booleans");
  }
  const columns = keys.map((key) => `email_${key}`);
  const insertColumns = columns.join(", ");
  const insertValues = keys.map(() => "?").join(", ");
  const updates = columns.map((column) => `${column}=VALUES(${column})`).join(", ");
  await pool.query(
    `INSERT INTO notification_preferences
       (user_uuid, ${insertColumns}) VALUES (?, ${insertValues})
     ON DUPLICATE KEY UPDATE ${updates}`,
    [req.user.uuid, ...keys.map((key) => input[key])]
  );
  return getNotificationPreferences(req, res);
}

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

export async function createNotificationForOrgUsers({ orgId, type, title, message, link, referenceId, excludeUserId, orgRoles, requirePermission, email }) {
  if (!orgId) return;
  let query = "SELECT uuid, org_role, feature_access FROM users WHERE organization=? AND status='active'";
  const params = [orgId];
  if (excludeUserId) {
    query += " AND id!=?";
    params.push(excludeUserId);
  }
  let users = await pool.query(query, params).then(([r]) => r);
  if (orgRoles?.length) {
    users = users.filter((u) => orgRoles.includes(u.org_role));
  }
  if (requirePermission) {
    users = users.filter((u) => hasPermission(u, requirePermission));
  }
  if (!users.length) return;

  const values = users.map((u) => [u.uuid, type, title, message, link || null, referenceId || null]);
  await pool.query(
    "INSERT INTO notifications (user_uuid, type, title, message, link, reference_id) VALUES ?",
    [values]
  );
  if (email) {
    await Promise.all(users.map((u) => queueNotificationEmail({
      ...email,
      userUuid: u.uuid,
      eventKey: `${email.eventKey}:${u.uuid}`,
      subject: email.subject || title,
      title: email.title || title,
      message: email.message || message,
      actionUrl: email.actionUrl || link,
    })));
  }
}

export async function createNotificationForUsers({ userIds, type, title, message, link, referenceId, email }) {
  if (!userIds?.length) return;

  const values = userIds.map((uuid) => [uuid, type, title, message, link || null, referenceId || null]);
  await pool.query(
    "INSERT INTO notifications (user_uuid, type, title, message, link, reference_id) VALUES ?",
    [values]
  );
  if (email) {
    await Promise.all(userIds.map((userUuid) => queueNotificationEmail({
      ...email,
      userUuid,
      eventKey: `${email.eventKey}:${userUuid}`,
      subject: email.subject || title,
      title: email.title || title,
      message: email.message || message,
      actionUrl: email.actionUrl || link,
    })));
  }
}
