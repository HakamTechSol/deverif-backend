import ApiError from "../../utils/ApiError.js";
import { pool } from "../../config/db.js";
import { ok } from "../../utils/response.js";
import { assertUuid } from "../../utils/publicResponse.js";
import { parsePagination, paginatedResponse } from "../../utils/pagination.js";
import { createNotificationForOrgUsers } from "../notification.controller.js";
import { logAudit, getActorFromReq } from "../../utils/auditLog.js";
import { assignFreePlanToOrg } from "../../utils/freePlan.js";
import {
  activateOrgSubscription,
  recordSubscriptionPayment,
} from "../../services/payment.service.js";
import {
  createSafepayPaymentSession,
  createSafepayAuthToken,
  buildSafepayCheckoutUrl,
} from "../../services/safepay.service.js";
import {
  applySubscriptionChange,
  describeSubscriptionChange,
  loadOrganizationSubscriptionState,
  logSubscriptionChangeApplied,
  PLAN_SELECT_COLUMNS,
  resolveSubscriptionChange,
} from "../../utils/subscriptionTransition.js";

const CUSTOM_PLAN_REQ_SELECT = `SELECT cpr.id, cpr.uuid, cpr.message, cpr.requested_quota, cpr.requested_price,
        cpr.status, cpr.approved_daily_quota, cpr.approved_price, cpr.created_at, cpr.decided_at, cpr.decided_by,
        o.id AS organization_id, o.uuid AS organization_uuid, o.name AS organization_name,
        o.subscription_status, o.subscription_expiry,
        u.full_name AS requested_by_name, u.email AS requested_by_email
 FROM custom_plan_requests cpr
 LEFT JOIN organizations o ON o.id = cpr.organization_id
 LEFT JOIN users u ON u.uuid = cpr.requested_by_uuid`;

/**
 * Admin: list custom-plan requests (filter by ?status=pending|approved|denied).
 */
export async function listCustomPlanRequests(req, res) {
  const { page, limit, offset } = parsePagination(req.query);
  const status = typeof req.query.status === "string" ? req.query.status : null;
  if (status && !["pending", "approved", "denied"].includes(status)) {
    throw new ApiError(400, "status must be pending, approved or denied");
  }

  const where = status ? "WHERE cpr.status=?" : "";
  const params = status ? [status] : [];

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM custom_plan_requests cpr ${where}`,
    params
  );
  const [rows] = await pool.query(
    `${CUSTOM_PLAN_REQ_SELECT} ${where} ORDER BY cpr.created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  return ok(res, paginatedResponse(rows, total, page, limit), "Custom plan requests");
}

/**
 * Admin: approve a custom-plan request.
 *
 * Creates an is_custom subscription_plans entry, marks the request approved, and
 * creates a PENDING checkout for the negotiated amount so the org admin pays for
 * it through the normal Safepay redirect.
 *
 * This deliberately does NOT touch organizations.subscription_*. Approval
 * records the negotiation outcome; it does not grant the plan. Activation
 * happens only when that checkout's webhook succeeds, and it then runs the
 * ordinary resolveSubscriptionChange comparison — so a custom plan is subject to
 * exactly the same upgrade-now / schedule-at-expiry rule as any other plan,
 * rather than being special-cased to always take effect immediately.
 */
