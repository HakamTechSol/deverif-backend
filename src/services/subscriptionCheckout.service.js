import { pool } from "../config/db.js";
import ApiError from "../utils/ApiError.js";
import {
  createSafepayPaymentSession,
  createSafepayAuthToken,
  buildSafepayCheckoutUrl,
  getSafepayPaymentStatus,
} from "./safepay.service.js";
import { finalizeSuccessfulCheckout, markCheckoutFailed } from "./payment.service.js";

function getFrontendBaseUrl() {
  return (process.env.FRONTEND_PUBLIC_URL || "http://localhost:5173").replace(/\/$/, "");
}

export async function expireStaleCheckouts(connection = pool) {
  await connection.query(
    `UPDATE subscription_checkouts SET status='expired'
     WHERE status='pending' AND created_at < (NOW() - INTERVAL 2 HOUR)`
  );
}

export async function createOrgCheckout({ organizationId, plan, requestedByUuid, purpose = "subscribe" }) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    await expireStaleCheckouts(connection);

    const [[org]] = await connection.query(
      "SELECT id, subscription_status FROM organizations WHERE id=? FOR UPDATE",
      [organizationId]
    );
    if (!org) throw new ApiError(404, "Organization not found");

    if (purpose === "change_plan") {
      // Plan changes are only meaningful for an org that currently has an
      // ACTIVE subscription. The existing subscription stays untouched until
      // payment is confirmed via webhook.
      if (org.subscription_status !== "active") {
        throw new ApiError(
          400,
          "You can only change your plan when you have an active subscription. Please subscribe first."
        );
      }
    } else {
      // New subscription: the org must not already be active or awaiting a
      // manual confirmation.
      if (org.subscription_status === "active") {
        throw new ApiError(400, "Your organization already has an active subscription.");
      }
      if (org.subscription_status === "pending_payment") {
        throw new ApiError(
          400,
          "You already have a subscription awaiting manual payment confirmation from the System Admin."
        );
      }
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
      purpose,
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
      metadata: { order_id: checkout.uuid, source: "dvarif-org-admin" },
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
    `SELECT o.id, o.subscription_status AS status, o.subscription_plan AS plan,
            o.subscription_start AS start, o.subscription_expiry AS expiry, o.subscription_plan_id,
            sp.name AS plan_name, sp.monthly_price, sp.daily_request_quota
     FROM organizations o
     LEFT JOIN subscription_plans sp ON sp.id = o.subscription_plan_id
     WHERE o.id=?`,
    [orgId]
  );
  if (!orgRows.length) throw new ApiError(404, "Organization not found");
  const org = orgRows[0];

  if (org.status === "active" && org.expiry && new Date(org.expiry) < new Date()) {
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
    `SELECT o.subscription_status AS status, o.subscription_plan AS plan,
            o.subscription_start AS start, o.subscription_expiry AS expiry, o.subscription_plan_id,
            sp.name AS plan_name, sp.monthly_price, sp.daily_request_quota
     FROM organizations o
     LEFT JOIN subscription_plans sp ON sp.id = o.subscription_plan_id
     WHERE o.id=?`,
    [orgId]
  );
  const freshOrg = freshOrgRows[0] || org;

  return {
    subscription: {
      status: freshOrg.status,
      plan: freshOrg.plan ?? null,
      plan_name: freshOrg.plan_name ?? null,
      monthly_price: freshOrg.monthly_price != null ? Number(freshOrg.monthly_price) : null,
      daily_request_quota: freshOrg.daily_request_quota != null ? Number(freshOrg.daily_request_quota) : null,
      expiry: freshOrg.expiry,
      start: freshOrg.start,
    },
    checkout: latestRows[0] || null,
  };
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