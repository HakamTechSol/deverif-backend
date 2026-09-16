import ApiError from "../utils/ApiError.js";
import { pool } from "../config/db.js";
import { ok } from "../utils/response.js";
import { getPlanSummary } from "../utils/plan.js";
import { calculatePlanExpiry, getPurchasablePlan, getPurchasablePlans } from "../utils/paymentPlans.js";
import { getOrgQuotaStatus } from "../utils/requestQuota.js";
import { normalizePlanFeatures } from "../utils/planFeatures.js";
import {
  buildProviderCheckout,
  getEnabledProviders,
  getFrontendReturnUrl,
  parsePaymentReference,
  parseProviderCallback
} from "../utils/paymentGateway.js";

function formatSqlDateTime(date) {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

async function finalizeSuccessfulPayment(callbackResult) {
  if (!callbackResult.paymentReference) {
    throw new ApiError(400, "Payment reference missing from callback");
  }

  const paymentMeta = parsePaymentReference(callbackResult.paymentReference);

  if (paymentMeta.provider !== callbackResult.provider) {
    throw new ApiError(400, "Payment provider does not match signed reference");
  }

  const expectedPlan = getPurchasablePlan(paymentMeta.planCode);

  if (callbackResult.amount !== null && Math.abs(Number(callbackResult.amount) - expectedPlan.amount) > 0.01) {
    throw new ApiError(400, "Payment amount does not match selected plan");
  }

  const transactionReference = callbackResult.transactionReference || `PAY-${Date.now()}`;
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [existingPayments] = await connection.query(
      "SELECT * FROM payment WHERE transaction_reference=? LIMIT 1",
      [transactionReference]
    );

    if (existingPayments.length) {
      await connection.commit();
      return { payment: existingPayments[0], already_recorded: true, payment_meta: paymentMeta };
    }

    const [userRows] = await connection.query(
      `SELECT id, organization
       FROM users
       WHERE uuid=?
       LIMIT 1
       FOR UPDATE`,
      [paymentMeta.userUuid]
    );

    if (!userRows.length) {
      throw new ApiError(404, "User for payment not found");
    }

    const organizationId = userRows[0].organization;
    if (!organizationId) {
      throw new ApiError(
        400,
        "Subscription is managed by your organization, but your account is not linked to one"
      );
    }

    // Subscriptions are org-scoped: the payment activates/extends the
    // organization's subscription, never the user's.
    const [orgRows] = await connection.query(
      `SELECT id, subscription_status, subscription_expiry, subscription_plan_id
       FROM organizations
       WHERE id=?
       FOR UPDATE`,
      [organizationId]
    );
    if (!orgRows.length) {
      throw new ApiError(404, "Organization for payment not found");
    }
    const org = orgRows[0];

    const nextExpiry = calculatePlanExpiry(org.subscription_expiry, expectedPlan.duration_days);

    // Assign a plan row when the purchasable plan matches one by name
    // (e.g. "Basic"); otherwise keep the org's existing plan assignment.
    let planId = org.subscription_plan_id ?? null;
    const [[planMatch]] = await connection.query(
      "SELECT id FROM subscription_plans WHERE name=? ORDER BY id ASC LIMIT 1",
      [expectedPlan.label]
    );
    if (planMatch) planId = planMatch.id;

    await connection.query(
      `UPDATE organizations
       SET subscription_status='active',
           subscription_start=CASE WHEN ? THEN NOW() ELSE subscription_start END,
           subscription_expiry=?, subscription_plan_id=?,
           reminder_2d_sent='no', reminder_2h_sent='no'
       WHERE id=?`,
      [org.subscription_status !== "active", formatSqlDateTime(nextExpiry), planId, organizationId]
    );

    const [insertResult] = await connection.query(
      `INSERT INTO payment (user_id, organization_id, amount, payment_method, transaction_reference, paid_at, purpose)
       VALUES (?, ?, ?, ?, ?, NOW(), ?)`,
      [
        userRows[0].id,
        organizationId,
        expectedPlan.amount,
        callbackResult.provider,
        transactionReference,
        paymentMeta.purpose
      ]
    );

    const [paymentRows] = await connection.query("SELECT * FROM payment WHERE id=?", [insertResult.insertId]);

    await connection.commit();

    return { payment: paymentRows[0], already_recorded: false, payment_meta: paymentMeta };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function myPlan(req, res) {
  const [rows] = await pool.query(
    `SELECT id, uuid, organization
     FROM users
     WHERE id=?`,
    [req.user.id]
  );

  const user = rows[0] || req.user;

  // Resolve the organization from the freshest DB row and fall back to the
  // (possibly stale) JWT claim, so a user whose org changed still sees the
  // correct quota and subscription.
  const organizationId =
    user?.organization != null ? user.organization : req.user?.organization;

  let orgSubscription = null;
  let quotaStatus = null;
  let payments = [];
  if (organizationId) {
    const [[org]] = await pool.query(
      `SELECT o.id, o.subscription_status, o.subscription_expiry, o.subscription_start,
              o.subscription_plan_id, sp.name AS plan_name, sp.monthly_price, sp.daily_request_quota,
              sp.description, sp.features
       FROM organizations o
       LEFT JOIN subscription_plans sp ON sp.id = o.subscription_plan_id
       WHERE o.id=?`,
      [organizationId]
    );
    if (org) {
      if (org.subscription_status === "active" && org.subscription_expiry && new Date(org.subscription_expiry) < new Date()) {
        org.subscription_status = "expired";
        await pool.query("UPDATE organizations SET subscription_status='expired' WHERE id=?", [org.id]);
      }
      let features = normalizePlanFeatures(org.features);
      orgSubscription = {
        status: org.subscription_status,
        plan: org.plan_name || null,
        plan_name: org.plan_name || null,
        monthly_price: org.monthly_price != null ? Number(org.monthly_price) : null,
        daily_request_quota: org.daily_request_quota != null ? Number(org.daily_request_quota) : null,
        description: org.description || null,
        features,
        expiry: org.subscription_expiry,
        start: org.subscription_start,
      };
      quotaStatus = await getOrgQuotaStatus(org.id);
    }

    const [paymentRows] = await pool.query(
      `SELECT p.uuid, p.amount, p.payment_method, p.transaction_reference, p.paid_at, p.purpose,
              u.uuid AS user_uuid, u.full_name, u.email
       FROM payment p
       JOIN users u ON u.id = p.user_id
       WHERE p.organization_id = ?
       ORDER BY p.paid_at DESC
       LIMIT 50`,
      [organizationId]
    );
    payments = paymentRows;
  }

  // Build the plan summary from the org subscription (the only place the plan
  // lives); orgless users report the free tier.
  const planSummary = getPlanSummary(user, orgSubscription);

  return ok(res, {
    plan: planSummary,
    org_subscription: orgSubscription,
    quota_status: quotaStatus,
    payments,
  }, "My plan");
}

export async function paymentProviders(req, res) {
  return ok(
    res,
    {
      providers: getEnabledProviders(),
      plans: Object.values(getPurchasablePlans())
    },
    "Payment providers"
  );
}

export async function initiatePayment(req, res) {
  const { provider, plan, purpose } = req.body || {};

  if (!provider || !plan) {
    throw new ApiError(400, "provider and plan are required");
  }

  const selectedPlan = getPurchasablePlan(plan);
  const checkout = buildProviderCheckout({
    provider,
    user: req.user,
    plan: selectedPlan,
    purpose
  });

  return ok(
    res,
    {
      payment: checkout,
      plan: selectedPlan
    },
    `${checkout.provider_label} checkout prepared`
  );
}

export async function handlePaymentCallback(req, res) {
  const callbackResult = parseProviderCallback(req.params.provider, {
    ...(req.query || {}),
    ...(req.body || {})
  });

  if (!callbackResult.success) {
    const redirectUrl = getFrontendReturnUrl({
      provider: callbackResult.provider,
      status: "failed",
      transactionReference: callbackResult.transactionReference
    });

    if (req.method === "GET" && redirectUrl) {
      return res.redirect(redirectUrl);
    }

    return res.status(400).json({
      success: false,
      message: callbackResult.message || "Payment was not approved",
      data: callbackResult
    });
  }

  const finalized = await finalizeSuccessfulPayment(callbackResult);
  const redirectUrl = getFrontendReturnUrl({
    provider: callbackResult.provider,
    status: "success",
    transactionReference: finalized.payment.transaction_reference,
    planCode: finalized.payment_meta.planCode
  });

  if (req.method === "GET" && redirectUrl) {
    return res.redirect(redirectUrl);
  }

  return ok(
    res,
    {
      payment: finalized.payment,
      already_recorded: finalized.already_recorded,
      plan_code: finalized.payment_meta.planCode
    },
    finalized.already_recorded ? "Payment already recorded" : "Payment recorded successfully"
  );
}
