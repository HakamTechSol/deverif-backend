import nodemailer from "nodemailer";
import { pool } from "../config/db.js";

function dumpSmtpError(label, err) {
  // TEMP-DEBUG (remove after diagnosis): full raw error incl. non-enumerable props
  const raw = {};
  for (const k of Object.getOwnPropertyNames(err)) {
    try {
      raw[k] = err[k];
    } catch {
      raw[k] = "<unavailable>";
    }
  }
  console.error(`[smtp-debug] RAW Nodemailer error (${label}):`, JSON.stringify(raw, null, 2));
}

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
    auth: { user, pass },
    // Use the sending domain for EHLO + Message-ID instead of the machine's
    // hostname (e.g. "DESKTOP-XXXX" / "ip-10-0-0-1"), which mail filters flag.
    name: process.env.SMTP_EHLO_NAME || user.split("@")[1] || undefined,
    hostname: process.env.SMTP_EHLO_NAME || user.split("@")[1] || undefined,
  });
}

function getFromAddress() {
  const address = process.env.SMTP_FROM || process.env.SMTP_USER;
  const name = process.env.MAIL_FROM_NAME || process.env.APP_NAME || "Dverif";
  return `"${name}" <${address}>`;
}

function getReplyTo() {
  return process.env.MAIL_REPLY_TO || process.env.SMTP_FROM || process.env.SMTP_USER;
}

// Headers for automated transactional mail.
// Deliberately NO "List-Unsubscribe": unsubscribe headers on transactional
// messages (OTP, password reset, invites) mark them as bulk mail and are a
// common reason Gmail files them under Spam. "Auto-Submitted" correctly labels
// the message as machine-generated so providers do not expect engagement.
function transactionalHeaders() {
  return {
    "Auto-Submitted": "auto-generated",
    "X-Auto-Response-Suppress": "All",
  };
}

// Single source of truth for every outbound message so sender identity and
// deliverability headers stay consistent across all notification types.
function buildMail({ to, subject, text, html }) {
  return {
    from: getFromAddress(),
    replyTo: getReplyTo(),
    to,
    subject,
    text,
    html,
    headers: transactionalHeaders(),
  };
}

/**
 * Recipient-facing email copy in the recipient's preferred language.
 * Layout is shared; only the wording changes. English is the default.
 */
