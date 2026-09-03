import fs from "node:fs/promises";
import path from "node:path";

const LOG_DIR = path.resolve("logs");
const LOG_FILE = path.join(LOG_DIR, "payment-gateway.log");

const SENSITIVE_KEYS = new Set([
  "signature",
  "raw_body",
  "secret",
  "webhook_secret",
  "merchant_secret",
  "authorization",
  "headers",
  "password",
]);

function purgeSensitive(entry) {
  const clean = {};
  for (const [key, value] of Object.entries(entry || {})) {
    if (SENSITIVE_KEYS.has(String(key).toLowerCase())) continue;
    clean[key] = value;
  }
  return clean;
}

export async function logPaymentEvent(entry) {
  const safe = purgeSensitive(entry);
  const line = `${new Date().toISOString()} ${JSON.stringify(safe)}\n`;
  try {
    await fs.mkdir(LOG_DIR, { recursive: true });
    await fs.appendFile(LOG_FILE, line, "utf8");
  } catch (err) {
    console.error("payment-gateway log write failed:", err.message);
  }
  if (safe.level === "warn") {
    console.warn("payment-gateway:", safe.message);
  } else if (safe.level === "error") {
    console.error("payment-gateway:", safe.message);
  } else {
    console.log("payment-gateway:", safe.message);
  }
}