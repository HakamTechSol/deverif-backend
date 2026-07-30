import ApiError from "../utils/ApiError.js";
import { pool } from "../config/db.js";
import { ok } from "../utils/response.js";
import { getPlanSummary } from "../utils/plan.js";
import { calculatePlanExpiry, getPurchasablePlan, getPurchasablePlans } from "../utils/paymentPlans.js";
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
      `SELECT id, subscription_plan, subscription_expiry
       FROM users
       WHERE uuid=?
       LIMIT 1
       FOR UPDATE`,
      [paymentMeta.userUuid]
    );

    if (!userRows.length) {
      throw new ApiError(404, "User for payment not found");
    }

    const nextExpiry = calculatePlanExpiry(userRows[0].subscription_expiry, expectedPlan.duration_days);

    await connection.query(
      `UPDATE users
       SET subscription_plan=?, subscription_expiry=?
       WHERE id=?`,
      [expectedPlan.code, formatSqlDateTime(nextExpiry), userRows[0].id]
    );

    const [insertResult] = await connection.query(
      `INSERT INTO payment (user_id, amount, payment_method, transaction_reference, paid_at, purpose)
       VALUES (?, ?, ?, ?, NOW(), ?)`,
      [
        userRows[0].id,
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
    `SELECT id, subscription_plan, subscription_expiry
     FROM users
     WHERE id=?`,
    [req.user.id]
  );

  const user = rows[0] || req.user;
  const planSummary = getPlanSummary(user);

  let orgSubscription = null;
  let payments = [];
  if (req.user.organization) {
    const [[org]] = await pool.query(
      `SELECT id, subscription_status, subscription_plan, subscription_expiry, subscription_start
       FROM organizations WHERE id=?`,
      [req.user.organization]
    );
    if (org) {
      if (org.subscription_status === "active" && org.subscription_expiry && new Date(org.subscription_expiry) < new Date()) {
        org.subscription_status = "expired";
        await pool.query("UPDATE organizations SET subscription_status='expired' WHERE id=?", [org.id]);
      }
      orgSubscription = {
        status: org.subscription_status,
        plan: org.subscription_plan,
        expiry: org.subscription_expiry,
        start: org.subscription_start,
      };
    }

    const [paymentRows] = await pool.query(
      `SELECT p.uuid, p.amount, p.payment_method, p.transaction_reference, p.paid_at, p.purpose,
              u.uuid AS user_uuid, u.full_name, u.email
       FROM payment p
       JOIN users u ON u.id = p.user_id
       WHERE u.organization = ?
       ORDER BY p.paid_at DESC
       LIMIT 50`,
      [req.user.organization]
    );
    payments = paymentRows;
  }

  return ok(res, { plan: planSummary, org_subscription: orgSubscription, payments }, "My plan");
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
