import { pool } from "../config/db.js";
import ApiError from "../utils/ApiError.js";
import {
  applySubscriptionChange,
  billingPeriodMonths,
  loadOrganizationSubscriptionState,
  logSubscriptionChangeApplied,
  resolveSubscriptionChange,
} from "../utils/subscriptionTransition.js";

/**
 * Shared subscription activation service. Used by the Safepay webhook path
 * (auto-activation), the checkout-status reconciliation and the System-Admin
 * manual confirmation path, so they all agree on exactly how an organization's
 * subscription is activated.
 *
 * The renewal / upgrade / downgrade decision is NOT made here: it comes from
 * resolveSubscriptionChange, the single shared implementation. What this
 * function adds is that the org row is locked first, so a duplicate webhook and
 * a competing admin activation serialize instead of both extending the plan.
 *
 * Returns { expiry, duration_months, action, change }.
 */
export async function activateOrgSubscription(
  connection,
  { organizationId, plan, now = new Date(), org = null, source = "unknown", actor = null }
) {
  const lockedOrg = org || (await loadOrganizationSubscriptionState(connection, organizationId));

  const change = resolveSubscriptionChange(lockedOrg, plan, { now });
  const { expiry } = await applySubscriptionChange(connection, {
    organizationId,
    change,
    now,
  });

  return {
    expiry,
    duration_months: billingPeriodMonths(plan.billing_period),
    action: change.action,
    change,
    orgUuid: lockedOrg.uuid,
    source,
    actor,
  };
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
    // the first commit instead of both extending the subscription. The same
    // load feeds resolveSubscriptionChange, so the lock and the renewal/upgrade/
    // downgrade decision read exactly the same state.
    const org = await loadOrganizationSubscriptionState(connection, checkout.organization_id);

    if (checkout.status === "completed") {
      await connection.commit();
      return { already_processed: true, subscription: null };
    }

    const [[plan]] = await connection.query(
      `SELECT id, name, monthly_price, daily_request_quota, billing_period
       FROM subscription_plans WHERE id=?`,
      [checkout.plan_id]
    );
    if (!plan) throw new ApiError(404, "Plan not found");

    const { expiry, action, change, orgUuid } = await activateOrgSubscription(connection, {
      organizationId: checkout.organization_id,
      plan,
      now: new Date(),
      org,
      source: "safepay_webhook",
    });

    await connection.query(
      `UPDATE subscription_checkouts
       SET status='completed', gateway_event_id=?, completed_at=NOW()
       WHERE id=?`,
      [eventId, checkoutId]
    );

    // Record which scheduled change this payment PRODUCED.
    //
    // Only a scheduled change sets this. An immediate activation granted
    // something straight away and there is nothing to back out of, so
    // resulted_in_pending_plan_id stays NULL and the cancel-with-refund lookup
    // will never point at it.
    //
    // This is written here, in the same transaction that created the scheduled
    // change, so the link can never disagree with organizations.pending_plan_id.
    // It is also what makes the refund exact: matching a checkout by
    // (organization_id, plan_id) instead would be ambiguous after a
    // cancel-then-reschedule cycle and could refund an older, already-closed
    // charge.
    if (change.action === "change_scheduled" && change.pending_plan_id != null) {
      await connection.query(
        "UPDATE subscription_checkouts SET resulted_in_pending_plan_id=? WHERE id=?",
        [change.pending_plan_id, checkoutId]
      );
    }

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

    // NOTE: the daily-usage reset for a paid plan change is NOT done here. It
    // already happened inside applySubscriptionChange, which clears today's
    // bucket for every immediate activation (activate_now / renew /
    // upgrade_now) inside this same transaction.

    await connection.commit();

    // Audit AFTER the commit: the row is only durable once the transaction is,
    // and this is what makes an unexplained subscription mutation traceable to
    // this code path instead of leaving nothing behind.
    logSubscriptionChangeApplied({
      orgUuid,
      organizationId: checkout.organization_id,
      change,
      source: "safepay_webhook",
      extra: { checkout_uuid: checkout.uuid, gateway_event_id: eventId, plan: plan.name },
    });

    return {
      already_processed: false,
      subscription: { plan: plan.name, expiry, action },
      action,
      change: {
        action,
        pending_plan_id: change.pending_plan_id ?? null,
        previous_plan_id: change.previous_plan_id ?? null,
        previous_expiry: change.previous_expiry ?? null,
      },
    };
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

/** Mark a checkout as failed so it stops being reconciled. */
export async function markCheckoutFailed({ checkoutId, eventId }) {
  await pool.query(
    `UPDATE subscription_checkouts
     SET status='failed', gateway_event_id=?, failed_at=NOW()
     WHERE id=? AND status NOT IN ('completed', 'failed')`,
    [eventId, checkoutId]
  );
}