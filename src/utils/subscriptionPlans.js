import { pool } from "../config/db.js";
import ApiError from "./ApiError.js";

/**
 * The Free plan is a REAL row in `subscription_plans`, flagged with
 * `is_free = 1`. Every organization is always on *some* plan -- Free is simply
 * the default -- so it is looked up dynamically here and NEVER identified by a
 * hardcoded id, a name match ("Free") or a price check (`price === 0`). If the
 * Free plan is renamed or recreated with a different id, every caller keeps
 * working with no code change.
 */

/** Columns every plan read must SELECT so the plan can be compared/activated. */
export const PLAN_SELECT_COLUMNS =
  "id, uuid, name, monthly_price, daily_request_quota, billing_period, is_free, is_custom";

/**
 * Is this plan the Free plan? Purely data-driven: the `is_free` flag and
 * nothing else. Accepts both the mysql2 TINYINT (0/1) and a boolean so it is
 * safe to call with a value straight off a request body.
 */
export function isFreePlan(plan) {
  if (!plan) return false;
  return plan.is_free === 1 || plan.is_free === true || Number(plan.is_free) === 1;
}

/**
 * Read the Free plan row, or null when the table has none.
 * `executor` may be the pool or a transaction connection.
 */
export async function findFreePlan(executor = pool) {
  const [[plan]] = await executor.query(
    `SELECT ${PLAN_SELECT_COLUMNS} FROM subscription_plans WHERE is_free=1 ORDER BY id ASC LIMIT 1`
  );
  return plan || null;
}

/**
 * Read the Free plan row, throwing when it is missing.
 *
 * Every organization must be on a real plan, so "no Free plan configured" is a
 * broken-environment error rather than a state to code around: failing loudly
 * beats silently leaving organizations with a NULL subscription_plan_id.
 */
export async function getFreePlan(executor = pool) {
  const plan = await findFreePlan(executor);
  if (!plan) {
    throw new ApiError(
      500,
      "No Free plan is configured. A subscription_plans row with is_free=1 is required."
    );
  }
  return plan;
}

/**
 * Guard for the admin plan create/update paths: reject marking a plan as Free
 * when a DIFFERENT plan already holds the flag.
 *
 * The database also enforces this (see migration
 * 20260927_enforce_single_free_plan.sql, which adds a unique index over a
 * generated column). This application-level check exists so the admin gets a
 * clear 400 with the conflicting plan's name instead of a raw ER_DUP_ENTRY.
 */
export async function assertSingleFreePlan(executor, { excludePlanUuid = null } = {}) {
  const params = [];
  let sql = "SELECT id, uuid, name FROM subscription_plans WHERE is_free=1";
  if (excludePlanUuid) {
    sql += " AND uuid<>?";
    params.push(excludePlanUuid);
  }
  sql += " LIMIT 1";

  const [[other]] = await executor.query(sql, params);
  if (other) {
    throw new ApiError(
      400,
      `Another plan ("${other.name}") is already the Free plan. Only one Free plan is allowed.`
    );
  }
}
