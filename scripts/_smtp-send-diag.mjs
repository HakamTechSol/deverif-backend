import "dotenv/config";
import { sendLoginOtpEmail, sendPasswordResetEmail, sendInviteEmail, sendVerificationResultEmail, sendLeadNotificationEmail } from "../src/utils/mailer.js";

const to = process.env.SMTP_USER;

async function step(label, fn) {
  console.log(`\n--- ${label} ---`);
  try {
    const r = await fn();
    console.log("  OK:", JSON.stringify(r));
  } catch (e) {
    console.log("  THREW:", e && e.message);
    console.log("  code:", e && e.code, "cmd:", e && e.command, "rc:", e && e.responseCode);
    if (e && e.response) console.log("  response:", e.response);
  }
}

await step("sendLoginOtpEmail", () => sendLoginOtpEmail({ to, name: "Diag User", otp: "123456" }));
await step("sendPasswordResetEmail", () => sendPasswordResetEmail({ to, name: "Diag User", resetLink: "http://localhost:8080/reset-password?token=abc" }));
await step("sendInviteEmail", () => sendInviteEmail({ to, orgName: "Diag Org", inviterName: "Admin", inviteLink: "http://localhost:8080/set-password?token=abc" }));
await step("sendVerificationResultEmail", () => sendVerificationResultEmail({ to, orgName: "Diag Org", documentType: "CNIC", status: "verified", reference: "REF-1" }));
await step("sendLeadNotificationEmail", () => sendLeadNotificationEmail({ recipients: [to], name: "Lead", email: to, message: "test", source: "contact" }));

process.exit(0);