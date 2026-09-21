import "dotenv/config";
import { pool } from "./src/config/db.js";

await pool.query(
  "ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS is_recommended TINYINT(1) NOT NULL DEFAULT 0 AFTER is_free"
);
const [cols] = await pool.query("SHOW COLUMNS FROM subscription_plans");
console.log(cols.map((x) => `${x.Field}(${x.Type})`).join(", "));
await pool.end();