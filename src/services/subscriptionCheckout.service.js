import { pool } from "../config/db.js";
import ApiError from "../utils/ApiError.js";
import {
  createSafepayPaymentSession,
  createSafepayAuthToken,
  buildSafepayCheckoutUrl,
  getSafepayPaymentStatus,
  refundSafepayPayment,
  getSafepayRefundStatus,
} from "./safepay.service.js";
import { finalizeSuccessfulCheckout, markCheckoutFailed } from "./payment.service.js";
import { isSubscriptionActive, PLAN_SELECT_COLUMNS } from "../utils/subscriptionTransition.js";

function getFrontendBaseUrl() {
  return (process.env.FRONTEND_PUBLIC_URL || "http://localhost:5173").replace(/\/$/, "");
}

export async function expireStaleCheckouts(connection = pool) {
  await connection.query(
    `UPDATE subscription_checkouts SET status='expired'
     WHERE status='pending' AND created_at < (NOW() - INTERVAL 2 HOUR)`
  );
}

export async function createOrgCheckout({
  organizationId,
  plan,
  requestedByUuid,
  purpose = "subscribe",
  customPlanRequestUuid = null,
}) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    await expireStaleCheckouts(connection);

    const [[org]] = await connection.query(
      `SELECT id, subscription_status, subscription_expiry, subscription_plan_id
       FROM organizations WHERE id=? FOR UPDATE`,
      [organizationId]
    );
    if (!org) throw new ApiError(404, "Organization not found");

    // Read the current plan (non-locking, so the org lock is not widened onto
    // subscription_plans) because "is there a live paid subscription?" depends on
    // the Free plan having no expiry rather than on the expiry alone.
    let currentPlan = null;
    if (org.subscription_plan_id != null) {
      const [[plan]] = await connection.query(
        `SELECT ${PLAN_SELECT_COLUMNS} FROM subscription_plans WHERE id=?`,
        [org.subscription_plan_id]
      );
      currentPlan = plan || null;
    }

    // An org that already holds a live paid subscription is always buying a
    // renewal or a plan change, whichever the client called it. The shared
    // transition logic (resolveSubscriptionChange) is what actually distinguishes
    // a renewal from an upgrade from a downgrade once the payment clears, so the
    // checkout itself must not refuse the purchase.
    const isCurrentlyActive = isSubscriptionActive({ ...org, current_plan: currentPlan });

    if (org.subscription_status === "pending_payment") {
      throw new ApiError(
        400,
        "You already have a subscription awaiting manual payment confirmation from the System Admin."
      );
    }

    if (purpose === "change_plan" && !isCurrentlyActive) {
      // Plan changes are only meaningful for an org that currently has an
      // ACTIVE subscription. The existing subscription stays untouched until
      // payment is confirmed via webhook.
      throw new ApiError(
        400,
        "You can only change your plan when you have an active subscription. Please subscribe first."
      );
    }

    await connection.query(
      "UPDATE subscription_checkouts SET status='cancelled' WHERE organization_id=? AND status='pending'",
      [organizationId]
    );

    const metadata = JSON.stringify({
      organization_id: organizationId,
      plan_uuid: plan.uuid,
      plan_name: plan.name,
      requested_by_uuid: requestedByUuid,
      // Record what the purchase actually IS. Buying while already subscribed is
      // always a change of an existing subscription, even when the client
      // labelled it "subscribe" (which is what the renewal button sends).
      purpose: isCurrentlyActive ? "change_plan" : "subscribe",
      // A custom plan is bought off the back of an approval, so keep the edge back
      // to that approval. It is what makes the charge explainable later ("this
      // payment exists because request X was approved") rather than an anonymous
      // plan purchase, and it is deliberately separate from `purpose`, which
      // describes the billing effect and is recomputed above.
      ...(customPlanRequestUuid
        ? { custom_plan_request_uuid: customPlanRequestUuid, purchase_source: "custom_plan_request" }
        : {}),
    });

    const [insertResult] = await connection.query(
      `INSERT INTO subscription_checkouts
         (organization_id, plan_id, plan_uuid, plan_name, gateway, amount, currency, status, metadata)
       VALUES (?, ?, ?, ?, 'safepay', ?, 'PKR', 'pending', ?)`,
      [organizationId, plan.id, plan.uuid, plan.name, Number(plan.monthly_price), metadata]
    );

    const [checkoutRows] = await connection.query(
      `SELECT id, uuid, amount, currency, status FROM subscription_checkouts WHERE id=?`,
      [insertResult.insertId]
    );
    if (!checkoutRows.length) throw new ApiError(500, "Could not create the checkout row");
    const checkout = checkoutRows[0];

    await connection.commit();

    const amountPaisa = Math.round(Number(plan.monthly_price) * 100);
    const trackerSession = await createSafepayPaymentSession({
      amount: amountPaisa,
      currency: "PKR",
      metadata: { order_id: checkout.uuid, source: "dverif-org-admin" },
    });
    const passport = await createSafepayAuthToken();
    const redirectUrl = `${getFrontendBaseUrl()}/payment/callback`;
    const cancelUrl = `${getFrontendBaseUrl()}/payment/callback?cancelled=1`;
    const checkoutUrl = buildSafepayCheckoutUrl({
      tracker: trackerSession.token,
      tbt: passport,
      redirectUrl,
      cancelUrl,
    });

    await pool.query(
      "UPDATE subscription_checkouts SET gateway_tracker_id=? WHERE id=?",
      [trackerSession.token, checkout.id]
    );

    return { checkout, redirect_url: checkoutUrl };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function getOrgSubscriptionStatus(orgId) {
  await expireStaleCheckouts();

  const [orgRows] = await pool.query(
    `SELECT o.id, o.subscription_status AS status,
            o.subscription_start AS start, o.subscription_expiry AS expiry, o.subscription_plan_id,
            o.pending_plan_id,
            sp.uuid AS plan_uuid, sp.name AS plan_name, sp.is_free AS is_free,
            sp.monthly_price, sp.daily_request_quota,
            pp.name AS pending_plan_name, pp.daily_request_quota AS pending_plan_daily_request_quota,
            pp.monthly_price AS pending_plan_monthly_price
     FROM organizations o
     LEFT JOIN subscription_plans sp ON sp.id = o.subscription_plan_id
     LEFT JOIN subscription_plans pp ON pp.id = o.pending_plan_id
     WHERE o.id=?`,
    [orgId]
  );
  if (!orgRows.length) throw new ApiError(404, "Organization not found");
  const org = orgRows[0];

  // A Free plan never expires, so its NULL expiry must not be flipped to
  // 'expired' here -- NULL means "indefinite" for Free. A lapsed PAID plan does
  // get flipped; the lifecycle job then moves the org onto the Free plan.
  const isFree = Number(org.is_free) === 1;
  if (
    !isFree &&
    org.status === "active" &&
    org.expiry &&
    new Date(org.expiry) < new Date()
  ) {
    org.status = "expired";
    await pool.query("UPDATE organizations SET subscription_status='expired' WHERE id=?", [orgId]);
  }

  // Reconcile a pending checkout against the gateway. If a checkout is still
  // `pending` it is possible the webhook was missed (e.g. the callback arrived
  // before the webhook, or a delivery failure). We query Safepay directly and
  // finalize/mark the checkout based on the authoritative gateway state so the
  // callback page resolves instead of spinning on "Verifying your payment".
  const [pendRows] = await pool.query(
    `SELECT id, uuid, gateway_tracker_id, amount, plan_id, status
     FROM subscription_checkouts WHERE organization_id=? AND status='pending'
     ORDER BY id DESC LIMIT 1`,
    [orgId]
  );
  if (pendRows.length && pendRows[0].gateway_tracker_id) {
    const pend = pendRows[0];
    try {
      const gw = await getSafepayPaymentStatus(pend.gateway_tracker_id);
      if (gw.paid) {
        await finalizeSuccessfulCheckout({ checkoutId: pend.id, eventId: `reconcile-${pend.gateway_tracker_id}` });
      } else if (gw.state && !["TRACKER_CREATED", "TRACKER_STARTED"].includes(gw.state)) {
        await markCheckoutFailed({ checkoutId: pend.id, eventId: `reconcile-${pend.gateway_tracker_id}` });
      }
    } catch (reconcileErr) {
      // Gateway lookup is best-effort; never block the status response.
      console.error(`[payment] reconcile failed for tracker ${pend.gateway_tracker_id}:`, reconcileErr?.message);
    }
  }

  const [latestRows] = await pool.query(
    `SELECT uuid, status, amount, currency, created_at, completed_at, failed_at
     FROM subscription_checkouts WHERE organization_id=? ORDER BY id DESC LIMIT 1`,
    [orgId]
  );

  // If reconciliation activated the subscription, refresh the org fields so the
  // response reflects the just-activated plan rather than the stale pre-reconcile row.
  const [freshOrgRows] = await pool.query(
    `SELECT o.subscription_status AS status,
            o.subscription_start AS start, o.subscription_expiry AS expiry, o.subscription_plan_id,
            o.pending_plan_id,
            sp.uuid AS plan_uuid, sp.name AS plan_name, sp.is_free AS is_free,
            sp.monthly_price, sp.daily_request_quota,
            pp.name AS pending_plan_name, pp.daily_request_quota AS pending_plan_daily_request_quota,
            pp.monthly_price AS pending_plan_monthly_price
     FROM organizations o
     LEFT JOIN subscription_plans sp ON sp.id = o.subscription_plan_id
     LEFT JOIN subscription_plans pp ON pp.id = o.pending_plan_id
     WHERE o.id=?`,
    [orgId]
  );
  const freshOrg = freshOrgRows[0] || org;

  return {
    subscription: {
      status: freshOrg.status,
      plan: freshOrg.plan_name ?? null,
      plan_name: freshOrg.plan_name ?? null,
      // Free is identified by its flag, not by its name or price.
      is_free: Number(freshOrg.is_free) === 1,
      plan_uuid: freshOrg.plan_uuid ?? null,
      monthly_price: freshOrg.monthly_price != null ? Number(freshOrg.monthly_price) : null,
      daily_request_quota: freshOrg.daily_request_quota != null ? Number(freshOrg.daily_request_quota) : null,
      expiry: freshOrg.expiry,
      start: freshOrg.start,
      // Deferred downgrade: the lower-tier plan starts when the current period
      // ends, so the effective date is the current expiry.
      pending_plan_id: freshOrg.pending_plan_id ?? null,
      pending_plan_name: freshOrg.pending_plan_name ?? null,
      pending_plan_daily_request_quota:
        freshOrg.pending_plan_daily_request_quota != null
          ? Number(freshOrg.pending_plan_daily_request_quota)
          : null,
      pending_plan_monthly_price:
        freshOrg.pending_plan_monthly_price != null
          ? Number(freshOrg.pending_plan_monthly_price)
          : null,
      pending_plan_effective_at: freshOrg.pending_plan_id ? freshOrg.expiry : null,
    },
    checkout: latestRows[0] || null,
  };
}

