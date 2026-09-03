import mysql from "mysql2/promise";
import "dotenv/config";

const conn = await mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: Number(process.env.DB_PORT || 3306),
});

const [checkouts] = await conn.query(
  "SELECT uuid, organization_id, plan_name, amount, currency, status, gateway_tracker_id, created_at, completed_at, failed_at FROM subscription_checkouts ORDER BY created_at DESC LIMIT 5"
);
console.log("=== recent subscription_checkouts ===");
for (const r of checkouts) console.log(JSON.stringify(r));

const [pays] = await conn.query(
  "SELECT * FROM payments ORDER BY id DESC LIMIT 5"
);
console.log("\n=== recent payments ===");
console.log("count:", pays.length);
for (const r of pays) {
  r.transaction_reference = r.transaction_reference?.slice(0, 40);
  console.log(JSON.stringify(r));
}

await conn.end();