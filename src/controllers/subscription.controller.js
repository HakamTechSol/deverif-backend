import ApiError from "../utils/ApiError.js";
import { pool } from "../config/db.js";
import { ok, created } from "../utils/response.js";
import { getOrgQuotaStatus } from "../utils/requestQuota.js";
import { assertUuid } from "../utils/publicResponse.js";
import { createNotificationForUsers } from "./notification.controller.js";

/**
 * Org user: current quota status for their organization.
 */
export async function myQuota(req, res) {
  if (!req.user.organization) {
    throw new ApiError(400, "Your account is not linked to an organization");
  }
  const status = await getOrgQuotaStatus(req.user.organization);
  return ok(res, status, "Request quota status");
}

/**
 * Org user: list this organization's custom-plan requests.
 */
export async function listOrgCustomPlanRequests(req, res) {
  if (!req.user.organization) {
    throw new ApiError(400, "Your account is not linked to an organization");
  }
  const [rows] = await pool.query(
    `SELECT cpr.uuid, cpr.message, cpr.requested_quota, cpr.requested_price, cpr.status,
            cpr.approved_daily_quota, cpr.approved_price, cpr.created_at,
            cpr.decided_at, cpr.decided_by,
            u.full_name AS requested_by_name
     FROM custom_plan_requests cpr
     LEFT JOIN users u ON u.uuid = cpr.requested_by_uuid
     WHERE cpr.organization_id=?
     ORDER BY cpr.created_at DESC`,
    [req.user.organization]
  );
  return ok(res, { items: rows }, "Custom plan requests");
}

/**
 * Org user: submit a "Request Custom Plan" request to the System Admin.
 */
export async function requestCustomPlan(req, res) {
  if (!req.user.organization) {
    throw new ApiError(400, "Your account is not linked to an organization");
  }
  const message = req.body?.message ? String(req.body.message).trim() : "";

  const requestedQuota = req.body?.requested_quota;
  if (requestedQuota === undefined || requestedQuota === null || String(requestedQuota).trim() === "") {
    throw new ApiError(400, "requested_quota is required");
  }
  const quotaNum = Number(requestedQuota);
  if (!Number.isInteger(quotaNum) || quotaNum <= 0) {
    throw new ApiError(400, "requested_quota must be a positive integer");
  }

  let priceNum = null;
  if (req.body?.requested_price !== undefined && req.body?.requested_price !== null && String(req.body.requested_price).trim() !== "") {
    priceNum = Number(req.body.requested_price);
    if (!Number.isFinite(priceNum) || priceNum <= 0) {
      throw new ApiError(400, "requested_price must be a positive number");
    }
  }

  const [[org]] = await pool.query(
    "SELECT id, uuid, name, subscription_status FROM organizations WHERE id=?",
    [req.user.organization]
  );
  if (!org) throw new ApiError(404, "Organization not found");

  // Prevent duplicate pending requests.
  const [pending] = await pool.query(
    "SELECT id FROM custom_plan_requests WHERE organization_id=? AND status='pending' LIMIT 1",
    [org.id]
  );
  if (pending.length) {
    throw new ApiError(400, "You already have a pending custom plan request");
  }

  const [result] = await pool.query(
    `INSERT INTO custom_plan_requests (organization_id, requested_by_uuid, message, requested_quota, requested_price, status)
     VALUES (?, ?, ?, ?, ?, 'pending')`,
    [org.id, req.user.uuid, message || null, quotaNum, priceNum != null ? priceNum.toFixed(2) : null]
  );

  const [rows] = await pool.query(
    `SELECT cpr.*, u.full_name AS requested_by_name
     FROM custom_plan_requests cpr
     LEFT JOIN users u ON u.uuid = cpr.requested_by_uuid
     WHERE cpr.id=?`,
    [result.insertId]
  );

  // Notify system admins about the new custom-plan request.
  const [adminUuids] = await pool.query(
    "SELECT uuid FROM admin_profiles WHERE status='active' OR status IS NULL"
  );
  if (adminUuids.length) {
    createNotificationForUsers({
      userIds: adminUuids.map((r) => r.uuid),
      type: "custom_plan_request",
      title: "Custom plan request",
      message: `${org.name} requested a custom plan (${quotaNum} requests/day).`,
      link: "/admin/payments",
      referenceId: rows[0].uuid,
    }).catch(() => {});
  }

  return created(res, { request: rows[0] }, "Custom plan request submitted");
}

