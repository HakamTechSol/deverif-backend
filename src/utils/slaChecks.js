import { pool } from "../config/db.js";
import { sendSlaReminderEmail } from "./mailer.js";

const SLA_REMINDER_HOURS = 48; // 2 days
const SLA_FLAG_HOURS = 72; // 3 days

/**
 * Lazy SLA check (mirrors the subscription-expiry pattern): reminds the
 * receiving organization by email after 2 days and flags the request after 3
 * days. Only applies to requests where BOTH organizations are registered
 * (issuing_organization_id IS NOT NULL); "Other/unmatched org" requests are
 * handled by the separate Unmatched Orgs flow. Never throws — failures are
 * logged so a read request is never broken by this check.
 */
export async function runSlaChecks() {
  try {
    // 1. Remind the receiving org after 2 days (once per request)
    const [reminders] = await pool.query(
      `SELECT vr.id, vr.uuid, vr.document_type,
              o.name AS org_name, o.business_email
       FROM verification_requests vr
       JOIN organizations o ON o.id = vr.issuing_organization_id
       WHERE vr.status='under_review'
         AND vr.issuing_organization_id IS NOT NULL
         AND vr.sla_reminder_sent_at IS NULL
         AND vr.created_at <= DATE_SUB(NOW(), INTERVAL ? HOUR)`,
      [SLA_REMINDER_HOURS]
    );

    for (const r of reminders) {
      try {
        if (r.business_email) {
          // Render the email in the recipient's preferred language (default English).
          let lang = "en";
          const [recipient] = await pool.query(
            "SELECT preferred_language FROM users WHERE email=? AND status='active' LIMIT 1",
            [r.business_email]
          );
          if (recipient.length) lang = recipient[0].preferred_language || "en";

          await sendSlaReminderEmail({
            to: r.business_email,
            orgName: r.org_name,
            documentType: r.document_type,
            lang,
          });
        }
      } catch (e) {
        console.error(`SLA reminder email failed for request ${r.uuid}:`, e.message);
      }
      await pool.query(
        "UPDATE verification_requests SET sla_reminder_sent_at=NOW() WHERE id=?",
        [r.id]
      );
    }

    // 2. Flag requests still under review after 3 days (once per request)
    const [toFlag] = await pool.query(
      `SELECT id FROM verification_requests
       WHERE status='under_review'
         AND issuing_organization_id IS NOT NULL
         AND sla_flagged_at IS NULL
         AND created_at <= DATE_SUB(NOW(), INTERVAL ? HOUR)`,
      [SLA_FLAG_HOURS]
    );

    for (const row of toFlag) {
      await pool.query(
        "UPDATE verification_requests SET sla_flagged_at=NOW() WHERE id=?",
        [row.id]
      );
    }
  } catch (e) {
    console.error("SLA checks failed:", e.message);
  }
}