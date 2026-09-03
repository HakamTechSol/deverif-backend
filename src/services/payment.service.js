import { pool } from "../config/db.js";
import ApiError from "../utils/ApiError.js";
import { todayStr } from "../utils/requestQuota.js";

/**
 * Shared subscription activation service. Used by BOTH the Safepay webhook path
 * (auto-activation) and the System-Admin manual confirmation path so that both
 * agree on exactly how an organization's subscription is activated.
 */
export async function activateOrgSubscription(connection, { organizationId, plan, now = new Date() }) {
  const durationMonths = plan.billing_period === "yearly" ? 12 : 1;
  const expiry = new Date(now);
  expiry.setMonth(expiry.getMonth() + durationMonths);
  await connection.query(
    `UPDATE organizations
     SET subscription_status='active', subscription_start=?, subscription_expiry=?,
         subscription_plan=?, subscription_plan_id=?, reminder_2d_sent='no', reminder_2h_sent='no'
     WHERE id=?`,
    [now, expiry, plan.name, plan.id, organizationId]
  );
  return { expiry, duration_months: durationMonths };
}

export async function recordSubscriptionPayment(
  connection,
  { organizationId, amount, method = "manual", transactionReference, purpose }
) {
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) return null;

  const [userRows] = await connection.query(
    "SELECT id FROM users WHERE organization=? ORDER BY created_at ASC LIMIT 1",
    [organizationId]
  );
  if (!userRows.length) return null;

  const fallbackReference = `PAY-${Date.now()}`;
  const fallbackPurpose = "Org subscription";

  const [result] = await connection.query(
    `INSERT INTO payment (user_id, amount, payment_method, transaction_reference, paid_at, purpose)
     VALUES (?, ?, ?, ?, NOW(), ?)`,
    [
      userRows[0].id,
      numericAmount,
      method,
      transactionReference || fallbackReference,
      purpose || fallbackPurpose,
    ]
  );
  return result.insertId;
}

export async function finalizeSuccessfulCheckout({ checkoutId, eventId }) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [checkoutRows] = await connection.query(
      "SELECT * FROM subscription_checkouts WHERE id=? FOR UPDATE",
      [checkoutId]
    );
    if (!checkoutRows.length) throw new ApiError(404, "Checkout not found");
    const checkout = checkoutRows[0];

    if (checkout.status === "completed") {
      await connection.commit();
      return { already_processed: true, subscription: null };
    }

    const [[plan]] = await connection.query(
      "SELECT id, name, monthly_price, billing_period FROM subscription_plans WHERE id=?",
      [checkout.plan_id]
    );
    if (!plan) throw new ApiError(404, "Plan not found");

    const { expiry } = await activateOrgSubscription(connection, {
      organizationId: checkout.organization_id,
      plan,
      now: new Date(),
    });

    await connection.query(
      `UPDATE subscription_checkouts
       SET status='completed', gateway_event_id=?, completed_at=NOW()
       WHERE id=?`,
      [eventId, checkoutId]
    );

    await recordSubscriptionPayment(connection, {
      organizationId: checkout.organization_id,
      amount: Number(plan.monthly_price),
      transactionReference: `SFPY-${plan.name.replace(/\s+/g, "-").toUpperCase()}-${Date.now()}`,
      method: "safepay",
      purpose: `Org subscription: ${plan.name}`,
    });

    // A paid PLAN CHANGE grants the org a fresh daily quota starting today
    // under the new plan — reset today's usage bucket to zero in the same
    // transaction so the quota reflects the new plan immediately.
    const metadata = parseMetadata(checkout.metadata);
    if (metadata?.purpose === "change_plan") {
      await resetTodayUsage(connection, checkout.organization_id);
    }

    await connection.commit();

    return { already_processed: false, subscription: { plan: plan.name, expiry } };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

function parseMetadata(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Reset an organization's today daily_request_usage bucket back to zero. */
async function resetTodayUsage(connection, orgId) {
  const today = todayStr();
  await connection.query(
    `INSERT INTO daily_request_usage (organization_id, date, requests_used, total_requests)
     VALUES (?, ?, 0, 0)
     ON DUPLICATE KEY UPDATE requests_used = 0, total_requests = 0`,
    [orgId, today]
  );
}

export async function markCheckoutFailed({ checkoutId, eventId }) {
  await pool.query(
    `UPDATE subscription_checkouts
     SET status='failed', gateway_event_id=?, failed_at=NOW()
     WHERE id=? AND status NOT IN ('completed', 'failed')`,
    [eventId, checkoutId]
  );
}