import ApiError from "../utils/ApiError.js";
import { pool } from "../config/db.js";
import { ok } from "../utils/response.js";
import { getPlanSummary } from "../utils/plan.js";
import { calculatePlanExpiry, getPurchasablePlan, getPurchasablePlans } from "../utils/paymentPlans.js";
import { getOrgQuotaStatus } from "../utils/requestQuota.js";
import { normalizePlanFeatures } from "../utils/planFeatures.js";
import {
  applySubscriptionChange,
  loadOrganizationSubscriptionState,
  logSubscriptionChangeApplied,
  PLAN_SELECT_COLUMNS,
  resolveSubscriptionChange,
} from "../utils/subscriptionTransition.js";
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

  // transaction_reference is the deduplication identity for a payment row
  // (UNIQUE uq_payment_txn_ref). A reference-less callback is rejected rather
  // than assigned a generated PAY-<now> value that would falsely look unique.
  const transactionReference =
    typeof callbackResult.transactionReference === "string" ? callbackResult.transactionReference.trim() : "";
  if (!transactionReference) {
    throw new ApiError(400, "Transaction reference missing from payment callback");
  }

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

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
    const org = await loadOrganizationSubscriptionState(connection, organizationId);

    // "Already processed?" is checked AFTER acquiring the organization lock, so
    // concurrent duplicate callbacks for the same reference serialize behind the
    // first commit instead of racing past the lookup and double-extending the
    // subscription.
    const [existingPayments] = await connection.query(
      "SELECT * FROM payment WHERE transaction_reference=? LIMIT 1",
      [transactionReference]
    );

    if (existingPayments.length) {
      await connection.commit();
      return { payment: existingPayments[0], already_recorded: true, payment_meta: paymentMeta };
    }

    // Assign a plan row when the purchasable plan matches one by name
    // (e.g. "Basic"); otherwise keep the org's existing plan assignment.
    const [[planMatch]] = await connection.query(
      `SELECT ${PLAN_SELECT_COLUMNS} FROM subscription_plans WHERE name=? ORDER BY id ASC LIMIT 1`,
      [expectedPlan.label]
    );

    let planId;
    let appliedChange = null;
    if (planMatch) {
      // A real DB plan: use the shared transition logic so a JazzCash/Easypaisa
      // renewal extends the current expiry and a downgrade is deferred, exactly
      // like a Safepay payment.
      appliedChange = resolveSubscriptionChange(org, planMatch);
      await applySubscriptionChange(connection, { organizationId, change: appliedChange });
      planId = appliedChange.subscription_plan_id;
    } else {
      // No matching subscription_plans row: the legacy env-configured plan
      // (BASIC_PLAN_DURATION_DAYS etc.) is not a DB plan, so there is no plan to
      // switch tiers to. Keep the historical "extend the current expiry" date
      // math for this path only.
      const nextExpiry = calculatePlanExpiry(org.subscription_expiry, expectedPlan.duration_days);
      planId = org.subscription_plan_id ?? null;
      await connection.query(
        `UPDATE organizations
         SET subscription_status='active',
             subscription_start=CASE WHEN ? THEN NOW() ELSE subscription_start END,
             subscription_expiry=?, subscription_plan_id=?,
             reminder_2d_sent='no', reminder_2h_sent='no'
         WHERE id=?`,
        [org.subscription_status !== "active", formatSqlDateTime(nextExpiry), planId, organizationId]
      );
    }

    let insertId;
    try {
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
      insertId = insertResult.insertId;
    } catch (error) {
      // UNIQUE uq_payment_txn_ref: a concurrent delivery recorded this payment
      // first. Roll back THIS attempt's subscription extension so the payment is
      // recorded exactly once, and respond idempotently.
      if (error?.errno === 1062 || error?.code === "ER_DUP_ENTRY") {
        await connection.rollback();
        const [duplicateRows] = await pool.query(
          "SELECT * FROM payment WHERE transaction_reference=? LIMIT 1",
          [transactionReference]
        );
        return { payment: duplicateRows[0] ?? null, already_recorded: true, payment_meta: paymentMeta };
      }
      throw error;
    }

    const [paymentRows] = await connection.query("SELECT * FROM payment WHERE id=?", [insertId]);

    await connection.commit();

    // Audit after the commit so an unexplained subscription change is traceable
    // to this callback rather than leaving no record at all.
    if (appliedChange) {
      logSubscriptionChangeApplied({
        orgUuid: org.uuid,
        organizationId,
        change: appliedChange,
        source: `provider_callback:${callbackResult.provider}`,
        extra: { plan: planMatch.name, transaction_reference: transactionReference },
      });
    }

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
              o.subscription_plan_id, o.pending_plan_id,
              sp.uuid AS plan_uuid, sp.name AS plan_name, sp.is_free AS is_free,
              sp.monthly_price, sp.daily_request_quota,
              sp.description, sp.features, sp.module_flags,
              pp.name AS pending_plan_name, pp.daily_request_quota AS pending_plan_daily_request_quota,
              pp.monthly_price AS pending_plan_monthly_price
       FROM organizations o
       LEFT JOIN subscription_plans sp ON sp.id = o.subscription_plan_id
       LEFT JOIN subscription_plans pp ON pp.id = o.pending_plan_id
       WHERE o.id=?`,
      [organizationId]
    );
    if (org) {
      // A Free plan has no expiry, so a NULL expiry is its normal state and must
      // never be read as "expired". For a paid plan the lazy flip keeps admin
      // lists and the dashboard consistent; the lifecycle job then moves the org
      // onto the Free plan rather than leaving it in 'expired' limbo.
      const isFree = Number(org.is_free) === 1;
      if (
        !isFree &&
        org.subscription_status === "active" &&
        org.subscription_expiry &&
        new Date(org.subscription_expiry) < new Date()
      ) {
        org.subscription_status = "expired";
        await pool.query("UPDATE organizations SET subscription_status='expired' WHERE id=?", [org.id]);
      }
      let features = normalizePlanFeatures(org.features);
      let moduleFlags = null;
      if (org.module_flags != null) {
        try {
          moduleFlags = JSON.parse(org.module_flags);
        } catch {
          moduleFlags = null;
        }
      }
      orgSubscription = {
        status: org.subscription_status,
        plan: org.plan_name || null,
        plan_name: org.plan_name || null,
        // The Free plan is recognised by its flag, never by name or price.
        is_free: isFree,
        plan_uuid: org.plan_uuid || null,
        monthly_price: org.monthly_price != null ? Number(org.monthly_price) : null,
        daily_request_quota: org.daily_request_quota != null ? Number(org.daily_request_quota) : null,
        description: org.description || null,
        features,
        module_flags: moduleFlags,
        expiry: org.subscription_expiry,
        start: org.subscription_start,
        // A deferred downgrade: the lower-tier plan takes over when the current
        // period ends, so the effective date is the current expiry.
        pending_plan_id: org.pending_plan_id ?? null,
        pending_plan_name: org.pending_plan_name || null,
        pending_plan_daily_request_quota:
          org.pending_plan_daily_request_quota != null
            ? Number(org.pending_plan_daily_request_quota)
            : null,
        pending_plan_monthly_price:
          org.pending_plan_monthly_price != null ? Number(org.pending_plan_monthly_price) : null,
        pending_plan_effective_at: org.pending_plan_id ? org.subscription_expiry : null,
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
  const planSummary = getPlanSummary(orgSubscription);

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
