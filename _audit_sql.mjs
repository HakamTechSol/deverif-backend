import "dotenv/config";
import { pool } from "./src/config/db.js";

const sql = process.argv[2];
if (!sql) {
  console.error("usage: node _audit_sql.mjs '<SQL>'");
  process.exit(1);
}
const [rows] = await pool.query(sql);
console.log(JSON.stringify(rows, null, 2));
await pool.end();