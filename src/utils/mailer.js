import nodemailer from "nodemailer";
import { pool } from "../config/db.js";

// ─────────────────────────────────────────────────────────────
// Brand
// ─────────────────────────────────────────────────────────────
const NAVY = "#1e3f8f";
const BLUE = "#2563eb";
const SOFT = "#eff6ff";
const INK = "#0f172a";
const BODY = "#475569";
const MUTED = "#64748b";
const BORDER = "#e2e8f0";

const BADGES = {
  success: { fg: "#15803d", bg: "#f0fdf4", bd: "#bbf7d0" },
  warn: { fg: "#b45309", bg: "#fffbeb", bd: "#fde68a" },
  danger: { fg: "#b91c1c", bg: "#fef2f2", bd: "#fecaca" },
  info: { fg: NAVY, bg: SOFT, bd: "#bfdbfe" },
};

const FONT = "Arial,'Segoe UI',Tahoma,'Noto Nastaliq Urdu',sans-serif";

// Logo: hosted on a public HTTPS URL (EMAIL_LOGO_URL), exactly how large
// companies do it. It is NOT attached to the message, so Gmail/Outlook do not
// show a "logo.png" attachment chip in the inbox. If the env var is not set
// (e.g. local dev) a text wordmark is shown instead.
function logoSrc() {
  return process.env.EMAIL_LOGO_URL || null;
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
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

// Escape anything user/DB-supplied before it goes into HTML.
function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

// ─────────────────────────────────────────────────────────────
// Copy (English / Urdu)
// ─────────────────────────────────────────────────────────────
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
    linkFallback: ur
      ? "اگر بٹن کام نہ کرے تو یہ لنک اپنے براؤزر میں کاپی کریں:"
      : "If the button doesn't work, copy and paste this link into your browser:",

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
      ? "اگر آپ نے یہ کوڈ نہیں مانگا تو اس ای میل کو نظر انداز کریں۔ یہ کوڈ کسی کے ساتھ شیئر نہ کریں۔"
      : "If you did not request this code, you can safely ignore this email. Never share this code with anyone.",
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
    verifiedBadge: ur ? "تصدیق شدہ" : "Verified",
    verifiedHeading: ur ? "دستاویز کی تصدیق ہو گئی" : "Your document has been verified",
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

// ─────────────────────────────────────────────────────────────
// Template building blocks
// ─────────────────────────────────────────────────────────────
const align = (lang) => (lang === "ur" ? "right" : "left");

function h1(text) {
  return `<h1 style="margin:0 0 14px;color:${INK};font-size:22px;line-height:1.4;font-weight:700;font-family:${FONT};">${text}</h1>`;
}

function p(html, { small = false, muted = false } = {}) {
  const size = small ? "13px" : "15px";
  const color = muted ? MUTED : BODY;
  return `<p style="margin:0 0 16px;color:${color};font-size:${size};font-family:${FONT};">${html}</p>`;
}

function badge(text, kind = "info") {
  const b = BADGES[kind];
  return `<div style="margin:0 0 18px;"><span style="display:inline-block;padding:6px 14px;border-radius:999px;background-color:${b.bg};border:1px solid ${b.bd};color:${b.fg};font-size:12px;font-weight:700;letter-spacing:0.4px;font-family:${FONT};">&#9679;&nbsp; ${esc(text)}</span></div>`;
}

function button(href, label, lang, color = NAVY) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="${align(lang)}" style="margin:8px 0 22px;">
    <tr><td align="center" bgcolor="${color}" style="border-radius:8px;">
      <a href="${esc(href)}" target="_blank" rel="noopener noreferrer"
         style="display:inline-block;padding:14px 36px;font-family:${FONT};font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:8px;">${label}</a>
    </td></tr>
  </table>
  <div style="clear:both;"></div>`;
}

function linkFallback(href, lang) {
  const T = emailTexts(lang);
  return `<p style="margin:0 0 20px;color:${MUTED};font-size:12px;font-family:${FONT};">${T.linkFallback}<br>
    <a href="${esc(href)}" target="_blank" rel="noopener noreferrer" style="color:${BLUE};word-break:break-all;">${esc(href)}</a></p>`;
}

function note(html) {
  return `<div style="margin-top:8px;padding-top:16px;border-top:1px solid ${BORDER};color:${MUTED};font-size:13px;font-family:${FONT};">${html}</div>`;
}

function infoBox(rows) {
  const visible = rows.filter(([, v]) => v !== undefined && v !== null && v !== "");
  const body = visible
    .map(
      ([label, value], i) => `<tr><td style="padding:12px 18px;${i < visible.length - 1 ? "border-bottom:1px solid #dbeafe;" : ""}">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase;color:${MUTED};font-family:${FONT};">${esc(label)}</div>
        <div style="padding-top:3px;font-size:15px;font-weight:700;color:${INK};font-family:${FONT};">${esc(value)}</div>
      </td></tr>`
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${SOFT}"
      style="margin:0 0 22px;background-color:${SOFT};border:1px solid #dbeafe;border-radius:8px;">${body}</table>`;
}