export async function approveCustomPlanRequest(req, res) {
  const { uuid } = req.params;
  assertUuid(uuid, "Custom plan request UUID");

  const dailyQuota = Number(req.body?.daily_quota);
  const price = Number(req.body?.price);
  if (!Number.isInteger(dailyQuota) || dailyQuota <= 0) {
    throw new ApiError(400, "daily_quota must be a positive integer");
  }
  if (!Number.isFinite(price) || price < 0) {
    throw new ApiError(400, "price must be a non-negative number");
  }

  const connection = await pool.getConnection();
  let approvedPlanId;
  let checkoutUuid;
  let organizationId;
  let organizationName;
  try {
    await connection.beginTransaction();

    const [reqRows] = await connection.query(
      `SELECT cpr.id, cpr.organization_id, o.uuid AS organization_uuid, o.name AS organization_name
       FROM custom_plan_requests cpr
       JOIN organizations o ON o.id = cpr.organization_id
       WHERE cpr.uuid=? FOR UPDATE`,
      [uuid]
    );
    if (!reqRows.length) throw new ApiError(404, "Custom plan request not found");
    const planReq = reqRows[0];
    organizationId = planReq.organization_id;
    organizationName = planReq.organization_name;
    if (planReq.status === "approved") {
      throw new ApiError(409, "This custom plan request is already approved");
    }
    if (planReq.status === "denied") {
      throw new ApiError(409, "This custom plan request was already denied");
    }

    // Create the custom plan. The plan row existing is NOT the same thing as the
    // organization having it: activation is gated on payment (see below).
    const planName = `Custom Plan — ${organizationName}`;
    const [planResult] = await connection.query(
      `INSERT INTO subscription_plans (name, monthly_price, daily_request_quota, is_custom)
       VALUES (?, ?, ?, 1)`,
      [planName, price.toFixed(2), dailyQuota]
    );
    approvedPlanId = planResult.insertId;

    // Mark the request approved. This records the NEGOTIATION outcome only.
    //
    // approved_plan_id is what makes the approval actionable: it is the edge the
    // org admin needs to open a checkout for exactly this plan. Without it the
    // approved request was a dead end — nothing could resolve it back to a plan,
    // because subscription_plans has no organization_id and the generated name is
    // not a reliable key (stored names use an em dash, this code builds a hyphen).
    await connection.query(
      `UPDATE custom_plan_requests
       SET status='approved', approved_daily_quota=?, approved_price=?, approved_plan_id=?,
           decided_by=?, decided_at=NOW()
       WHERE id=?`,
      [dailyQuota, price.toFixed(2), approvedPlanId, req.admin?.uuid ?? null, planReq.id]
    );

    // Create a PENDING checkout for the negotiated amount and hand the org admin a
    // payment link. From here the custom plan is an ordinary purchase: the org
    // pays through the normal Safepay redirect, and the webhook runs the normal
    // resolveSubscriptionChange comparison.
    //
    // NOTHING in organizations.subscription_* is touched on this path. That is
    // the entire point of this change. Approval used to activate the plan
    // directly, so an org could be moved onto a paid plan — immediately, or
    // scheduled — that it had never paid for, and a custom plan was quietly
    // exempt from the upgrade/schedule distinction that every other plan obeys.
    const [[planRow]] = await connection.query(
      "SELECT uuid, name, monthly_price FROM subscription_plans WHERE id=?",
      [approvedPlanId]
    );
    if (!planRow) throw new ApiError(500, "Custom plan could not be read back after insert");

    // Cancel any stale pending checkout so the org is never left holding two live
    // payment sessions for the same plan.
    await connection.query(
      "UPDATE subscription_checkouts SET status='cancelled' WHERE organization_id=? AND status='pending'",
      [organizationId]
    );

    const [checkoutResult] = await connection.query(
      `INSERT INTO subscription_checkouts
         (organization_id, plan_id, plan_uuid, plan_name, gateway, amount, currency, status, metadata)
       VALUES (?, ?, ?, ?, 'safepay', ?, 'PKR', 'pending', ?)`,
      [
        organizationId,
        approvedPlanId,
        planRow.uuid,
        planRow.name,
        Number(planRow.monthly_price),
        JSON.stringify({
          organization_id: organizationId,
          plan_uuid: planRow.uuid,
          plan_name: planRow.name,
          purpose: "custom_plan_payment",
          custom_plan_request_uuid: uuid,
        }),
      ]
    );
    const [[checkoutRow]] = await connection.query(
      "SELECT id, uuid FROM subscription_checkouts WHERE id=?",
      [checkoutResult.insertId]
    );
    if (!checkoutRow) throw new ApiError(500, "Could not create the custom-plan checkout");
    checkoutUuid = checkoutRow.uuid;

    await connection.commit();

    logAudit({
      ...getActorFromReq(req),
      action: "custom_plan.approve",
      entityType: "custom_plan_request",
      entityId: uuid,
      details: {
        daily_quota: dailyQuota,
        price,
        organization_id: organizationId,
        plan_id: approvedPlanId,
        checkout_uuid: checkoutUuid,
        // Explicit, because it is the whole behavioural change: approving does
        // NOT activate. The org's subscription is untouched until this
        // checkout's webhook succeeds.
        subscription_activated: false,
        awaiting_payment: true,
      },
      req,
    });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  // Payment link + notification, AFTER the commit. The checkout must be durable
  // before the org is told to go and pay for it.
  let paymentLink = null;
  try {
    const amountPaisa = Math.round(price * 100);
    const trackerSession = await createSafepayPaymentSession({
      amount: amountPaisa,
      currency: "PKR",
      metadata: { order_id: checkoutUuid, source: "dverif-custom-plan-approval" },
    });
    await pool.query(
      "UPDATE subscription_checkouts SET gateway_tracker_id=? WHERE uuid=?",
      [trackerSession.token, checkoutUuid]
    );
    const passport = await createSafepayAuthToken();
    const base = (process.env.FRONTEND_PUBLIC_URL || "http://localhost:5173").replace(/\/$/, "");
    paymentLink = buildSafepayCheckoutUrl({
      tracker: trackerSession.token,
      tbt: passport,
      redirectUrl: `${base}/payment/callback`,
      cancelUrl: `${base}/payment/callback?cancelled=1`,
    });
  } catch (error) {
    // The approval and its checkout are already committed and must stand: the org
    // still owes the negotiated amount. Surface the problem loudly and let the
    // checkout be retried or reconciled, rather than rolling back the approval
    // and leaving the admin thinking nothing happened.
    console.error(
      `Custom plan ${approvedPlanId} approved (checkout ${checkoutUuid}) but the Safepay session ` +
        `could not be created: ${error?.message}`
    );
  }

  createNotificationForOrgUsers({
    orgId: organizationId,
    type: "custom_plan_awaiting_payment",
    title: "Custom plan approved — payment required",
    message:
      `Your custom plan (${dailyQuota} requests/day, PKR ${price.toFixed(2)}) has been approved. ` +
      `Your current plan is unchanged until you complete the payment.`,
    link: paymentLink || "/payments",
    referenceId: checkoutUuid,
    orgRoles: ["org_admin"],
  }).catch(() => {});

  const [finalReq] = await pool.query(`${CUSTOM_PLAN_REQ_SELECT} WHERE cpr.uuid=?`, [uuid]);
  const [planRows] = await pool.query(
    "SELECT uuid, name, monthly_price, daily_request_quota, is_custom FROM subscription_plans WHERE id=?",
    [approvedPlanId]
  );

  return ok(
    res,
    {
      request: finalReq[0],
      plan: planRows[0],
      checkout_uuid: checkoutUuid,
      payment_link: paymentLink,
      subscription_activated: false,
      awaiting_payment: true,
    },
    paymentLink
      ? "Custom plan approved. The organization must complete payment before the plan is applied."
      : "Custom plan approved, but the payment link could not be generated — the organization must retry payment."
  );
}

/**
 * Admin: deny a custom-plan request.
 */
export async function denyCustomPlanRequest(req, res) {
  const { uuid } = req.params;
  assertUuid(uuid, "Custom plan request UUID");

  const [reqRows] = await pool.query(
    `SELECT id, organization_id, status FROM custom_plan_requests WHERE uuid=?`,
    [uuid]
  );
  if (!reqRows.length) throw new ApiError(404, "Custom plan request not found");
  if (reqRows[0].status === "approved") {
    throw new ApiError(409, "This custom plan request is already approved");
  }
  if (reqRows[0].status === "denied") {
    throw new ApiError(409, "This custom plan request is already denied");
  }

  await pool.query(
    `UPDATE custom_plan_requests SET status='denied', decided_by=?, decided_at=NOW() WHERE id=?`,
    [req.admin?.uuid ?? null, reqRows[0].id]
  );

  const [finalReq] = await pool.query(
    `${CUSTOM_PLAN_REQ_SELECT} WHERE cpr.uuid=?`,
    [uuid]
  );

  logAudit({
    ...getActorFromReq(req),
    action: "custom_plan.deny",
    entityType: "custom_plan_request",
    entityId: uuid,
    details: { organization_id: reqRows[0].organization_id },
    req,
  });

  createNotificationForOrgUsers({
    orgId: reqRows[0].organization_id,
    type: "custom_plan_denied",
    title: "Custom plan request denied",
    message: "Your custom plan request was denied. Please contact support for details.",
    link: "/payments",
    referenceId: uuid,
    orgRoles: ["org_admin"],
  }).catch(() => {});

  return ok(res, { request: finalReq[0] }, "Custom plan request denied");
}

/* ─────────── Self-subscription requests (org-admin self-serve) ─────────── */

const SELF_SUB_SELECT = `SELECT ssr.id, ssr.uuid, ssr.amount, ssr.status, ssr.created_at, ssr.decided_at, ssr.decided_by,
        o.uuid AS organization_uuid, o.name AS organization_name, o.subscription_status,
        sp.uuid AS plan_uuid, sp.name AS plan_name, sp.monthly_price, sp.daily_request_quota, sp.billing_period,
        u.full_name AS requested_by_name, u.email AS requested_by_email
 FROM self_subscription_requests ssr
 LEFT JOIN organizations o ON o.id = ssr.organization_id
 LEFT JOIN subscription_plans sp ON sp.uuid = ssr.plan_uuid
 LEFT JOIN users u ON u.uuid = ssr.requested_by_uuid`;

/**
 * Admin: list self-subscription requests (filter by ?status=pending|confirmed|cancelled).
 */
export async function listSelfSubscriptionRequests(req, res) {
  const { page, limit, offset } = parsePagination(req.query);
  const status = typeof req.query.status === "string" ? req.query.status : null;
  if (status && !["pending", "confirmed", "cancelled"].includes(status)) {
    throw new ApiError(400, "status must be pending, confirmed or cancelled");
  }

  const where = status ? "WHERE ssr.status=?" : "";
  const params = status ? [status] : [];

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM self_subscription_requests ssr ${where}`,
    params
  );
  const [rows] = await pool.query(
    `${SELF_SUB_SELECT} ${where} ORDER BY ssr.created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  return ok(res, paginatedResponse(rows, total, page, limit), "Self-subscription requests");
}

/* ─────────── Gateway subscription checkouts (Safepay self-service) ─────────── */

const CHECKOUT_SELECT = `SELECT sc.id, sc.uuid, sc.plan_uuid, sc.plan_name, sc.gateway, sc.amount,
        sc.currency, sc.status, sc.gateway_tracker_id, sc.gateway_event_id,
        sc.created_at, sc.updated_at, sc.completed_at, sc.failed_at,
        o.uuid AS organization_uuid, o.name AS organization_name,
        o.subscription_status, o.subscription_expiry
 FROM subscription_checkouts sc
 LEFT JOIN organizations o ON o.id = sc.organization_id`;

/**
 * Admin: list gateway subscription checkouts (Safepay self-service).
 * Filter by ?status=pending|completed|failed|expired|cancelled.
 */
export async function listSubscriptionCheckouts(req, res) {
  const { page, limit, offset } = parsePagination(req.query);
  const status = typeof req.query.status === "string" ? req.query.status : null;
  if (status && !["pending", "completed", "failed", "expired", "cancelled"].includes(status)) {
    throw new ApiError(400, "status must be pending, completed, failed, expired or cancelled");
  }

  const where = status ? "WHERE sc.status=?" : "";
  const params = status ? [status] : [];

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM subscription_checkouts sc ${where}`,
    params
  );
  const [rows] = await pool.query(
    `${CHECKOUT_SELECT} ${where} ORDER BY sc.id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  return ok(res, paginatedResponse(rows, total, page, limit), "Subscription checkouts");
}

/**
 * Admin: confirm a self-subscription request after payment is received.
 * Activates the org subscription (restart from today) and records a manual
 * payment entry describing the received amount.
 */
export async function confirmSelfSubscriptionRequest(req, res) {
  const { uuid } = req.params;
  assertUuid(uuid, "Self-subscription request UUID");

  const receivedAmount = req.body?.amount != null && req.body?.amount !== ""
    ? Number(req.body.amount)
    : null;

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [reqRows] = await connection.query(
      `${SELF_SUB_SELECT} WHERE ssr.uuid=? FOR UPDATE`,
      [uuid]
    );
    if (!reqRows.length) throw new ApiError(404, "Self-subscription request not found");
    const r = reqRows[0];
    if (r.status !== "pending") {
      throw new ApiError(409, "This self-subscription request is already processed");
    }
    if (!r.organization_uuid || !r.plan_uuid) {
      throw new ApiError(400, "Request references a missing organization or plan");
    }
    if (receivedAmount != null && (!Number.isFinite(receivedAmount) || receivedAmount < 0)) {
      throw new ApiError(400, "amount must be a non-negative number");
    }

    const [[plan]] = await connection.query(
      `SELECT ${PLAN_SELECT_COLUMNS} FROM subscription_plans WHERE uuid=?`,
      [r.plan_uuid]
    );
    if (!plan) throw new ApiError(404, "Plan not found");

    const [[orgExists]] = await connection.query(
      "SELECT id FROM organizations WHERE uuid=?",
      [r.organization_uuid]
    );
    if (!orgExists) throw new ApiError(404, "Organization not found");

    // Lock the org and let the shared transition logic decide renewal vs
    // upgrade vs deferred downgrade, exactly as the Safepay webhook would.
    const org = await loadOrganizationSubscriptionState(connection, orgExists.id);
    const { expiry, action, change: appliedChange } = await activateOrgSubscription(connection, {
      organizationId: org.id,
      plan,
      now: new Date(),
      org,
      source: "self_subscribe_confirm",
    });

    await connection.query(
      `UPDATE self_subscription_requests
       SET status='confirmed', decided_by=?, decided_at=NOW()
       WHERE uuid=?`,
      [req.admin?.uuid ?? null, uuid]
    );

    // Record the received payment (manual method). Falls back to the plan's
    // monthly price when the admin did not specify an amount.
    const amountReceived = receivedAmount != null ? receivedAmount : Number(plan.monthly_price || 0);
    await recordSubscriptionPayment(connection, {
      organizationId: org.id,
      amount: amountReceived,
      method: "manual",
      transactionReference: `SELFSUB-${plan.name.replace(/\s+/g, "-").toUpperCase()}-${Date.now()}`,
      purpose: `Self-subscription: ${plan.name} for ${r.organization_name}`,
    });

    await connection.commit();

    logSubscriptionChangeApplied({
      orgUuid: org.uuid,
      organizationId: org.id,
      change: appliedChange,
      source: "self_subscribe_confirm",
      actor: getActorFromReq(req),
      extra: { plan: plan.name, amount: amountReceived },
    });

    const [finalReq] = await pool.query(`${SELF_SUB_SELECT} WHERE ssr.uuid=?`, [uuid]);

    logAudit({
      ...getActorFromReq(req),
      action: "self_subscription.confirm",
      entityType: "self_subscription_request",
      entityId: uuid,
      details: { organization_id: org.id, plan: plan.name, amount: amountReceived, transition: action },
      req,
    });

    // "Scheduled" now covers a same-plan renewal as well as a downgrade: one
    // mechanism, so the wording is chosen from `relation`.
    const isScheduled = action === "change_scheduled";
    createNotificationForOrgUsers({
      orgId: org.id,
      type: isScheduled ? "subscription_plan_change_scheduled" : "self_subscription_confirmed",
      title: isScheduled ? "Plan change scheduled" : "Subscription activated",
      message: isScheduled
        ? `Your plan will change to ${plan.name} on ${expiry.toISOString().slice(0, 10)}, when your current plan ends.`
        : `Your subscription to ${plan.name} is now active (expires ${expiry.toISOString().slice(0, 10)}).`,
      link: "/payments",
      orgRoles: ["org_admin"],
    }).catch(() => {});

    return ok(res, { request: finalReq[0] }, `Subscription activated for ${r.organization_name}`);
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * Admin: cancel a still-pending self-subscription request.
 * Reverts the organization back to no active subscription ('none').
 */
export async function cancelSelfSubscriptionRequest(req, res) {
  const { uuid } = req.params;
  assertUuid(uuid, "Self-subscription request UUID");

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [reqRows] = await connection.query(
      `SELECT ssr.id, ssr.uuid, ssr.status, ssr.organization_id, o.uuid AS organization_uuid,
              o.name AS organization_name, sp.name AS plan_name
       FROM self_subscription_requests ssr
       LEFT JOIN organizations o ON o.id = ssr.organization_id
       LEFT JOIN subscription_plans sp ON sp.uuid = ssr.plan_uuid
       WHERE ssr.uuid=? FOR UPDATE`,
      [uuid]
    );
    if (!reqRows.length) throw new ApiError(404, "Self-subscription request not found");
    const r = reqRows[0];
    if (r.status !== "pending") {
      throw new ApiError(409, "This self-subscription request is already processed");
    }

    await connection.query(
      "UPDATE self_subscription_requests SET status='cancelled', decided_by=?, decided_at=NOW() WHERE uuid=?",
      [req.admin?.uuid ?? null, uuid]
    );

    // Only revert the org if it is still awaiting payment for this request. A
    // reverted org goes back onto the real Free plan rather than into a
    // NULL / 'none' limbo, so it is never planless.
    const [[pendingOrg]] = await connection.query(
      "SELECT id FROM organizations WHERE uuid=? AND subscription_status='pending_payment' FOR UPDATE",
      [r.organization_uuid]
    );
    if (pendingOrg) {
      await assignFreePlanToOrg(connection, pendingOrg.id);
    }

    await connection.commit();

    const [finalReq] = await pool.query(`${SELF_SUB_SELECT} WHERE ssr.uuid=?`, [uuid]);

    logAudit({
      ...getActorFromReq(req),
      action: "self_subscription.cancel",
      entityType: "self_subscription_request",
      entityId: uuid,
      details: { organization_id: r.organization_id },
      req,
    });

    createNotificationForOrgUsers({
      orgId: r.organization_id,
      type: "self_subscription_cancelled",
      title: "Subscription request cancelled",
      message: `Your request to subscribe to ${r.plan_name} was cancelled. Please contact support.`,
      link: "/payments",
      referenceId: uuid,
      orgRoles: ["org_admin"],
    }).catch(() => {});

    return ok(res, { request: finalReq[0] }, "Self-subscription request cancelled");
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