function emailTexts(lang) {
  const ur = lang === "ur";
  return {
    // Shared
    footerTagline: ur
      ? "Dverif — دستاویز کی تصدیق کا پلیٹ فارم"
      : "Dverif — Document Verification Platform",
    footerAuto: ur
      ? "یہ ایک خودکار پیغام ہے، براہِ کرم جواب نہ دیں۔"
      : "This is an automated message, please do not reply.",

    // Password reset
    resetSubject: ur ? "اپنا پاس ورڈ تبدیل کریں" : "Reset Your Password",
    resetHeading: ur ? "اپنا پاس ورڈ تبدیل کریں" : "Reset your password",
    resetBody: (appName) =>
      ur
        ? `ہمیں آپ کے ${appName} اکاؤنٹ کا پاس ورڈ تبدیل کرنے کی درخواست موصول ہوئی۔`
        : `We received a request to reset the password for your ${appName} account.`,
    resetLinkLine: (expiry) =>
      ur
        ? `نیا پاس ورڈ منتخب کرنے کے لیے نیچے دیے گئے بٹن پر کلک کریں۔ یہ لنک <strong>${expiry}</strong> میں ختم ہو جائے گا۔`
        : `Click the button below to choose a new password. This link expires in <strong>${expiry}</strong>.`,
    resetButton: ur ? "پاس ورڈ تبدیل کریں" : "Reset Password",
    resetIgnore: ur
      ? "اگر آپ نے یہ درخواست نہیں بھیجی تو اس ای میل کو نظر انداز کریں۔ آپ کا پاس ورڈ تبدیل نہیں ہو گا۔"
      : "If you did not request this, you can safely ignore this email. Your password will remain unchanged.",
    resetTextTitle: ur ? "اپنا پاس ورڈ تبدیل کریں" : "Reset your password",
    resetTextLink: (expiry) =>
      ur
        ? `نیا پاس ورڈ منتخب کرنے کے لیے نیچے دیے گئے لنک پر کلک کریں (${expiry} تک درست):`
        : `Click the link below to choose a new password (valid for ${expiry}):`,
    resetTextIgnore: ur
      ? "اگر آپ نے یہ درخواست نہیں بھیجی تو اس ای میل کو نظر انداز کریں۔"
      : "If you did not request this, you can safely ignore this email.",

    // OTP login
    otpSubject: ur ? "آپ کا لاگ ان کوڈ" : "Your Dverif login code",
    otpHeading: ur ? "آپ کا لاگ ان کوڈ" : "Your login code",
    otpBody: ur
      ? "سائن ان مکمل کرنے کے لیے نیچے دیا گیا کوڈ استعمال کریں۔ یہ کوڈ <strong>5 منٹ</strong> میں ختم ہو جائے گا۔"
      : "Use the code below to complete your sign-in. This code expires in <strong>5 minutes</strong>.",
    otpIgnore: ur
      ? "اگر آپ نے یہ کوڈ نہیں مانگا تو اس ای میل کو نظر انداز کریں۔"
      : "If you did not request this code, you can safely ignore this email.",
    otpTextCode: (otp) =>
      ur ? `آپ کا Dverif لاگ ان کوڈ ہے: ${otp}` : `Your Dverif login code is: ${otp}`,
    otpTextExpiry: ur
      ? "یہ کوڈ 5 منٹ میں ختم ہو جائے گا۔"
      : "This code expires in 5 minutes.",
    otpTextIgnore: ur
      ? "اگر آپ نے یہ کوڈ نہیں مانگا تو اس ای میل کو نظر انداز کریں۔"
      : "If you did not request this code, you can safely ignore this email.",

    // Invite
    inviteSubject: ur ? "آپ کو مدعو کیا گیا ہے" : "Set up your Dverif account",
    inviteHeading: ur ? "آپ کو مدعو کیا گیا ہے!" : "You're invited!",
    inviteIntro: (name, appName) =>
      ur
        ? `${name ? `<strong>${name}</strong> نے آپ کو` : "آپ کو"} ${appName} دستاویز کی تصدیق کے نیٹ ورک میں شامل ہونے کی دعوت دی ہے۔ آپ کا اکاؤنٹ بن چکا ہے — آپ کو صرف اپنا پاس ورڈ سیٹ کرنا ہے۔`
        : `${name ? `<strong>${name}</strong> has invited you` : "You have been invited"} to join the ${appName} document verification network. Your account has been created &mdash; all you need to do is set your password.`,
    inviteButton: ur ? "پاس ورڈ سیٹ کریں" : "Set Your Password",
    inviteExpiry: (hours) =>
      ur
        ? `یہ لنک <strong>${hours} گھنٹے</strong> میں ختم ہو جائے گا۔`
        : `This link expires in <strong>${hours} hours</strong>.`,
    inviteIgnore: ur
      ? "اگر آپ کو اس دعوت کی توقع نہیں تھی تو آپ اس ای میل کو نظر انداز کر سکتے ہیں۔"
      : "If you did not expect this invitation, you can safely ignore this email.",
    inviteTextTitle: (appName) =>
      ur
        ? `آپ کو ${appName} میں شامل ہونے کی دعوت دی گئی ہے!`
        : `Set up your ${appName} account`,
    inviteTextIntro: (name, appName) =>
      ur
        ? `${name ? `${name} نے` : "کسی نے"} آپ کو ${appName} دستاویز کی تصدیق کے نیٹ ورک میں شامل ہونے کی دعوت دی ہے۔`
        : `${name ? `${name} has` : "Someone has"} invited you to join the ${appName} document verification network.`,
    inviteTextCreated: ur
      ? "آپ کا اکاؤنٹ بن چکا ہے — آپ کو صرف اپنا پاس ورڈ سیٹ کرنا ہے۔"
      : "Your account has been created — all you need to do is set your password.",
    inviteTextLink: (hours) =>
      ur
        ? `اپنا پاس ورڈ سیٹ کرنے کے لیے نیچے دیے گئے لنک پر کلک کریں (${hours} گھنٹوں میں ختم ہو جائے گا):`
        : `Click the link below to set your password (expires in ${hours} hours):`,
    inviteTextIgnore: ur
      ? "اگر آپ کو اس دعوت کی توقع نہیں تھی تو آپ اس ای میل کو نظر انداز کر سکتے ہیں۔"
      : "If you did not expect this invitation, you can safely ignore this email.",

    // SLA reminder
    slaBadge: ur ? "تصدیق کی یاد دہانی" : "Verification Reminder",
    slaHeading: ur ? "ایک دستاویز آپ کے جائزے کا انتظار کر رہی ہے" : "A document is waiting for your review",
    slaWaiting: (orgName) =>
      ur
        ? `<strong>${orgName}</strong> کے پاس ایک زیر التوا تصدیقی درخواست ہے جو <strong>3+ دنوں</strong> سے انتظار میں ہے۔`
        : `<strong>${orgName}</strong> has a pending verification request that has been waiting for <strong>3+ days</strong>.`,
    slaDocType: ur ? "دستاویز کی قسم:" : "Document type:",
    slaAction: ur
      ? "براہِ کرم Dverif پورٹل میں لاگ ان ہو کر درخواست کا جائزہ لیں۔ اگر یہ 3+ دنوں تک زیر جواب رہی تو اسے Dverif سپورٹ ٹیم کے پاس بھیج دیا جا سکتا ہے۔"
      : "Please log in to the Dverif portal and review the request. If it stays unanswered for 3+ days, it may be escalated to the Dverif support team for review.",
    slaSubject: (orgName) =>
      ur
        ? `${orgName} کے لیے زیر التوا تصدیقی درخواست`
        : `Pending verification request for ${orgName}`,
    slaTextWaiting: (orgName) =>
      ur
        ? `${orgName} کے پاس ایک زیر التوا تصدیقی درخواست ہے جو 3+ دنوں سے انتظار میں ہے۔`
        : `${orgName} has a pending verification request that has been waiting for 3+ days.`,
    slaTextDocType: ur ? "دستاویز کی قسم:" : "Document type:",
    slaTextAction: ur
      ? "براہِ کرم Dverif پورٹل میں لاگ ان ہو کر درخواست کا جائزہ لیں۔"
      : "Please log in to the Dverif portal and review the request.",

    // Document verified
    verifiedSubject: ur
      ? "آپ کی دستاویز کی تصدیق ہو گئی ہے"
      : "Your document has been verified",
    verifiedHeading: ur
      ? "دستاویز تصدیق شدہ ✅"
      : "Document Verified ✅",
    verifiedBody: (docType) =>
      ur
        ? `آپ کی درخواست (<strong>${docType || "دستاویز"}</strong>) کامیابی سے تصدیق کر دی گئی ہے۔ آپ اپنے پورٹل پر جا کر تصدیق شدہ ریکارڈ اور سرٹیفکیٹ دیکھ سکتے ہیں۔`
        : `Your request (<strong>${docType || "document"}</strong>) has been successfully verified. You can view the verified record and certificate on the portal.`,
    verifiedCheck: ur
      ? "اپنے پورٹل میں لاگ ان ہو کر تفصیلات ضرور دیکھ لیں۔"
      : "Please log in to your portal to review the details.",
    verifiedButton: ur ? "پورٹل پر دیکھیں" : "View on Portal",
    verifiedTextBody: (docType) =>
      ur
        ? `آپ کی درخواست (${docType || "دستاویز"}) کامیابی سے تصدیق کر دی گئی ہے۔`
        : `Your request (${docType || "document"}) has been successfully verified.`,
    verifiedTextCheck: ur
      ? "اپنے پورٹل پر جا کر تصدیق شدہ تفصیلات دیکھیں:"
      : "Check the verified details on your portal:",
  };
}

