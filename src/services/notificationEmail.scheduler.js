import { pool } from "../config/db.js";
import { queueNotificationEmail, notificationActionUrl } from "./notificationEmail.service.js";

const dateLabel = (value) => new Date(value).toLocaleString("en-PK", {
  dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Karachi",
});

export async function enqueueInterviewReminders() {
  const [rows] = await pool.query(
    `SELECT i.uuid, i.scheduled_at, i.mode, i.location,
            c.full_name AS candidate_name, c.email AS candidate_email,
            o.title AS opening_title,
            e.email AS interviewer_email, e.linked_user_uuid AS interviewer_user_uuid,
            e.full_name AS interviewer_name
       FROM interviews i
       JOIN candidates c ON c.uuid=i.candidate_uuid AND c.organization_id=i.organization_id
       LEFT JOIN job_openings o ON o.uuid=c.job_opening_uuid AND o.organization_id=c.organization_id
       LEFT JOIN employees e ON e.uuid=i.interviewer_uuid AND e.organization_id=i.organization_id
      WHERE i.status='scheduled'
        AND i.scheduled_at > DATE_ADD(NOW(), INTERVAL 23 HOUR)
        AND i.scheduled_at <= DATE_ADD(NOW(), INTERVAL 24 HOUR)
        AND ((c.email IS NOT NULL AND NOT EXISTS
               (SELECT 1 FROM email_outbox eo WHERE eo.event_key=CONCAT('interview:',i.uuid,':reminder:24h:candidate')))
          OR (i.interviewer_uuid IS NOT NULL AND NOT EXISTS
               (SELECT 1 FROM email_outbox eo WHERE eo.event_key=CONCAT('interview:',i.uuid,':reminder:24h:interviewer'))))`
  );
  for (const row of rows) {
    const when = dateLabel(row.scheduled_at);
    const actionUrl = notificationActionUrl("/org/recruitment/interviews");
    const jobs = [];
    if (row.candidate_email) jobs.push(queueNotificationEmail({
      category: "recruitment", eventKey: `interview:${row.uuid}:reminder:24h:candidate`,
      to: row.candidate_email, subject: `Interview reminder — ${row.opening_title || "your application"}`,
      title: "Your interview is tomorrow",
      message: `Reminder: your interview is scheduled for ${when}${row.mode ? ` (${row.mode})` : ""}${row.location ? ` at ${row.location}` : ""}.`,
      actionUrl,
    }));
    if (row.interviewer_email || row.interviewer_user_uuid) jobs.push(queueNotificationEmail({
      category: "recruitment", eventKey: `interview:${row.uuid}:reminder:24h:interviewer`,
      userUuid: row.interviewer_user_uuid, to: row.interviewer_email,
      subject: `Interview reminder — ${row.candidate_name}`,
      title: "Interview scheduled for tomorrow",
      message: `Reminder: you are scheduled to interview ${row.candidate_name} for ${row.opening_title || "a position"} at ${when}.`,
      actionUrl,
    }));
    await Promise.allSettled(jobs);
  }
}

export async function enqueueOfferResponseReminders() {
  const [rows] = await pool.query(
    `SELECT c.uuid, c.full_name, c.email, c.offer_sent_at, o.title AS opening_title
       FROM candidates c
       JOIN job_openings o ON o.uuid=c.job_opening_uuid AND o.organization_id=c.organization_id
      WHERE c.offer_status='sent' AND c.offer_response_at IS NULL
        AND c.stage IN ('selected','offered')
        AND c.offer_sent_at <= DATE_SUB(NOW(), INTERVAL 5 DAY)
        AND c.offer_sent_at > DATE_SUB(NOW(), INTERVAL 6 DAY)
        AND NOT EXISTS (SELECT 1 FROM email_outbox eo
          WHERE eo.event_key LIKE CONCAT('candidate:',c.uuid,':offer-reminder:%'))
        AND c.email IS NOT NULL AND c.email<>''`
  );
  await Promise.allSettled(rows.map((row) => queueNotificationEmail({
    category: "recruitment",
    eventKey: `candidate:${row.uuid}:offer-reminder:${new Date(row.offer_sent_at).getTime()}`,
    to: row.email,
    subject: `Offer reminder — ${row.opening_title}`,
    title: `A quick reminder about your ${row.opening_title} offer`,
    message: `Your offer is still awaiting a response. Please contact the hiring team if you have questions or need more time.`,
    actionUrl: notificationActionUrl("/"),
  })));
}

