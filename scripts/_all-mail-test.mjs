import "dotenv/config";
import * as M from "../src/utils/mailer.js";

const to = process.env.SMTP_USER;
const results = [];

async function step(label, fn) {
  try {
    await fn();
    results.push(["PASS", label]);
  } catch (e) {
    results.push(["FAIL", `${label} :: ${e.code || ""} ${e.responseCode || ""} ${e.message}`]);
  }
}

await step("sendLoginOtpEmail", () => M.sendLoginOtpEmail({ to, otp: "482913", lang: "en" }));
await step("sendLoginOtpEmail[ur]", () => M.sendLoginOtpEmail({ to, otp: "482913", lang: "ur" }));
await step("sendPasswordResetEmail", () => M.sendPasswordResetEmail({ to, resetLink: "http://localhost:8080/reset-password?token=abc", lang: "en" }));
await step("sendInviteEmail", () => M.sendInviteEmail({ to, setLink: "http://localhost:8080/set-password?token=abc", invitedByName: "Admin", lang: "en" }));
await step("sendVerificationResultEmail", () => M.sendVerificationResultEmail({ to, documentType: "CNIC", portalLink: "http://localhost:8080/dashboard", lang: "en" }));
await step("sendVerificationResultEmailToOrg", () => M.sendVerificationResultEmailToOrg({ orgId: 1, documentType: "CNIC", portalLink: "http://localhost:8080/dashboard" }));
await step("sendLeadNotificationEmail[contact]", () => M.sendLeadNotificationEmail({ type: "contact", data: { name: "Diag", email: "diag@test.com", phone: "0300", message: "hi" } }));
await step("sendLeadNotificationEmail[access]", () => M.sendLeadNotificationEmail({ type: "access_request", data: { organization_name: "DiagOrg", contact_name: "Diag", email: "diag@test.com" } }));
await step("sendExpiryReminderEmail", () => M.sendExpiryReminderEmail({ to, orgName: "DiagOrg", type: "2d", daysLeft: 2, hoursLeft: 0 }));
await step("sendSlaReminderEmail", () => M.sendSlaReminderEmail({ to, orgName: "DiagOrg", documentType: "CNIC", lang: "en" }));
await step("sendRecruitmentOfferEmail", () => M.sendRecruitmentOfferEmail({ to, candidateName: "Diag", openingTitle: "Engineer", renderedBody: "Body text" }));

console.log("\n================ RESULTS ================");
for (const [s, l] of results) console.log(`${s === "PASS" ? "OK  " : "FAIL"}  ${l}`);
console.log(`\n${results.filter((r) => r[0] === "PASS").length}/${results.length} passed`);
process.exit(0);