/**
 * Clear a deferred downgrade before it takes effect (the org changed its mind).
 * Returns false when there was nothing pending.
 */
/**
 * Cancel a scheduled subscription change and refund what was paid for it.
 *
 * ONE mechanism for both scheduled cases. A same-plan renewal and a downgrade are
 * both just "a plan queued in pending_plan_id that the customer paid for", and
 * backing out of either has the same shape: give the money back and let the
 * current subscription carry on untouched. Splitting them would mean two code
 * paths that could drift apart on the refund half.
 *
 * Ordering matters, and it is deliberate:
 *   1. Load the org and the checkout that PRODUCED the scheduled change. If there
 *      is no pending_plan_id, this is a 400, not a silent no-op -- the caller
 *      asked to cancel something and there is nothing there.
 *   2. Call the gateway FIRST, while the intent is still recorded. If the refund
 *      fails, the scheduled change stays exactly as it was and the customer can
 *      retry; we never clear the intent and leave them with no plan change and no
 *      money.
 *   3. Then, and only then, mark the checkout 'refunded' and clear
 *      pending_plan_id, in one transaction.
 *
 * The checkout row is never deleted. It is the ledger record of what was charged
 * and what was returned, so 'refunded' is a terminal status on the row.
 *
 * Only possible before the lifecycle sweep applies the change. Once the sweep has
 * run, pending_plan_id is NULL and the renewal has already been granted, so there
 * is nothing to cancel — which falls out of the 400 in step 1 rather than
 * needing a separate check.
 *
 * @returns {{ refund: object|null, checkout: object|null, already_refunded: boolean }}
 */
