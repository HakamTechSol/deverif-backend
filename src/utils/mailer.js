import nodemailer from "nodemailer";

function toBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).toLowerCase().trim();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

export function getMailerTransport() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !port || !user || !pass) return null;

  return nodemailer.createTransport({
    host,
    port,
    secure: toBool(process.env.SMTP_SECURE, port === 465),
    auth: { user, pass }
  });
}

function emailWrapper(bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#f4f5f7;font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;padding:40px 0;">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
        <tr><td style="background-color:#1a1a2e;padding:28px 40px;text-align:center;">
          <span style="color:#ffffff;font-size:22px;font-weight:700;letter-spacing:0.5px;">Dvarif</span>
        </td></tr>
        ${bodyHtml}
        <tr><td style="background-color:#f9fafb;padding:20px 40px;border-top:1px solid #eee;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr><td style="text-align:center;">
              <span style="color:#999;font-size:12px;">Dvarif &mdash; Document Verification Platform</span>
            </td></tr>
            <tr><td style="padding-top:8px;text-align:center;">
              <span style="color:#bbb;font-size:11px;">This is an automated message, please do not reply.</span>
            </td></tr>
          </table>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export async function sendPasswordResetEmail({ to, resetLink }) {
  const transporter = getMailerTransport();
  if (!transporter) {
    throw new Error("SMTP is not configured. Please set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS");
  }

  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const appName = process.env.APP_NAME || "Dvarif";
  const expiry = process.env.RESET_PASSWORD_EXPIRES_IN || "15m";

  const bodyHtml = `
    <tr><td style="padding:40px;">
      <h2 style="margin:0 0 8px;color:#1a1a2e;font-size:20px;font-weight:600;">Reset your password</h2>
      <p style="margin:0 0 20px;color:#555;font-size:15px;line-height:1.6;">
        We received a request to reset the password for your ${appName} account.
      </p>
      <p style="margin:0 0 20px;color:#555;font-size:15px;line-height:1.6;">
        Click the button below to choose a new password. This link expires in <strong>${expiry}</strong>.
      </p>
      <table cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
        <tr><td>
          <a href="${resetLink}" target="_blank" rel="noopener noreferrer"
             style="display:inline-block;background-color:#1a1a2e;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:6px;">
            Reset Password
          </a>
        </td></tr>
      </table>
      <p style="margin:0 0 8px;color:#888;font-size:13px;line-height:1.5;">
        If you did not request this, you can safely ignore this email. Your password will remain unchanged.
      </p>
    </td></tr>`;

  const text = [
    `Reset your password`,
    ``,
    `We received a request to reset the password for your ${appName} account.`,
    ``,
    `Click the link below to choose a new password (valid for ${expiry}):`,
    resetLink,
    ``,
    `If you did not request this, you can safely ignore this email.`,
  ].join("\n");

  await transporter.sendMail({
    from: `"${appName}" <${from}>`,
    to,
    subject: `${appName} — Reset Your Password`,
    text,
    html: emailWrapper(bodyHtml),
    headers: {
      "X-Mailer": "Dvarif",
      "List-Unsubscribe": `<mailto:${from}?subject=unsubscribe>`,
    },
  });
}

export async function sendInviteEmail({ to, setLink, invitedByName }) {
  const transporter = getMailerTransport();
  if (!transporter) {
    throw new Error("SMTP is not configured. Please set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS");
  }

  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const appName = process.env.APP_NAME || "Dvarif";
  const expiryHours = process.env.INVITE_EXPIRES_IN_HOURS || "72";

  const bodyHtml = `
    <tr><td style="padding:40px;">
      <h2 style="margin:0 0 8px;color:#1a1a2e;font-size:20px;font-weight:600;">You're invited!</h2>
      <p style="margin:0 0 20px;color:#555;font-size:15px;line-height:1.6;">
        ${invitedByName ? `<strong>${invitedByName}</strong> has invited you` : 'You have been invited'} to join the ${appName} document verification network.
        Your account has been created &mdash; all you need to do is set your password.
      </p>
      <table cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
        <tr><td>
          <a href="${setLink}" target="_blank" rel="noopener noreferrer"
             style="display:inline-block;background-color:#1a1a2e;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:6px;">
            Set Your Password
          </a>
        </td></tr>
      </table>
      <p style="margin:0 0 20px;color:#555;font-size:15px;line-height:1.6;">
        This link expires in <strong>${expiryHours} hours</strong>.
      </p>
      <p style="margin:0;color:#888;font-size:13px;line-height:1.5;">
        If you did not expect this invitation, you can safely ignore this email.
      </p>
    </td></tr>`;

  const text = [
    `You're invited to join ${appName}!`,
    ``,
    `${invitedByName ? `${invitedByName} has` : 'Someone has'} invited you to join the ${appName} document verification network.`,
    `Your account has been created — all you need to do is set your password.`,
    ``,
    `Click the link below to set your password (expires in ${expiryHours} hours):`,
    setLink,
    ``,
    `If you did not expect this invitation, you can safely ignore this email.`,
  ].join("\n");

  await transporter.sendMail({
    from: `"${appName}" <${from}>`,
    to,
    subject: `${appName} — You're Invited to Join`,
    text,
    html: emailWrapper(bodyHtml),
    headers: {
      "X-Mailer": "Dvarif",
      "List-Unsubscribe": `<mailto:${from}?subject=unsubscribe>`,
    },
  });
}

export async function sendLeadNotificationEmail({ type, data }) {
  const transporter = getMailerTransport();
  if (!transporter) {
    console.error("SMTP not configured — skipping lead notification email");
    return;
  }

  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const appName = process.env.APP_NAME || "Dvarif";

  const isContact = type === "contact";
  const subjectLine = isContact
    ? `New Contact Form Submission from ${data.name}`
    : `New Access Request from ${data.contact_name || data.organization_name}`;

  const detailsHtml = Object.entries(data)
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `<tr><td style="padding:4px 0;color:#888;font-size:13px;font-weight:600;text-transform:capitalize;vertical-align:top;white-space:nowrap;padding-right:12px;">${k.replace(/_/g, " ")}</td><td style="padding:4px 0;color:#333;font-size:13px;">${v}</td></tr>`)
    .join("");

  const bodyHtml = `
    <tr><td style="padding:40px;">
      <h2 style="margin:0 0 8px;color:#1a1a2e;font-size:20px;font-weight:600;">${subjectLine}</h2>
      <p style="margin:0 0 20px;color:#555;font-size:15px;line-height:1.6;">
        A new ${isContact ? "contact form" : "access request"} was submitted on the marketing website.
      </p>
      <table cellpadding="0" cellspacing="0" style="margin:0 0 24px;width:100%;">
        ${detailsHtml}
      </table>
      <p style="margin:0;color:#888;font-size:13px;line-height:1.5;">
        Review this lead in the admin panel.
      </p>
    </td></tr>`;

  const text = [
    subjectLine,
    "",
    `A new ${isContact ? "contact form" : "access request"} was submitted.`,
    "",
    ...Object.entries(data)
      .filter(([, v]) => v != null && v !== "")
      .map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`),
    "",
    "Review this lead in the admin panel.",
  ].join("\n");

  await transporter.sendMail({
    from: `"${appName}" <${from}>`,
    to: from,
    subject: `${appName} — ${subjectLine}`,
    text,
    html: emailWrapper(bodyHtml),
    headers: {
      "X-Mailer": "Dvarif",
      "List-Unsubscribe": `<mailto:${from}?subject=unsubscribe>`,
    },
  });
}

export async function sendExpiryReminderEmail({ orgName, type, daysLeft, hoursLeft }) {
  const transporter = getMailerTransport();
  if (!transporter) {
    console.error("SMTP not configured — skipping expiry reminder email");
    return;
  }

  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const appName = process.env.APP_NAME || "Dvarif";

  const isUrgent = type === "2h";
  const timeText = isUrgent ? `${hoursLeft} hour(s)` : `${daysLeft} day(s)`;
  const subjectPrefix = isUrgent ? "URGENT:" : "";
  const accentColor = isUrgent ? "#dc2626" : "#d97706";

  const bodyHtml = `
    <tr><td style="padding:40px;">
      <div style="margin:0 0 20px;display:inline-block;background-color:${accentColor}10;border:1px solid ${accentColor}30;border-radius:6px;padding:8px 16px;">
        <span style="color:${accentColor};font-size:13px;font-weight:600;">⚠ Subscription Expiry ${isUrgent ? "Warning" : "Reminder"}</span>
      </div>
      <h2 style="margin:0 0 8px;color:#1a1a2e;font-size:20px;font-weight:600;">Your subscription is expiring soon</h2>
      <p style="margin:0 0 16px;color:#555;font-size:15px;line-height:1.6;">
        The subscription for <strong>${orgName}</strong> will expire in <strong>${timeText}</strong>.
      </p>
      <p style="margin:0 0 16px;color:#555;font-size:15px;line-height:1.6;">
        After expiry, your organization will not be able to create or verify documents until the subscription is renewed.
      </p>
      <p style="margin:0 0 8px;color:#888;font-size:13px;line-height:1.5;">
        Please contact your administrator to renew the subscription.
      </p>
    </td></tr>`;

  const text = [
    `Subscription Expiry ${isUrgent ? "Warning" : "Reminder"}`,
    ``,
    `The subscription for ${orgName} will expire in ${timeText}.`,
    ``,
    `After expiry, your organization will not be able to create or verify documents until the subscription is renewed.`,
    ``,
    `Please contact your administrator to renew the subscription.`,
  ].join("\n");

  await transporter.sendMail({
    from: `"${appName}" <${from}>`,
    to: from,
    subject: `${subjectPrefix} ${appName} — Subscription Expiring for ${orgName}`,
    text,
    html: emailWrapper(bodyHtml),
    headers: {
      "X-Mailer": "Dvarif",
      "List-Unsubscribe": `<mailto:${from}?subject=unsubscribe>`,
    },
  });
}
