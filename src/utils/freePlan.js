import { pool } from "../config/db.js";

/**
 * Assign the (single) Free plan to an organization: activates the subscription
 * with no expiry so the org's users get the baseline experience immediately.
 *
 * Safe to call on every org creation — no-op when no Free plan exists yet.
 * Can run against `pool` or a transaction connection (has `query`).
 */
export async function assignFreePlanToOrg(executor = pool, orgId) {
  const [[freeRow]] = await executor.query(
    "SELECT id FROM subscription_plans WHERE is_free=1 ORDER BY id ASC LIMIT 1"
  );
  if (!freeRow) return false;
  await executor.query(
    `UPDATE organizations
     SET subscription_status='active', subscription_start=NOW(), subscription_expiry=NULL,
         subscription_plan_id=?, reminder_2d_sent='no', reminder_2h_sent='no'
     WHERE id=?`,
    [freeRow.id, orgId]
  );
  return true;
}