/**
 * Org admin (self-serve): subscribe this organization to a PUBLIC plan while
 * there is no active subscription. Because there is no live payment gateway,
 * this does NOT grant access immediately. Instead it places the organization
 * in a 'pending_payment' state (recorded intent) that the System Admin must
 * confirm once payment is received outside the platform.
 *
 * Only non-custom, publicly-available plans may be requested here; custom
 * plans remain System-Admin-assigned via the separate Custom Plan Request flow.
 */
export async function selfSubscribe(req, res) {
  if (!req.user.organization) {
    throw new ApiError(400, "Your account is not linked to an organization");
  }
  const { plan_uuid, amount } = req.body || {};
  if (!plan_uuid) throw new ApiError(400, "plan_uuid is required");
  assertUuid(plan_uuid, "Plan UUID");

  const [[plan]] = await pool.query(
    `SELECT id, name, monthly_price, daily_request_quota, billing_period
     FROM subscription_plans
     WHERE uuid=? AND is_custom=0 AND is_public=1`,
    [plan_uuid]
  );
  if (!plan) throw new ApiError(404, "Plan not found or not available for self-subscription");

  const [orgRows] = await pool.query(
    "SELECT id, uuid, name, subscription_status FROM organizations WHERE id=?",
    [req.user.organization]
  );
  if (!orgRows.length) throw new ApiError(404, "Organization not found");
  const org = orgRows[0];

  if (org.subscription_status === "active") {
    throw new ApiError(400, "Your organization already has an active subscription. Use Change Plan to switch it.");
  }
  if (org.subscription_status === "pending_payment") {
    throw new ApiError(400, "You already have a subscription awaiting payment confirmation from the System Admin.");
  }

  // Prevent duplicate pending self-subscriptions (plus a safety net for the
  // same org/plan combination that is still awaiting confirmation).
  const [pending] = await pool.query(
    "SELECT id FROM self_subscription_requests WHERE organization_id=? AND status='pending' LIMIT 1",
    [org.id]
  );
  if (pending.length) {
    throw new ApiError(400, "You already have a subscription request awaiting payment confirmation.");
  }

  const numericAmount = amount != null && amount !== "" ? Number(amount) : null;
  if (numericAmount != null && (!Number.isFinite(numericAmount) || numericAmount < 0)) {
    throw new ApiError(400, "amount must be a non-negative number");
  }

  const now = new Date();
  const [result] = await pool.query(
    `INSERT INTO self_subscription_requests
       (organization_id, plan_uuid, requested_by_uuid, amount, status)
     VALUES (?, ?, ?, ?, 'pending')`,
    [org.id, plan_uuid, req.user.uuid, numericAmount]
  );
  const requestUuid = result?.insertId;
  const [[request]] = await pool.query(
    "SELECT uuid FROM self_subscription_requests WHERE id=?",
    [requestUuid]
  );

  await pool.query(
    `UPDATE organizations
     SET subscription_status='pending_payment', subscription_start=?,
         subscription_plan_id=?,
         reminder_2d_sent='no', reminder_2h_sent='no'
     WHERE id=?`,
    [now, plan.id, org.id]
  );

  // Notify system admins about the new self-subscription request.
  const [adminUuids] = await pool.query(
    "SELECT uuid FROM admin_profiles WHERE status='active' OR status IS NULL"
  );
  if (adminUuids.length) {
    createNotificationForUsers({
      userIds: adminUuids.map((r) => r.uuid),
      type: "self_subscription_request",
      title: "Self-subscription request",
      message: `${org.name} requested to subscribe to ${plan.name}. Awaiting payment confirmation.`,
      link: "/admin/payments?tab=self-subscriptions",
      referenceId: request?.uuid ?? null,
    }).catch(() => {});
  }

  return ok(
    res,
    {
      subscription: {
        status: "pending_payment",
        plan: plan.name,
        plan_name: plan.name,
        monthly_price: Number(plan.monthly_price),
        daily_request_quota: Number(plan.daily_request_quota),
        expiry: null,
        start: now.toISOString(),
      },
    },
    `Subscription request for ${plan.name} submitted. The System Admin will activate it once payment is confirmed.`
  );
}