export async function refundScheduledChange({ organizationId, planName, actor = null }) {
  const connection = await pool.getConnection();
  // Declared out here, not inside the try: `tracker` is needed AFTER the
  // transaction closes, because the gateway call deliberately happens outside it.
  // Declaring it inside the block scope left it undefined at the refund call.
  let lockedOrg;
  let checkout;
  let tracker = null;
  try {
    await connection.beginTransaction();

    const [[org]] = await connection.query(
      `SELECT id, uuid, name, subscription_status, subscription_expiry,
              subscription_plan_id, pending_plan_id
       FROM organizations WHERE id=? FOR UPDATE`,
      [organizationId]
    );
    if (!org) throw new ApiError(404, "Organization not found");
    // Retained for the post-transaction settlement below, which must clear
    // exactly the pending_plan_id this call observed under the lock.
    lockedOrg = org;

    if (org.pending_plan_id == null) {
      await connection.rollback();
      // Nothing scheduled. Either it was never set, or the sweep already applied
      // it — in which case there is genuinely nothing left to cancel or refund.
      throw new ApiError(400, "There is no scheduled subscription change to cancel.");
    }

    const [[plan]] = await connection.query(
      "SELECT id, name, monthly_price FROM subscription_plans WHERE id=?",
      [org.pending_plan_id]
    );

    // The checkout that PRODUCED this scheduled change. This is why
    // resulted_in_pending_plan_id exists: matching on (organization_id, plan_id)
    // would be ambiguous across a cancel-then-reschedule cycle and could refund
    // the wrong charge.
    const [checkoutRows] = await connection.query(
      `SELECT id, uuid, status, amount, currency, gateway_tracker_id, completed_at,
              refund_status, refund_transaction_reference
         FROM subscription_checkouts
        WHERE organization_id=? AND resulted_in_pending_plan_id=?
        ORDER BY completed_at DESC, id DESC
        LIMIT 1`,
      [organizationId, org.pending_plan_id]
    );
    checkout = checkoutRows[0] || null;

    if (checkout && (checkout.status === "refunded" || checkout.refund_status === "refunded")) {
      // Already settled. Idempotent: only the leftover intent is left to clear, so
      // a duplicated click cannot refund twice.
      await connection.query(
        "UPDATE organizations SET pending_plan_id=NULL WHERE id=? AND pending_plan_id IS NOT NULL",
        [organizationId]
      );
      await connection.commit();
      return {
        refund: null,
        checkout,
        already_refunded: true,
        pending_confirmation: false,
        refund_reference: checkout.refund_transaction_reference ?? null,
      };
    }

    if (checkout && checkout.refund_status === "pending") {
      // A refund was submitted earlier but its settlement was never confirmed.
      // Do NOT submit another one -- that is how a double refund happens. Instead
      // re-ask the gateway: the refund may well have settled in the meantime, in
      // which case this retry completes the cancellation the customer wanted.
      await connection.commit();
      const confirmation = await getSafepayRefundStatus(tracker || checkout.gateway_tracker_id)
        .catch((error) => {
          console.error(
            `[subscription] could not re-confirm a pending refund for checkout ${checkout.uuid}: ${error?.message}`
          );
          return { settled: false, state: null, refundReference: null };
        });

      if (!confirmation.settled) {
        throw new ApiError(
          409,
          "Your refund is still being processed by the payment provider. Your plan has not changed and the scheduled renewal is still in place — it will be dropped automatically once the refund is confirmed. Please do not retry."
        );
      }

      await confirmRefundSettled({
        checkoutId: checkout.id,
        refundReference: confirmation.refundReference,
        state: confirmation.state,
      });
      return {
        refund: null,
        checkout,
        already_refunded: false,
        pending_confirmation: false,
        refund_reference: confirmation.refundReference,
        refund_state: confirmation.state,
      };
    }

    tracker = checkout?.gateway_tracker_id ?? null;
    if (!tracker) {
      // A scheduled change with no captured payment behind it (e.g. granted by an
      // admin rather than bought) has nothing to refund, but it is still
      // cancellable.
      await connection.query(
        "UPDATE organizations SET pending_plan_id=NULL WHERE id=? AND pending_plan_id IS NOT NULL",
        [organizationId]
      );
      if (checkout) {
        await connection.query(
          "UPDATE subscription_checkouts SET status='refunded' WHERE id=?",
          [checkout.id]
        );
      }
      await connection.commit();
      return { refund: null, checkout, already_refunded: false };
    }

    await connection.commit();
  } catch (error) {
    try {
      await connection.rollback();
    } catch {
      /* already rolled back */
    }
    throw error;
  } finally {
    connection.release();
  }

  // ── gateway call, outside any transaction ──
  // The scheduled change is still recorded at this point on purpose: if the
  // refund fails we surface the error and leave everything as it was, so the
  // customer can retry rather than losing both the plan change and the money.
  //
  // The amount comes from the checkout row — the amount actually charged — and is
  // converted from rupees to the gateway's minor unit (paisa). Refunding the
  // plan's list price instead would be wrong the moment a price changed between
  // the purchase and the cancellation.
  const refundableAmount = Math.round(Number(checkout.amount) * 100);

  // The refund reference is recorded as 'pending' BEFORE the gateway is even
  // called. If the process dies mid-flight, the next attempt sees
  // refund_status='pending' and refuses to submit again -- which is what stops a
  // crash between "money moved" and "we wrote it down" from becoming a double
  // refund. getSafepayRefundStatus is then the only thing that can clear it.
  const [claimed] = await pool.query(
    `UPDATE subscription_checkouts
        SET refund_status='pending', refund_requested_at=NOW(),
            refund_transaction_reference=COALESCE(refund_transaction_reference, ?)
      WHERE id=? AND refund_status='none'`,
    [`pending:${checkout.uuid}`, checkout.id]
  );
  if (!claimed.affectedRows) {
    throw new ApiError(
      409,
      "A refund for this payment has already been requested. If it is still processing, this will update automatically; otherwise contact support before retrying."
    );
  }

  let submitted;
  try {
    submitted = await refundSafepayPayment(tracker, {
      amount: refundableAmount,
      currency: checkout.currency || "PKR",
      metadata: {
        organization_id: String(organizationId),
        checkout_uuid: checkout.uuid,
        reason: "scheduled_change_cancelled",
      },
    });
  } catch (error) {
    // The gateway REFUSED, so nothing moved and a retry is safe. Roll the
    // reservation back to 'none' and leave the scheduled change in place.
    await pool.query(
      "UPDATE subscription_checkouts SET refund_status='none', refund_requested_at=NULL WHERE id=? AND refund_status='pending'",
      [checkout.id]
    );
    const wrapped = new ApiError(
      502,
      `The refund could not be completed, so the scheduled change was left in place: ${error?.message || "unknown error"}`
    );
    wrapped.publicMessage =
      "We could not complete your refund, so nothing has changed. Your plan is unchanged and the scheduled renewal is still in place — please try again in a moment or contact support.";
    throw wrapped;
  }

  // ── CONFIRM with the gateway's own record before claiming anything ──
  // Submitting a refund is not the same as the refund having settled. The submit
  // response is only a submission receipt, so settlement is confirmed by asking
  // the reporter, which is the same record reconciliation will later use.
  let confirmation = { settled: false, state: null, refundReference: null, hasRefundEvent: false };
  try {
    confirmation = await getSafepayRefundStatus(tracker);
  } catch (error) {
    console.error(
      `[subscription] refund submitted for checkout ${checkout.uuid} but settlement could not be ` +
        `confirmed yet: ${error?.message}. Left as refund_status='pending'; the scheduled change ` +
        `stays in place and will not be refunded twice.`
    );
  }

  const refundReference = confirmation.refundReference || submitted?.refundReference || null;
  if (refundReference) {
    await pool.query(
      "UPDATE subscription_checkouts SET refund_transaction_reference=? WHERE id=?",
      [refundReference, checkout.id]
    );
    // Mirror onto the billing-ledger row so the org's Billing History shows the
    // reversal instead of an apparently-live charge.
    await pool.query(
      "UPDATE payment SET refund_transaction_reference=?, refunded_at=NOW() WHERE transaction_reference=?",
      [refundReference, tracker]
    );
  }

  if (!confirmation.settled) {
    // Accepted, but not provably settled yet. The scheduled change deliberately
    // STAYS, so the org is still in the "scheduled, cancel still available" state
    // -- but the checkout is now 'refund_pending', so a second cancel attempt is
    // refused rather than refunded twice. A refund-confirmation webhook (or the
    // next reconcile) promotes this to 'refunded' and drops the change.
    return {
      refund: submitted,
      checkout,
      already_refunded: false,
      pending_confirmation: true,
      refund_reference: refundReference,
      refund_state: confirmation.state,
    };
  }

  // ── record the outcome: the gateway has confirmed it ──
  const settle = await pool.getConnection();
  try {
    await settle.beginTransaction();
    await settle.query(
      `UPDATE subscription_checkouts
          SET status='refunded', refund_status='refunded', refunded_at=NOW()
        WHERE id=?`,
      [checkout.id]
    );
    const [result] = await settle.query(
      "UPDATE organizations SET pending_plan_id=NULL WHERE id=? AND pending_plan_id=?",
      [organizationId, lockedOrg.pending_plan_id]
    );
    await settle.commit();

    if (!result.affectedRows) {
      // The sweep applied the change between the gateway call and here. The
      // refund has already gone out, so this must be visible rather than silent.
      console.warn(
        `Subscription change for organization ${organizationId} was applied by the lifecycle job ` +
          `while a refund was in flight; the refund for checkout ${checkout.uuid} was still issued.`
      );
    }
  } catch (error) {
    await settle.rollback();
    throw error;
  } finally {
    settle.release();
  }

  return {
    refund: submitted,
    checkout,
    already_refunded: false,
    pending_confirmation: false,
    refund_reference: refundReference,
    refund_state: confirmation.state,
  };
}

