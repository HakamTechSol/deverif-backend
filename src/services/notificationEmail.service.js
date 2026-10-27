import { pool } from "../config/db.js";
import { firstFrontendUrl } from "../utils/frontendUrl.js";

const CATEGORIES = new Set(["leave", "support", "recruitment", "payroll", "attendance", "onboarding", "system"]);
const PREF_COLUMN = {
  leave: "email_leave",
  support: "email_support",
  recruitment: "email_recruitment",
  payroll: "email_payroll",
  attendance: "email_attendance",
  onboarding: "email_onboarding",
};

export function notificationActionUrl(path) {
  if (!path) return null;
  try { return new URL(path, firstFrontendUrl(process.env.FRONTEND_URL, "http://localhost:8080")).toString(); }
  catch { return null; }
}

/** Queue one email idempotently. User preferences apply to employee accounts; essential system mail stays mandatory. */
export async function queueNotificationEmail({
  eventKey,
  category,
  userUuid = null,
  to = null,
  language = null,
  subject,
  title,
  message,
  actionUrl = null,
  conn = pool,
}) {
  if (!CATEGORIES.has(category)) throw new TypeError(`Unsupported email category: ${category}`);
  if (!eventKey || String(eventKey).length > 255) throw new TypeError("A stable eventKey (max 255 chars) is required");
  if (!subject || !title || !message) throw new TypeError("Email subject, title and message are required");

  let recipientEmail = to;
  let recipientLanguage = language === "ur" ? "ur" : "en";
  if (userUuid) {
    const [[user]] = await conn.query(
      `SELECT email, preferred_language FROM users
        WHERE uuid=? AND status='active' AND deleted_at IS NULL LIMIT 1`,
      [userUuid]
    );
    if (user) {
      recipientEmail ||= user.email;
      if (!language) recipientLanguage = user.preferred_language === "ur" ? "ur" : "en";
      const preferenceColumn = PREF_COLUMN[category];
      if (preferenceColumn) {
        const [[preference]] = await conn.query(
          `SELECT ${preferenceColumn} AS enabled FROM notification_preferences WHERE user_uuid=?`,
          [userUuid]
        );
        if (preference?.enabled === 0) return { queued: false, reason: "user_preference" };
      }
    } else {
      const [[admin]] = await conn.query(
        "SELECT email, preferred_language FROM admin_profiles WHERE uuid=? AND status='active' LIMIT 1",
        [userUuid]
      );
      recipientEmail ||= admin?.email;
      if (!language) recipientLanguage = admin?.preferred_language === "ur" ? "ur" : "en";
    }
  }
  if (!recipientEmail) return { queued: false, reason: "no_email" };

  const [result] = await conn.query(
    `INSERT IGNORE INTO email_outbox
       (event_key, user_uuid, recipient_email, category, language, subject, title, message, action_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [eventKey, userUuid, String(recipientEmail).trim(), category, recipientLanguage,
      String(subject).slice(0, 255), String(title).slice(0, 255), String(message), notificationActionUrl(actionUrl)]
  );
  return { queued: result.affectedRows === 1, duplicate: result.affectedRows === 0 };
}

