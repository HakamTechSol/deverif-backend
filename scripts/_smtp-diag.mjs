import nodemailer from "nodemailer";
import dotenv from "dotenv";

dotenv.config({ path: "E:/Office Projects/Dvarif/Zbackup/backend/.env" });

const pass = process.env.SMTP_PASS || "";
console.log("SMTP_HOST:", process.env.SMTP_HOST);
console.log("SMTP_PORT:", process.env.SMTP_PORT);
console.log("SMTP_USER:", process.env.SMTP_USER);
console.log("PASS length:", pass.length);
console.log("PASS (no spaces) length:", pass.replace(/\s+/g, "").length);

const variants = [
  ["as-is", pass],
  ["strip spaces", pass.replace(/\s+/g, "")],
];

for (const [label, p] of variants) {
  console.log(`\n=== Testing variant: ${label} ===`);
  const t = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: p },
    tls: { rejectUnauthorized: false },
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    socketTimeout: 20000,
  });
  try {
    const ok = await t.verify();
    console.log("  RESULT: SUCCESS ->", ok);
    await t.close();
    break;
  } catch (e) {
    console.log("  RESULT: FAIL");
    console.log("  code:", e.code, "| command:", e.command, "| responseCode:", e.responseCode);
    console.log("  message:", e.message);
    try { await t.close(); } catch {}
  }
}
process.exit(0);