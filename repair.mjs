import dotenv from "dotenv";
dotenv.config();
import mysql from "mysql2/promise";
import crypto from "crypto";
import { getFreePlan } from "./src/utils/subscriptionPlans.js";

const c = await mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: Number(process.env.DB_PORT || 3306),
  connectTimeout: 10000,
});

const freePlan = await getFreePlan(c);
console.log("canonical Free plan (dynamic lookup):", freePlan.id, freePlan.name);

const [before] = await c.query(`
  SELECT o.id, o.uuid, o.name, o.subscription_status, o.subscription_plan_id
  FROM organizations o WHERE o.deleted_at IS NULL ORDER BY o.id`);
console.log("\nBEFORE:");
console.table(before);

await c.beginTransaction();
try {
  for (const org of before) {
    const [r] = await c.query(
      `UPDATE organizations
       SET subscription_status='active', subscription_plan_id=?, subscription_expiry=NULL,
           subscription_start=COALESCE(subscription_start, created_at), pending_plan_id=NULL,
           reminder_2d_sent='no', reminder_2h_sent='no'
       WHERE id=? AND deleted_at IS NULL
         AND (subscription_plan_id IS NULL OR subscription_status <> 'active' OR pending_plan_id IS NOT NULL)`,
      [freePlan.id, org.id]
    );
    if (r.affectedRows) {
      const details = {
        from_status: org.subscription_status,
        from_plan_id: org.subscription_plan_id,
        to_plan: freePlan.name,
        to_plan_id: freePlan.id,
        reason: "manual_repair_planless_or_inactive_org",
      };
      await c.query(
        `INSERT INTO audit_logs (uuid, actor_type, actor_id, actor_name, actor_role, action, entity_type, entity_id, details, ip_address, created_at)
         VALUES (?, 'system', 'repair', 'Manual DB repair', 'system_admin', 'subscription.integrity_repaired', 'organization', ?, ?, '127.0.0.1', NOW())`,
        [
          crypto.randomUUID(),
          org.uuid,
          JSON.stringify(details),
        ]
      );
      console.log(`  repaired org ${org.id} (${org.name}): ${org.subscription_status}/plan=${org.subscription_plan_id} -> active/${freePlan.name}`);
    }
  }
  await c.commit();
} catch (e) {
  await c.rollback();
  throw e;
}

const [after] = await c.query(`
  SELECT o.id, o.name, o.subscription_status, sp.name AS plan, sp.is_free, o.subscription_expiry
  FROM organizations o LEFT JOIN subscription_plans sp ON sp.id=o.subscription_plan_id
  WHERE o.deleted_at IS NULL ORDER BY o.id`);
console.log("\nAFTER:");
console.table(after);

const [sum] = await c.query(`
  SELECT COUNT(*) AS total,
         SUM(subscription_plan_id IS NULL) AS null_plan,
         SUM(subscription_status <> 'active') AS not_active,
         SUM(pending_plan_id IS NOT NULL) AS has_pending
  FROM organizations WHERE deleted_at IS NULL`);
console.log("summary:", sum[0]);

const [al] = await c.query(
  "SELECT id, action, entity_id, details, created_at FROM audit_logs WHERE action='subscription.integrity_repaired' ORDER BY id DESC LIMIT 5");
console.log("\naudit trail written:");
console.table(al);

await c.end();
