import { pool } from "../config/db.js";
import { sendWorkflowNotificationEmail } from "../utils/mailer.js";
import { runScheduledNotificationJobs } from "./notificationEmail.scheduler.js";

let running = false;

/** Durable, retrying email delivery. The unique outbox event key prevents duplicate enqueues. */
export async function drainEmailOutbox(batchSize = 10) {
  if (running) return;
  running = true;
  try {
    await pool.query(
      `UPDATE email_outbox SET status='pending', claimed_at=NULL
        WHERE status='sending' AND claimed_at < DATE_SUB(NOW(), INTERVAL 10 MINUTE)`
    );
    const [jobs] = await pool.query(
      `SELECT * FROM email_outbox
        WHERE status='pending' AND available_at <= NOW()
        ORDER BY id ASC LIMIT ?`,
      [Math.max(1, Math.min(50, Number(batchSize) || 10))]
    );

    for (const job of jobs) {
      const [claim] = await pool.query(
        `UPDATE email_outbox SET status='sending', attempts=attempts+1, claimed_at=NOW()
          WHERE id=? AND status='pending'`,
        [job.id]
      );
      if (!claim.affectedRows) continue;
      try {
        await sendWorkflowNotificationEmail({
          to: job.recipient_email,
          subject: job.subject,
          title: job.title,
          message: job.message,
          actionUrl: job.action_url,
          lang: job.language,
        });
        await pool.query(
          "UPDATE email_outbox SET status='sent', sent_at=NOW(), claimed_at=NULL, last_error=NULL WHERE id=?",
          [job.id]
        );
      } catch (error) {
        const attempts = Number(job.attempts || 0) + 1;
        const retrySeconds = Math.min(21600, 30 * 2 ** Math.min(attempts - 1, 10));
        await pool.query(
          `UPDATE email_outbox
              SET status=?, available_at=DATE_ADD(NOW(), INTERVAL ? SECOND), claimed_at=NULL,
                  last_error=?
            WHERE id=?`,
          [attempts >= 6 ? "failed" : "pending", retrySeconds,
            String(error?.message || "Email delivery failed").slice(0, 1000), job.id]
        );
        console.error(`Workflow email delivery failed (outbox ${job.id}, attempt ${attempts}):`, error?.message);
      }
    }
  } finally {
    running = false;
  }
}

export function startEmailOutboxWorker() {
  const tick = () => drainEmailOutbox().catch((error) => {
    console.error("Email outbox worker failed:", error?.message);
  });
  tick();
  const timer = setInterval(tick, 5_000);
  timer.unref?.();
  const scheduleTick = () => runScheduledNotificationJobs().catch((error) => {
    console.error("Scheduled notification scan failed:", error?.message);
  });
  scheduleTick();
  const scheduleTimer = setInterval(scheduleTick, 60_000);
  scheduleTimer.unref?.();
  return timer;
}