/**
 * Promote a 'refund_pending' checkout to 'refunded' once the gateway confirms it,
 * and drop the scheduled change at the same time.
 *
 * Split out from refundScheduledChange because the two triggers are different
 * moments: the customer clicking Cancel, and the gateway's own confirmation
 * arriving later. Both must end in the same place, and neither may clear the
 * scheduled change on its own.
 */
export async function confirmRefundSettled({ checkoutId, refundReference, state = null }) {
  const [[checkout]] = await pool.query(
    "SELECT id, organization_id, refund_status FROM subscription_checkouts WHERE id=?",
    [checkoutId]
  );
  if (!checkout) throw new ApiError(404, "Checkout not found");
  // Already settled: idempotent, so a duplicated webhook is harmless.
  if (checkout.refund_status === "refunded") return { already_confirmed: true };

  const [[org]] = await pool.query(
    "SELECT pending_plan_id FROM organizations WHERE id=?",
    [checkout.organization_id]
  );
  if (!org) throw new ApiError(404, "Organization not found");

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `UPDATE subscription_checkouts
          SET status='refunded', refund_status='refunded', refunded_at=NOW(),
              refund_transaction_reference=COALESCE(?, refund_transaction_reference)
        WHERE id=?`,
      [refundReference, checkoutId]
    );
    if (org.pending_plan_id != null) {
      await conn.query(
        "UPDATE organizations SET pending_plan_id=NULL WHERE id=? AND pending_plan_id=?",
        [checkout.organization_id, org.pending_plan_id]
      );
    }
    if (refundReference) {
      await conn.query(
        "UPDATE payment SET refund_transaction_reference=?, refunded_at=NOW() WHERE transaction_reference=(SELECT gateway_tracker_id FROM subscription_checkouts WHERE id=?)",
        [refundReference, checkoutId]
      );
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }

  return { already_confirmed: false, state };
}

/**
 * Legacy behaviour, kept for callers that only want to clear the intent.
 *
 * Does NOT refund. Prefer refundScheduledChange: a customer who paid for a
 * scheduled renewal and then has it silently removed has been charged for
 * nothing.
 */
export async function cancelPendingPlanChange(orgId) {
  const [result] = await pool.query(
    `UPDATE organizations SET pending_plan_id=NULL
     WHERE id=? AND pending_plan_id IS NOT NULL`,
    [orgId]
  );
  return result.affectedRows > 0;
}

export async function getCheckoutByUuid({ organizationId, checkoutUuid }) {
  const [rows] = await pool.query(
    `SELECT uuid, status, amount, currency, created_at, updated_at, completed_at, failed_at
     FROM subscription_checkouts
     WHERE uuid=? AND organization_id=?`,
    [checkoutUuid, organizationId]
  );
  if (!rows.length) throw new ApiError(404, "Checkout not found");
  return rows[0];
}

export async function findCheckoutByTracker(tracker) {
  const [rows] = await pool.query(
    "SELECT * FROM subscription_checkouts WHERE gateway_tracker_id=? LIMIT 1",
    [tracker]
  );
  return rows[0] || null;
}