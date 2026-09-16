import { pool } from "./src/config/db.js";

const [rows] = await pool.query(
  `SELECT u.id, u.full_name, u.email, u.org_role, u.status, u.deleted_at
   FROM users u WHERE u.organization=1 ORDER BY u.id`
);
for (const r of rows) console.log(JSON.stringify(r));

process.exit(0);