function otpBox(otp) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 22px;">
    <tr><td align="center" bgcolor="${SOFT}" style="background-color:${SOFT};border:1px solid #bfdbfe;border-radius:10px;padding:22px 0;">
      <span style="font-size:34px;font-weight:700;letter-spacing:10px;color:${NAVY};font-family:'Courier New',Courier,monospace;">${esc(otp)}</span>
    </td></tr>
  </table>`;
}

function emailWrapper(bodyHtml, lang = "en", preheader = "") {
  const T = emailTexts(lang);
  const ur = lang === "ur";
  const src = logoSrc();
  const logo = src
    ? `<img src="${src}" alt="Dverif" height="44" style="display:block;height:44px;width:auto;border:0;outline:none;text-decoration:none;">`
    : `<span style="color:${NAVY};font-size:26px;font-weight:800;letter-spacing:0.5px;font-family:${FONT};">Dverif</span>`;
  const year = new Date().getFullYear();

  return `<!DOCTYPE html>
<html lang="${ur ? "ur" : "en"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta name="color-scheme" content="light">
<title>Dverif</title>
</head>
<body style="margin:0;padding:0;background-color:#eef2f7;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;font-size:1px;line-height:1px;">${esc(preheader)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#eef2f7;padding:32px 12px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
             style="width:100%;max-width:600px;background-color:#ffffff;border:1px solid ${BORDER};border-radius:12px;overflow:hidden;">
        <!-- accent stripe -->
        <tr><td height="6" style="height:6px;line-height:6px;font-size:0;background-color:${NAVY};border-bottom:2px solid ${BLUE};">&nbsp;</td></tr>
        <!-- header -->
        <tr><td style="padding:24px 40px 20px;border-bottom:1px solid ${BORDER};" align="left">${logo}</td></tr>
        <!-- body -->
        <tr><td dir="${ur ? "rtl" : "ltr"}" style="padding:36px 40px 32px;text-align:${align(lang)};font-family:${FONT};line-height:${ur ? "2" : "1.7"};">
          ${bodyHtml}
        </td></tr>
        <!-- footer -->
        <tr><td align="center" bgcolor="${NAVY}" style="background-color:${NAVY};padding:24px 40px;">
          <div style="color:#ffffff;font-size:13px;font-weight:700;font-family:${FONT};">${T.footerTagline}</div>
          <div style="padding-top:6px;color:#bfdbfe;font-size:12px;font-family:${FONT};">${T.footerAuto}</div>
          <div style="padding-top:12px;color:#93c5fd;font-size:11px;font-family:${FONT};">&copy; ${year} Dverif. All rights reserved.</div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function requireTransport() {
  const transporter = getMailerTransport();
  if (!transporter) {
    throw new Error("SMTP is not configured. Please set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS");
  }
  return transporter;
}

// ─────────────────────────────────────────────────────────────
// Emails
// ─────────────────────────────────────────────────────────────
export async function sendPasswordResetEmail({ to, resetLink, lang = "en" }) {
  const transporter = requireTransport();

  const appName = process.env.APP_NAME || "Dverif";
  const expiry = process.env.RESET_PASSWORD_EXPIRES_IN || "15m";
  const T = emailTexts(lang);

  const bodyHtml = [
    badge(T.resetHeading, "info"),
    h1(T.resetHeading),
    p(T.resetBody(esc(appName))),
    p(T.resetLinkLine(esc(expiry))),
    button(resetLink, T.resetButton, lang),
    linkFallback(resetLink, lang),
    note(T.resetIgnore),
  ].join("");

  const text = [
    T.resetTextTitle,
    ``,
    T.resetBody(appName),
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
        html: emailWrapper(bodyHtml, lang, T.resetHeading),
      })
    );
    return info;
  } catch (err) {
    dumpSmtpError("sendPasswordResetEmail", err);
    throw err;
  }
}

