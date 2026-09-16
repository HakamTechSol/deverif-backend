import ApiError from "../../utils/ApiError.js";
import { pool } from "../../config/db.js";
import { ok } from "../../utils/response.js";
import { assertUuid } from "../../utils/publicResponse.js";
import { parsePagination, paginatedResponse } from "../../utils/pagination.js";
import { createNotificationForOrgUsers } from "../notification.controller.js";
import { logAudit, getActorFromReq } from "../../utils/auditLog.js";
import {
  activateOrgSubscription,
  recordSubscriptionPayment,
} from "../../services/payment.service.js";

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
 * Creates an is_custom subscription_plans entry and assigns it to the org,
 * then marks the request approved and activates the org subscription.
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
    if (planReq.status === "approved") {
      throw new ApiError(409, "This custom plan request is already approved");
    }
    if (planReq.status === "denied") {
      throw new ApiError(409, "This custom plan request was already denied");
    }

    // Create the custom plan.
    const planName = `Custom Plan — ${planReq.organization_name}`;
    const [planResult] = await connection.query(
      `INSERT INTO subscription_plans (name, monthly_price, daily_request_quota, is_custom)
       VALUES (?, ?, ?, 1)`,
      [planName, price.toFixed(2), dailyQuota]
    );
    const planId = planResult.insertId;

    // Assign to the organization and activate for 1 month.
    const now = new Date();
    const expiry = new Date(now);
    expiry.setMonth(expiry.getMonth() + 1);
    await connection.query(
      `UPDATE organizations
       SET subscription_status='active', subscription_start=?, subscription_expiry=?,
           subscription_plan_id=?, reminder_2d_sent='no', reminder_2h_sent='no'
       WHERE id=?`,
      [now, expiry, planId, planReq.organization_id]
    );

    // Mark the request approved.
    await connection.query(
      `UPDATE custom_plan_requests
       SET status='approved', approved_daily_quota=?, approved_price=?, decided_by=?, decided_at=NOW()
       WHERE id=?`,
      [dailyQuota, price.toFixed(2), req.admin?.uuid ?? null, planReq.id]
    );

    await connection.commit();

    const [finalReq] = await pool.query(
      `${CUSTOM_PLAN_REQ_SELECT} WHERE cpr.uuid=?`,
      [uuid]
    );
    const [planRows] = await pool.query(
      "SELECT uuid, name, monthly_price, daily_request_quota, is_custom FROM subscription_plans WHERE id=?",
      [planId]
    );

    logAudit({
      ...getActorFromReq(req),
      action: "custom_plan.approve",
      entityType: "custom_plan_request",
      entityId: uuid,
      details: { daily_quota: dailyQuota, price, organization_id: planReq.organization_id },
      req,
    });

    // Notify the organization.
    createNotificationForOrgUsers({
      orgId: planReq.organization_id,
      type: "custom_plan_approved",
      title: "Custom plan approved",
      message: `Your custom plan was approved: ${dailyQuota} requests/day.`,
      link: "/payments",
      referenceId: uuid,
      orgRoles: ["org_admin"],
    }).catch(() => {});

    return ok(
      res,
      { request: finalReq[0], plan: planRows[0] },
      "Custom plan approved and assigned"
    );
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
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
      "SELECT id, name, monthly_price, billing_period FROM subscription_plans WHERE uuid=?",
      [r.plan_uuid]
    );
    if (!plan) throw new ApiError(404, "Plan not found");

    const [[org]] = await connection.query(
      "SELECT id FROM organizations WHERE uuid=?",
      [r.organization_uuid]
    );
    if (!org) throw new ApiError(404, "Organization not found");

    const { expiry } = await activateOrgSubscription(connection, {
      organizationId: org.id,
      plan,
      now: new Date(),
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

    const [finalReq] = await pool.query(`${SELF_SUB_SELECT} WHERE ssr.uuid=?`, [uuid]);

    logAudit({
      ...getActorFromReq(req),
      action: "self_subscription.confirm",
      entityType: "self_subscription_request",
      entityId: uuid,
      details: { organization_id: org.id, plan: plan.name, amount: amountReceived },
      req,
    });

    createNotificationForOrgUsers({
      orgId: org.id,
      type: "self_subscription_confirmed",
      title: "Subscription activated",
      message: `Your subscription to ${plan.name} is now active (expires ${expiry.toISOString().slice(0, 10)}).`,
      link: "/payments",
      referenceId: uuid,
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

    // Only revert the org if it is still awaiting payment for this request.
    await connection.query(
      `UPDATE organizations
       SET subscription_status='none', subscription_start=NULL, subscription_expiry=NULL,
           subscription_plan_id=NULL, reminder_2d_sent='no', reminder_2h_sent='no'
       WHERE uuid=? AND subscription_status='pending_payment'`,
      [r.organization_uuid]
    );

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