export async function enqueueAttendanceDigest() {
  // Organizations currently share the server's configured local workday; once
  // organization time zones are stored, this window can be evaluated per org.
  const [[time]] = await pool.query("SELECT HOUR(CURTIME()) AS hour, DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS day");
  if (Number(time.hour) !== 18) return;
  const [rows] = await pool.query(
    `SELECT e.organization_id, e.uuid employee_uuid, e.full_name, e.linked_user_uuid,
            ar.id attendance_id, ar.check_in_at, ar.check_out_at
       FROM employees e
       LEFT JOIN attendance_records ar ON ar.employee_uuid=e.uuid AND ar.date=CURDATE()
       LEFT JOIN work_week_config w ON w.organization_id=e.organization_id
       LEFT JOIN holidays h ON h.organization_id=e.organization_id AND h.date=CURDATE()
      WHERE e.status IN ('active','current_employee')
        AND h.id IS NULL
        AND COALESCE(CASE DAYOFWEEK(CURDATE())
          WHEN 1 THEN w.sun WHEN 2 THEN w.mon WHEN 3 THEN w.tue WHEN 4 THEN w.wed
          WHEN 5 THEN w.thu WHEN 6 THEN w.fri WHEN 7 THEN w.sat END,
          DAYOFWEEK(CURDATE()) BETWEEN 2 AND 6) = 1
        AND (ar.id IS NULL OR TIME(ar.check_in_at) > '09:30:00' OR ar.check_out_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM email_outbox eo
          WHERE eo.event_key LIKE CONCAT('attendance:digest:',e.organization_id,':',DATE_FORMAT(CURDATE(),'%Y-%m-%d'),':%'))
      ORDER BY e.organization_id, e.full_name`
  );
  const byOrg = new Map();
  for (const row of rows) {
    if (!byOrg.has(row.organization_id)) byOrg.set(row.organization_id, []);
    byOrg.get(row.organization_id).push(row);
  }
  for (const [orgId, exceptions] of byOrg) {
    const names = exceptions.map((row) => {
      const issue = !row.attendance_id ? "absent/no check-in"
        : !row.check_out_at ? "missing check-out"
          : "late check-in";
      return `${row.full_name} — ${issue}`;
    });
    const [[org]] = await pool.query("SELECT name FROM organizations WHERE id=?", [orgId]);
    const [admins] = await pool.query(
      `SELECT uuid FROM users WHERE organization=? AND status='active' AND deleted_at IS NULL
         AND org_role IN ('org_admin','sub_admin')`,
      [orgId]
    );
    await Promise.allSettled(admins.map((admin) => queueNotificationEmail({
      category: "attendance",
      userUuid: admin.uuid,
      eventKey: `attendance:digest:${orgId}:${time.day}:${admin.uuid}`,
      subject: `Attendance exceptions — ${org?.name || "your organization"}`,
      title: "Today's attendance exceptions",
      message: `${exceptions.length} employee attendance exception(s) need review:\n${names.join("\n")}`,
      actionUrl: notificationActionUrl("/org/attendance"),
    })));
  }
}

export async function runScheduledNotificationJobs() {
  await Promise.allSettled([
    enqueueInterviewReminders(),
    enqueueOfferResponseReminders(),
    enqueueAttendanceDigest(),
  ]);
}