export async function sendLoginOtpEmail({ to, otp, lang = "en" }) {
  const transporter = requireTransport();
  const T = emailTexts(lang);

  const bodyHtml = [
    h1(T.otpHeading),
    p(T.otpBody),
    otpBox(otp),
    note(T.otpIgnore),
  ].join("");

  const text = [T.otpTextCode(otp), ``, T.otpTextExpiry, ``, T.otpTextIgnore].join("\n");

  await transporter.sendMail(
    buildMail({
      to,
      subject: T.otpSubject,
      text,
      html: emailWrapper(bodyHtml, lang, T.otpTextCode(otp)),
    })
  );
}

export async function sendInviteEmail({ to, setLink, invitedByName, lang = "en" }) {
  const transporter = requireTransport();

  const appName = process.env.APP_NAME || "Dverif";
  const expiryHours = process.env.INVITE_EXPIRES_IN_HOURS || "72";
  const T = emailTexts(lang);

  const bodyHtml = [
    h1(T.inviteHeading),
    p(T.inviteIntro(invitedByName ? esc(invitedByName) : "", esc(appName))),
    button(setLink, T.inviteButton, lang),
    p(T.inviteExpiry(esc(expiryHours))),
    linkFallback(setLink, lang),
    note(T.inviteIgnore),
  ].join("");

  const text = [
    T.inviteTextTitle(appName),
    ``,
    T.inviteTextIntro(invitedByName, appName),
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
      html: emailWrapper(bodyHtml, lang, T.inviteTextTitle(appName)),
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

  const bodyHtml = [
    badge(T.verifiedBadge, "success"),
    h1(T.verifiedHeading),
    p(T.verifiedBody(esc(documentType))),
    p(T.verifiedCheck),
    button(portalLink, T.verifiedButton, lang, "#15803d"),
    linkFallback(portalLink, lang),
  ].join("");

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
      html: emailWrapper(bodyHtml, lang, T.verifiedTextBody(documentType)),
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

  const rows = Object.entries(data)
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => [k.replace(/_/g, " "), v]);

  const bodyHtml = [
    badge(isContact ? "New Contact Message" : "New Access Request", "info"),
    h1(esc(subjectLine)),
    p(`A new ${isContact ? "contact form" : "access request"} was submitted on the marketing website.`),
    infoBox(rows),
    p("Review this lead in the admin panel.", { small: true, muted: true }),
  ].join("");

  const text = [
    subjectLine,
    "",
    `A new ${isContact ? "contact form" : "access request"} was submitted.`,
    "",
    ...rows.map(([k, v]) => `${k}: ${v}`),
    "",
    "Review this lead in the admin panel.",
  ].join("\n");

  await transporter.sendMail(
    buildMail({
      to: recipients,
      subject: `${appName} — ${subjectLine}`,
      text,
      html: emailWrapper(bodyHtml, "en", subjectLine),
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

  const bodyHtml = [
    badge(`Subscription Expiry ${isUrgent ? "Warning" : "Reminder"}`, isUrgent ? "danger" : "warn"),
    h1("Your subscription is expiring soon"),
    p(`The subscription for <strong>${esc(orgName)}</strong> will expire in <strong>${esc(timeText)}</strong>.`),
    infoBox([
      ["Organization", orgName],
      ["Expires in", timeText],
    ]),
    p("After expiry, your organization will not be able to create or verify documents until the subscription is renewed."),
    note("Please contact your administrator to renew the subscription."),
  ].join("");

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
      subject: `${subjectPrefix} ${appName} — Subscription Expiring for ${orgName}`.trim(),
      text,
      html: emailWrapper(bodyHtml, "en", `Subscription for ${orgName} expires in ${timeText}`),
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

  const bodyHtml = [
    badge(T.slaBadge, "warn"),
    h1(T.slaHeading),
    p(T.slaWaiting(esc(orgName))),
    infoBox([[T.slaDocType.replace(/[:：]\s*$/, ""), documentType || "—"]]),
    note(T.slaAction),
  ].join("");

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
      html: emailWrapper(bodyHtml, lang, T.slaTextWaiting(orgName)),
    })
  );
}