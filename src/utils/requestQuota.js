import { pool } from "../config/db.js";
import ApiError from "./ApiError.js";

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
 * Resolve the current plan quota for an organization.
 * Returns { quota, plan_id, plan_uuid, plan_name }.
 */
export async function getOrgPlan(orgId) {
  const [[row]] = await pool.query(
    `SELECT o.subscription_plan_id AS plan_id,
            o.subscription_status AS subscription_status,
            sp.uuid AS plan_uuid, sp.name AS plan_name, sp.daily_request_quota AS quota
     FROM organizations o
     LEFT JOIN subscription_plans sp ON sp.id = o.subscription_plan_id
     WHERE o.id = ?`,
    [orgId]
  );
  // Paid quota only applies while the subscription is ACTIVE. Orgs without an
  // active subscription still get the 1 FREE request/day (quota resolved to 0).
  const isActive = row?.subscription_status === "active";
  return {
    quota: isActive ? Number(row?.quota ?? 0) : 0,
    plan_id: row?.plan_id ?? null,
    plan_uuid: row?.plan_uuid ?? null,
    plan_name: row?.plan_name ?? null,
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
  const totalAllowance = FREE_DAILY_REQUESTS + plan.quota;
  return {
    date: today,
    free_daily_requests: FREE_DAILY_REQUESTS,
    plan_quota: plan.quota,
    total_allowance: totalAllowance,
    requests_used: used,          // paid requests consumed today
    total_requests: totalRequests,
    requests_remaining: Math.max(0, plan.quota - used),
    plan: {
      uuid: plan.plan_uuid,
      name: plan.plan_name,
      daily_request_quota: plan.quota,
    },
  };
}

/**
 * Enforce the daily request quota for an organization and, if allowed,
 * atomically consume one PAID quota slot (the very first request of the day is
 * always the FREE request and does not consume a slot).
 *
 * Throw ApiError(429, ...) with a clear message when the limit is reached.
 * Returns { is_free, requests_used, quota, allowed }.
 */
export async function enforceRequestQuota(orgId) {
  const today = todayStr();
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // Lock the organization row + its plan.
    const [[org]] = await connection.query(
      `SELECT o.subscription_status AS subscription_status,
              sp.daily_request_quota AS quota
       FROM organizations o
       LEFT JOIN subscription_plans sp ON sp.id = o.subscription_plan_id
       WHERE o.id = ?
       FOR UPDATE`,
      [orgId]
    );
    // Paid quota applies only while the subscription is ACTIVE; otherwise the
    // org still gets its 1 FREE request/day (quota = 0).
    const quota = org?.subscription_status === "active" ? Number(org?.quota ?? 0) : 0;

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

    // Very first request of the day -> always allowed (FREE), no quota consumed.
    if (totalRequests === 0) {
      await connection.query(
        `UPDATE daily_request_usage SET total_requests = 1
         WHERE organization_id=? AND date=?`,
        [orgId, today]
      );
      await connection.commit();
      return { allowed: true, is_free: true, requests_used: 0, total_requests: 1, quota, remaining: quota };
    }

    // Subsequent request -> consume a PAID slot up to the plan's daily quota.
    if (used < quota) {
      await connection.query(
        `UPDATE daily_request_usage SET requests_used = requests_used + 1, total_requests = total_requests + 1
         WHERE organization_id=? AND date=?`,
        [orgId, today]
      );
      await connection.commit();
      return { allowed: true, is_free: false, requests_used: used + 1, total_requests: totalRequests + 1, quota, remaining: quota - used - 1 };
    }

    await connection.rollback();
    // For orgs with no paid quota (inactive/no subscription), the limit reached
    // means their 1 FREE daily request is already used — give a clear message.
    const message = quota === 0
      ? "Daily free request used. Upgrade your plan or wait until tomorrow."
      : "You have used all your requests for today. Please upgrade your plan or try again tomorrow.";
    throw new ApiError(429, message);
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
