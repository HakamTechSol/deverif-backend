import { pool } from "../config/db.js";
import ApiError from "./ApiError.js";
import { isFreePlan } from "./subscriptionPlans.js";

// Local date string (YYYY-MM-DD) used for the daily quota bucket.
export function todayStr(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Free requests available to EVERY organization per day (independent of plan).
export const FREE_DAILY_REQUESTS = 1;

/**
 * Clear today's usage bucket for an organization.
 *
 * Called whenever a new plan is activated for an organization (custom plan
 * approval, admin plan change, successful upgrade payment). Without this the
 * previous plan's consumption carried into the new plan for the rest of the day:
 * an org that had burned the 10/day of a small plan and was then moved to a
 * 100/day custom plan saw only 90 remaining, because the 10 already consumed
 * were subtracted from the fresh allowance.
 *
 * A plan change is a new entitlement, so the customer starts the new plan with
 * its full daily allowance. Deleting the row is safe — it has no foreign keys,
 * and enforceRequestQuota re-creates today's bucket on the next request.
 *
 * Pass an open transaction connection to join the caller's transaction.
 */
export async function resetDailyRequestUsage(orgId, connection = null) {
  const runner = connection || pool;
  await runner.query(
    `DELETE FROM daily_request_usage WHERE organization_id=? AND date=?`,
    [orgId, todayStr()]
  );
}

/**
 * Resolve the current plan quota for an organization.
 * Returns { quota, plan_id, plan_uuid, plan_name, is_free, is_active }.
 *
 * `is_active` is the single read-side definition of "this org is entitled to
 * its paid plan right now": the subscription must be active and, for a paid
 * plan, not yet past its expiry. The Free plan is always active (it has no
 * expiry, which means "indefinite" rather than "expired") but contributes no
 * paid quota.
 */
export async function getOrgPlan(orgId) {
  const [[row]] = await pool.query(
    `SELECT o.subscription_plan_id AS plan_id,
            o.subscription_status AS subscription_status,
            o.subscription_expiry AS subscription_expiry,
            sp.uuid AS plan_uuid, sp.name AS plan_name, sp.daily_request_quota AS quota,
            sp.is_free AS is_free
     FROM organizations o
     LEFT JOIN subscription_plans sp ON sp.id = o.subscription_plan_id
     WHERE o.id = ?`,
    [orgId]
  );
  const isFree = isFreePlan(row);
  // Paid quota only applies while the subscription is genuinely live. The FREE
  // plan is paid-neutral: it is always "active" but its quota stays 0 so the org
  // keeps the 1 FREE request/day baseline.
  //
  // The expiry check matters: the lifecycle job moves a lapsed paid plan onto
  // Free within the hour, and until it does the row can still say
  // subscription_status='active' with an expiry in the past. Honouring that flag
  // alone would hand a lapsed org its full paid quota.
  const expiry = row?.subscription_expiry ? new Date(row.subscription_expiry) : null;
  const notLapsed = !row?.subscription_expiry || (expiry && !Number.isNaN(expiry.getTime()) && expiry > new Date());
  const isActive = row?.subscription_status === "active" && !!notLapsed;

  return {
    quota: isActive && !isFree ? Number(row?.quota ?? 0) : 0,
    plan_id: row?.plan_id ?? null,
    plan_uuid: row?.plan_uuid ?? null,
    plan_name: row?.plan_name ?? null,
    is_free: isFree,
    is_active: isActive,
  };
}

/**
 * Read-only view of today's quota status for an organization (for display).
 * Does NOT consume anything.
 */
export async function getOrgQuotaStatus(orgId) {
  const today = todayStr();
  const [[usage]] = await pool.query(
    `SELECT requests_used, total_requests FROM daily_request_usage WHERE organization_id=? AND date=?`,
    [orgId, today]
  );
  const plan = await getOrgPlan(orgId);
  const used = Number(usage?.requests_used ?? 0);
  const totalRequests = Number(usage?.total_requests ?? 0);
  // While the organization has an ACTIVE subscription the free daily request is
  // disabled and only the paid plan quota applies. The FREE request only works
  // when there is no active subscription (inactive/expired/free).
  const planQuota = plan.quota;
  const freeDaily = planQuota > 0 ? 0 : FREE_DAILY_REQUESTS;
  const totalAllowance = planQuota + freeDaily;
  return {
    date: today,
    free_daily_requests: freeDaily,
    plan_quota: planQuota,
    total_allowance: totalAllowance,
    requests_used: used,          // paid requests consumed today
    total_requests: totalRequests,
    requests_remaining: Math.max(0, totalAllowance - totalRequests),
    plan: {
      uuid: plan.plan_uuid,
      name: plan.plan_name,
      daily_request_quota: plan.quota,
    },
  };
}

/**
 * Enforce the daily request quota for an organization and, if allowed,
 * atomically consume one request slot.
 *
 * While the organization has an ACTIVE subscription, the free daily request is
 * DISABLED — every request consumes a paid slot from the plan's daily quota.
 * When there is NO active subscription (inactive/expired/free), the org gets the
 * 1 FREE request/day and nothing else.
 *
 * Throw ApiError(429, ...) with a clear message when the limit is reached.
 * Returns { is_free, requests_used, quota, allowed }.
 *
 * Pass `existingConnection` to make the consumption part of a caller's
 * transaction: the FOR UPDATE locks are then held until that caller commits or
 * rolls back, and a failure anywhere after this call (e.g. the verification
 * request INSERT failing) unwinds the consumption with it. Without it, this
 * function owns the connection and commits immediately, which is what let a
 * rejected document permanently burn a daily request.
 *
 * When joining a caller's transaction this function deliberately does NOT
 * commit, roll back or release: that is the caller's to decide.
 */
export async function enforceRequestQuota(orgId, existingConnection = null) {
  const today = todayStr();
  const ownsTransaction = !existingConnection;
  const connection = existingConnection || (await pool.getConnection());

  const reject = async (error) => {
    if (ownsTransaction) await connection.rollback();
    throw error;
  };

  try {
    if (ownsTransaction) await connection.beginTransaction();

    // Lock the organization row + its plan.
    const [[org]] = await connection.query(
      `SELECT o.subscription_status AS subscription_status,
              o.subscription_expiry AS subscription_expiry,
              sp.daily_request_quota AS quota,
              sp.is_free AS is_free
       FROM organizations o
       LEFT JOIN subscription_plans sp ON sp.id = o.subscription_plan_id
       WHERE o.id = ?
       FOR UPDATE`,
      [orgId]
    );
    // Paid quota applies only while the subscription is genuinely live — and
    // "live" includes not being past its expiry (see getOrgPlan). The FREE plan
    // is paid-neutral: it is always active but its quota stays 0, so the
    // 1 FREE request/day baseline keeps working.
    const expiry = org?.subscription_expiry ? new Date(org.subscription_expiry) : null;
    const notLapsed = !org?.subscription_expiry || (expiry && !Number.isNaN(expiry.getTime()) && expiry > new Date());
    const quota =
      org?.subscription_status === "active" && !!notLapsed && !isFreePlan(org)
        ? Number(org?.quota ?? 0)
        : 0;
    const isActive = quota > 0;

    // Ensure today's usage bucket exists (created on first request of the day).
    await connection.query(
      `INSERT INTO daily_request_usage (organization_id, date, requests_used, total_requests)
       VALUES (?, ?, 0, 0)
       ON DUPLICATE KEY UPDATE id = id`,
      [orgId, today]
    );

    const [[usage]] = await connection.query(
      `SELECT requests_used, total_requests FROM daily_request_usage WHERE organization_id=? AND date=? FOR UPDATE`,
      [orgId, today]
    );
    const used = Number(usage?.requests_used ?? 0);
    const totalRequests = Number(usage?.total_requests ?? 0);

    if (isActive) {
      // No free request. Every request consumes a paid slot up to the plan quota.
      if (used < quota) {
        await connection.query(
          `UPDATE daily_request_usage SET requests_used = requests_used + 1, total_requests = total_requests + 1
           WHERE organization_id=? AND date=?`,
          [orgId, today]
        );
        if (ownsTransaction) await connection.commit();
        return { allowed: true, is_free: false, requests_used: used + 1, total_requests: totalRequests + 1, quota, remaining: quota - used - 1 };
      }
      return reject(
        new ApiError(429, "You have used all your requests for today. Please upgrade your plan or try again tomorrow.")
      );
    }

    // No active subscription -> only the 1 FREE request per day.
    if (totalRequests === 0) {
      await connection.query(
        `UPDATE daily_request_usage SET total_requests = 1
         WHERE organization_id=? AND date=?`,
        [orgId, today]
      );
      if (ownsTransaction) await connection.commit();
      return { allowed: true, is_free: true, requests_used: 0, total_requests: 1, quota: 0, remaining: 0 };
    }

    return reject(new ApiError(429, "Daily free request used. Upgrade your plan or wait until tomorrow."));
  } catch (error) {
    if (ownsTransaction) await connection.rollback();
    throw error;
  } finally {
    if (ownsTransaction) connection.release();
  }
}