function emailWrapper(bodyHtml, lang) {
  const T = emailTexts(lang);
  return `<!DOCTYPE html>
<html lang="${lang === "ur" ? "ur" : "en"}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#f4f5f7;font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;padding:40px 0;">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
        <tr><td style="background-color:#1a1a2e;padding:28px 40px;text-align:center;">
          <span style="color:#ffffff;font-size:22px;font-weight:700;letter-spacing:0.5px;">Dverif</span>
        </td></tr>
        ${bodyHtml}
        <tr><td style="background-color:#f9fafb;padding:20px 40px;border-top:1px solid #eee;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr><td style="text-align:center;">
              <span style="color:#999;font-size:12px;">${T.footerTagline}</span>
            </td></tr>
            <tr><td style="padding-top:8px;text-align:center;">
              <span style="color:#bbb;font-size:11px;">${T.footerAuto}</span>
            </td></tr>
          </table>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export async function sendPasswordResetEmail({ to, resetLink, lang = "en" }) {
  const transporter = getMailerTransport();
  if (!transporter) {
    throw new Error("SMTP is not configured. Please set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS");
  }

  const appName = process.env.APP_NAME || "Dverif";
  const expiry = process.env.RESET_PASSWORD_EXPIRES_IN || "15m";
  const T = emailTexts(lang);
  const bodyHtml = `
    <tr><td style="padding:40px;">
      <h2 style="margin:0 0 8px;color:#1a1a2e;font-size:20px;font-weight:600;">${T.resetHeading}</h2>
      <p style="margin:0 0 20px;color:#555;font-size:15px;line-height:1.6;">
        ${T.resetBody(appName)}
      </p>
      <p style="margin:0 0 20px;color:#555;font-size:15px;line-height:1.6;">
        ${T.resetLinkLine(expiry)}
      </p>
      <table cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
        <tr><td>
          <a href="${resetLink}" target="_blank" rel="noopener noreferrer"
             style="display:inline-block;background-color:#1a1a2e;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:6px;">
            ${T.resetButton}
          </a>
        </td></tr>
      </table>
      <p style="margin:0 0 8px;color:#888;font-size:13px;line-height:1.5;">
        ${T.resetIgnore}
      </p>
    </td></tr>`;

  const text = [
    T.resetTextTitle,
    ``,
    T.resetBody(appName).replace(/<[^>]+>/g, ""),
    ``,
    T.resetTextLink(expiry).replace(/<[^>]+>/g, ""),
    resetLink,
    ``,
    T.resetTextIgnore,
  ].join("\n");

  try {
    const info = await transporter.sendMail(
      buildMail({
        to,
        subject: `${appName} — ${T.resetSubject}`,
        text,
        html: emailWrapper(bodyHtml, lang),
      })
    );
    return info;
  } catch (err) {
    dumpSmtpError("sendPasswordResetEmail", err);
    throw err;
  }
}

export async function sendLoginOtpEmail({ to, otp, lang = "en" }) {
  const transporter = getMailerTransport();
  if (!transporter) {
    throw new Error("SMTP is not configured. Please set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS");
  }

  const T = emailTexts(lang);

  const bodyHtml = `
    <tr><td style="padding:40px;">
      <h2 style="margin:0 0 8px;color:#1a1a2e;font-size:20px;font-weight:600;">${T.otpHeading}</h2>
      <p style="margin:0 0 20px;color:#555;font-size:15px;line-height:1.6;">
        ${T.otpBody}
      </p>
      <div style="margin:0 0 24px;background-color:#f4f4f5;border-radius:8px;padding:20px 0;text-align:center;">
        <span style="font-size:32px;font-weight:700;letter-spacing:8px;color:#1a1a2e;font-family:monospace;">${otp}</span>
      </div>
      <p style="margin:0 0 8px;color:#888;font-size:13px;line-height:1.5;">
        ${T.otpIgnore}
      </p>
    </td></tr>`;

  const text = [
    T.otpTextCode(otp),
    ``,
    T.otpTextExpiry,
    ``,
    T.otpTextIgnore,
  ].join("\n");

  await transporter.sendMail(
    buildMail({
      to,
      subject: T.otpSubject,
      text,
      html: emailWrapper(bodyHtml, lang),
    })
  );
}

export async function sendInviteEmail({ to, setLink, invitedByName, lang = "en" }) {
  const transporter = getMailerTransport();
  if (!transporter) {
    throw new Error("SMTP is not configured. Please set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS");
  }

  const appName = process.env.APP_NAME || "Dverif";
  const expiryHours = process.env.INVITE_EXPIRES_IN_HOURS || "72";
  const T = emailTexts(lang);

  const bodyHtml = `
    <tr><td style="padding:40px;">
      <h2 style="margin:0 0 8px;color:#1a1a2e;font-size:20px;font-weight:600;">${T.inviteHeading}</h2>
      <p style="margin:0 0 20px;color:#555;font-size:15px;line-height:1.6;">
        ${T.inviteIntro(invitedByName, appName)}
      </p>
      <table cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
        <tr><td>
          <a href="${setLink}" target="_blank" rel="noopener noreferrer"
             style="display:inline-block;background-color:#1a1a2e;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:6px;">
            ${T.inviteButton}
          </a>
        </td></tr>
      </table>
      <p style="margin:0 0 20px;color:#555;font-size:15px;line-height:1.6;">
        ${T.inviteExpiry(expiryHours)}
      </p>
      <p style="margin:0;color:#888;font-size:13px;line-height:1.5;">
        ${T.inviteIgnore}
      </p>
    </td></tr>`;

  const text = [
    T.inviteTextTitle(appName),
    ``,
    T.inviteTextIntro(invitedByName, appName).replace(/<[^>]+>/g, ""),
    T.inviteTextCreated,
    ``,
    T.inviteTextLink(expiryHours),
    setLink,
    ``,
    T.inviteTextIgnore,
  ].join("\n");

  await transporter.sendMail(
    buildMail({
      to,
      subject: `${appName} — ${T.inviteSubject}`,
      text,
      html: emailWrapper(bodyHtml, lang),
    })
  );
}

export async function sendVerificationResultEmail({ to, documentType, portalLink, lang = "en" }) {
  const transporter = getMailerTransport();
  if (!transporter) {
    console.error("SMTP not configured — skipping verification result email");
    return;
  }

  const appName = process.env.APP_NAME || "Dverif";
  const T = emailTexts(lang);

  const bodyHtml = `
    <tr><td style="padding:40px;">
      <div style="margin:0 0 20px;display:inline-block;background-color:#16a34a10;border:1px solid #16a34a30;border-radius:6px;padding:8px 16px;">
        <span style="color:#16a34a;font-size:13px;font-weight:600;">✓ ${T.verifiedHeading}</span>
      </div>
      <h2 style="margin:0 0 8px;color:#1a1a2e;font-size:20px;font-weight:600;">${T.verifiedHeading}</h2>
      <p style="margin:0 0 16px;color:#555;font-size:15px;line-height:1.6;">
        ${T.verifiedBody(documentType)}
      </p>
      <p style="margin:0 0 24px;color:#555;font-size:15px;line-height:1.6;">
        ${T.verifiedCheck}
      </p>
      <table cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
        <tr><td>
          <a href="${portalLink}" target="_blank" rel="noopener noreferrer"
             style="display:inline-block;background-color:#16a34a;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:6px;">
            ${T.verifiedButton}
          </a>
        </td></tr>
      </table>
    </td></tr>`;

  const text = [
    T.verifiedHeading,
    ``,
    T.verifiedTextBody(documentType),
    ``,
    T.verifiedTextCheck,
    portalLink,
  ].join("\n");

  await transporter.sendMail(
    buildMail({
      to,
      subject: `${appName} — ${T.verifiedSubject}`,
      text,
      html: emailWrapper(bodyHtml, lang),
    })
  );
}

// Sends the verification-result email to the organization the request CAME FROM:
// the org's business email plus all active org admins. If two addresses are the
// same (e.g. business_email == admin email), the email is sent only once.
export async function sendVerificationResultEmailToOrg({ orgId, documentType, portalLink }) {
  if (!orgId) return 0;
  const [orgRows] = await pool.query(
    "SELECT business_email FROM organizations WHERE id=?",
    [orgId]
  );
  const org = orgRows[0];

  const [admins] = await pool.query(
    `SELECT email, preferred_language FROM users
     WHERE organization=? AND org_role='org_admin' AND deleted_at IS NULL AND status='active'`,
    [orgId]
  );

  const recipients = new Map();
  if (org?.business_email) {
    const key = String(org.business_email).trim().toLowerCase();
    if (key) recipients.set(key, { email: org.business_email.trim(), lang: "en" });
  }
  for (const a of admins) {
    const key = a.email ? String(a.email).trim().toLowerCase() : "";
    if (!key || recipients.has(key)) continue;
    recipients.set(key, { email: a.email.trim(), lang: a.preferred_language === "ur" ? "ur" : "en" });
  }

  let sent = 0;
  for (const { email, lang } of recipients.values()) {
    try {
      await sendVerificationResultEmail({ to: email, documentType, portalLink, lang });
      sent += 1;
    } catch (e) {
      console.error(`Failed to send verification result email to ${email}:`, e.message);
    }
  }
  return sent;
}

export async function sendLeadNotificationEmail({ type, data }) {
  const transporter = getMailerTransport();
  if (!transporter) {
    console.error("SMTP not configured — skipping lead notification email");
    return;
  }

  const appName = process.env.APP_NAME || "Dverif";

  const recipientsEnv = (process.env.LEAD_NOTIFICATION_RECIPIENTS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const recipients = recipientsEnv.length ? recipientsEnv : ["dverif26@gmail.com", "contact@dverif.com"];

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

  await transporter.sendMail(
    buildMail({
      to: recipients,
      subject: `${appName} — ${subjectLine}`,
      text,
      html: emailWrapper(bodyHtml),
    })
  );
}

export async function sendExpiryReminderEmail({ to, orgName, type, daysLeft, hoursLeft }) {
  const transporter = getMailerTransport();
  if (!transporter) {
    console.error("SMTP not configured — skipping expiry reminder email");
    return;
  }

  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const appName = process.env.APP_NAME || "Dverif";

  const isUrgent = type === "2h";
  const recipients = Array.isArray(to) ? to : [to || from];
  const timeText = isUrgent ? `${hoursLeft} hour(s)` : `${daysLeft} day(s)`;
  const subjectPrefix = isUrgent ? "Action needed:" : "";
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

  await transporter.sendMail(
    buildMail({
      to: recipients.join(", "),
      subject: `${subjectPrefix} ${appName} — Subscription Expiring for ${orgName}`,
      text,
      html: emailWrapper(bodyHtml),
    })
  );
}

export async function sendSlaReminderEmail({ to, orgName, documentType, lang = "en" }) {
  const transporter = getMailerTransport();
  if (!transporter) {
    console.error("SMTP not configured — skipping SLA reminder email");
    return;
  }

  const appName = process.env.APP_NAME || "Dverif";
  const T = emailTexts(lang);

  const bodyHtml = `
    <tr><td style="padding:40px;">
      <div style="margin:0 0 20px;display:inline-block;background-color:#d9770610;border:1px solid #d9770630;border-radius:6px;padding:8px 16px;">
        <span style="color:#d97706;font-size:13px;font-weight:600;">⏳ ${T.slaBadge}</span>
      </div>
      <h2 style="margin:0 0 8px;color:#1a1a2e;font-size:20px;font-weight:600;">${T.slaHeading}</h2>
      <p style="margin:0 0 16px;color:#555;font-size:15px;line-height:1.6;">
        ${T.slaWaiting(orgName)}
      </p>
      <p style="margin:0 0 16px;color:#555;font-size:15px;line-height:1.6;">
        ${T.slaDocType} <strong>${documentType || "—"}</strong>
      </p>
      <p style="margin:0 0 8px;color:#888;font-size:13px;line-height:1.5;">
        ${T.slaAction}
      </p>
    </td></tr>`;

  const text = [
    T.slaHeading,
    ``,
    T.slaTextWaiting(orgName),
    `${T.slaTextDocType} ${documentType || "—"}`,
    ``,
    T.slaTextAction,
  ].join("\n");

  await transporter.sendMail(
    buildMail({
      to,
      subject: `${appName} — ${T.slaSubject(orgName)}`,
      text,
      html: emailWrapper(bodyHtml, lang),
    })
  );
}