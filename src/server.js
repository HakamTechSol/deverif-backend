import dotenv from "dotenv";
dotenv.config();
import app from "./app.js";
import { pool } from "./config/db.js";
import { checkAndSendExpiryReminders } from "./controllers/admin/organizations.controller.js";
import { applyDueSubscriptionChanges } from "./services/subscriptionLifecycle.service.js";
import { assertVerifyBaseUrlConfigured } from "./utils/qrCertificate.js";

const PORT = process.env.PORT || 5000;

// Guard: if Safepay is the configured payment gateway, the webhook secret MUST be
// present. Without it every payment webhook is rejected 401 and a successful paid
// checkout silently never activates the subscription. Fail fast at boot instead of
// breaking payments at runtime. A webhook secret is only required in test/live mode
// (a missing secret is ignored when the provider is not safepay).
const gatewayProvider = String(process.env.PAYMENT_GATEWAY_PROVIDER || "").toLowerCase();
const gatewayMode = String(process.env.PAYMENT_GATEWAY_MODE || "").toLowerCase();
const webhookSecret = String(process.env.PAYMENT_GATEWAY_WEBHOOK_SECRET || "").trim();

// Checked before the boot sequence, and deliberately outside the try below so a
// bad value is never reported as "DB connection failed".
//
// The verify base URL is the one setting whose absence still produces output
// that looks correct -- a certificate with a plausible QR printed on it -- so
// the failure is otherwise invisible until a member of the public scans one and
// lands somewhere wrong. In production this is fatal; elsewhere it warns, since
// refusing to boot a test run helps nobody.
try {
  assertVerifyBaseUrlConfigured();
} catch (err) {
  console.error("❌ " + err.message);
  process.exit(1);
}

(async () => {
  try {
    await pool.query("SELECT 1");
    console.log("✅ DB connected");

    if (gatewayProvider === "safepay" && !webhookSecret) {
      console.error(
        "❌ PAYMENT_GATEWAY_WEBHOOK_SECRET is not set for provider=safepay (mode=" +
          (gatewayMode || "?") +
          ").\n" +
          "   Every Safepay payment webhook will be rejected and subscriptions will never auto-activate.\n" +
          "   Set it in backend/.env to the webhook secret from the Safepay dashboard (Developer → Webhooks)."
      );
      process.exit(1);
    }

    app.listen(PORT, () => console.log(`✅ Server running on http://localhost:${PORT}`));

    // ONE periodic subscription-maintenance timer. It runs both halves of
    // subscription lifecycle upkeep so a second, competing interval is never
    // introduced:
    //   1. expiry reminders for subscriptions about to lapse
    //   2. resolving the end of a paid period -- applying a scheduled plan
    //      change, or falling back to the Free plan when nothing was scheduled
    // The two are independent (one is best-effort notification, the other is a
    // state change) so a failure in one must not stop the other.
    const runSubscriptionMaintenance = async () => {
      await checkAndSendExpiryReminders().catch(() => {});
      await applyDueSubscriptionChanges().catch(() => {});
    };

    runSubscriptionMaintenance().catch(() => {});
    setInterval(() => runSubscriptionMaintenance().catch(() => {}), 60 * 60 * 1000);
  } catch (e) {
    console.error("❌ DB connection failed:", e.message);
    process.exit(1);
  }
})();
