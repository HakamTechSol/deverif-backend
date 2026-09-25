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
         subscription_plan_id=?, reminder_2d_sent='no', reminder_2h_sent='no'
     WHERE id=?`,
    [now, expiry, plan.id, organizationId]
  );
  return { expiry, duration_months: durationMonths };
}

export async function recordSubscriptionPayment(
  connection,
  { organizationId, amount, method = "manual", transactionReference, purpose }
) {
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) return null;

  // Payment rows are deduplicated by transaction_reference (UNIQUE key
  // uq_payment_txn_ref). A missing reference must never be papered over with a
  // generated PAY-<now> value — that would falsely look unique and defeat the
  // dedup boundary — so an empty reference is rejected outright.
  const reference = typeof transactionReference === "string" ? transactionReference.trim() : "";
  if (!reference) {
    throw new ApiError(400, "Transaction reference is required to record a payment");
  }

  const [userRows] = await connection.query(
    "SELECT id, organization FROM users WHERE organization=? ORDER BY created_at ASC LIMIT 1",
    [organizationId]
  );
  if (!userRows.length) return null;

  const fallbackPurpose = "Org subscription";

  const [result] = await connection.query(
    `INSERT INTO payment (user_id, organization_id, amount, payment_method, transaction_reference, paid_at, purpose)
     VALUES (?, ?, ?, ?, ?, NOW(), ?)`,
    [
      userRows[0].id,
      userRows[0].organization,
      numericAmount,
      method,
      reference,
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

    // Serialize on the organization row BEFORE deciding whether this delivery
    // was already processed, so a concurrent duplicate webhook — or a competing
    // activation from the manual admin path for the same org — queues behind
    // the first commit instead of both extending the subscription.
    const [[org]] = await connection.query(
      "SELECT id FROM organizations WHERE id=? FOR UPDATE",
      [checkout.organization_id]
    );
    if (!org) throw new ApiError(404, "Organization for checkout not found");

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

    // The Safepay tracker is the stable, replay-stable gateway reference for
    // this payment, so every re-delivery of the same webhook maps to the same
    // transaction_reference (UNIQUE uq_payment_txn_ref). A delivery without a
    // reference is rejected instead of being assigned a unique-looking
    // generated value.
    const transactionReference =
      typeof checkout.gateway_tracker_id === "string" ? checkout.gateway_tracker_id.trim() : "";
    if (!transactionReference) {
      throw new ApiError(400, "Transaction reference missing from payment webhook");
    }

    try {
      await recordSubscriptionPayment(connection, {
        organizationId: checkout.organization_id,
        amount: Number(plan.monthly_price),
        transactionReference,
        method: "safepay",
        purpose: `Org subscription: ${plan.name}`,
      });
    } catch (error) {
      // The payment row already exists (UNIQUE uq_payment_txn_ref): a different
      // concurrent delivery recorded this payment first. Treat it as already
      // processed and roll back THIS attempt's subscription extension so it is
      // never extended a second time.
      if (error?.errno === 1062 || error?.code === "ER_DUP_ENTRY") {
        await connection.rollback();
        return { already_processed: true, subscription: null };
      }
      throw error;
    }

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