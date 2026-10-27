/*
 * One-off: sweep the historical leaked test organizations out of the dev database.
 *
 * Uses the SAME mechanism the *.db.test.js suites now use (tests/helpers/dbCleanup.js),
 * so the sweep obeys the same rules: org-scoped tables discovered from
 * information_schema, FK checks suspended for the duration and restored in a finally,
 * and `users` deleted explicitly because its column is `organization`, not
 * `organization_id`.
 *
 * SELECTION IS A WHITELIST OF NAME PATTERNS, never a date range. Org 1 ("Pixel2pro
 * (Test)") and org 2 ("Pixel2pro") are real seed data - users, employees and
 * subscription checkouts - and are deliberately not matched by any pattern.
 *
 * Dry-run by default. Pass --apply to write.
 */

import mysql from "mysql2/promise";
import dotenv from "dotenv";
import { purgeTestOrgs } from "../tests/helpers/dbCleanup.js";

dotenv.config({ quiet: true });

const APPLY = process.argv.includes("--apply");
const BATCH = 150;

const PATTERNS = [
  ["ITmu%", "myAssetsLifecycle / assets uniq() helper"],
  ["ITmv%", "uniq() helper, a later run"],
  ["Start offer%", "recruitmentStartOffer suite"],
  ["Offer %", "recruitmentOfferApproval / TenantIsolation suites"],
  ["Expense %", "expensesIntegration suite"],
  ["Recruitment%", "recruitmentLifecycle suite"],
  ["Offboarding %", "offboardingLifecycle suite"],
  ["Payroll %", "payrollIntegration suite"],
  ["Hire rollback%", "recruitmentHireRollback suite"],
  ["RequireRole %", "requireRoleFeatureAccess suite"],
  ["ATS probe%", "ad-hoc recruitment probe"],
  ["DBT-%", "assets suite tag()"],
];

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: Number(process.env.DB_PORT || 3306),
  });

  try {
    const [total] = await conn.query("SELECT COUNT(*) AS n FROM organizations");
    console.log(`organizations before: ${total[0].n}\n`);

    console.log("match census:");
    for (const [pattern, origin] of PATTERNS) {
      const [rows] = await conn.query("SELECT COUNT(*) AS n FROM organizations WHERE name LIKE ?", [pattern]);
      if (Number(rows[0].n) > 0) console.log(`  ${String(rows[0].n).padStart(4)}  ${pattern.padEnd(16)} ${origin}`);
    }

    const where = PATTERNS.map(([p]) => `name LIKE '${p}'`).join(" OR ");
    const [targets] = await conn.query(`SELECT id FROM organizations WHERE ${where} ORDER BY id`);
    const ids = targets.map((r) => r.id);
    console.log(`\ntotal to sweep: ${ids.length}`);
    console.log(APPLY ? "APPLYING\n" : "DRY RUN - pass --apply to write\n");

    // Everything that would be destroyed, counted up front.
    const before = {};
    for (const t of ["users", "employees", "assets", "candidates", "job_openings", "attendance_records", "salary_records"]) {
      const col = t === "users" ? "organization" : "organization_id";
      const [rows] = await conn.query(
        `SELECT COUNT(*) AS n FROM ${t} WHERE ${col} IN (${ids.map(() => "?").join(",")})`,
        ids,
      );
      before[t] = Number(rows[0].n);
    }
    console.log("rows to be removed: " + JSON.stringify(before));

    if (!APPLY) return;

    let swept = 0;
    for (let i = 0; i < ids.length; i += BATCH) {
      const slice = ids.slice(i, i + BATCH);
      const res = await purgeTestOrgs(conn, slice);
      swept += res.orgs;
      console.log(`  batch ${Math.floor(i / BATCH) + 1}: ${res.orgs} orgs, ${res.rows} rows`);
    }
    console.log(`\norgs deleted: ${swept}`);

    const [after] = await conn.query("SELECT COUNT(*) AS n FROM organizations");
    console.log(`organizations after: ${after[0].n}`);
    console.log("preserved: " + JSON.stringify(
      (await conn.query(
        `SELECT id, name FROM organizations WHERE name NOT LIKE 'ITmu%' AND name NOT LIKE 'ITmv%'
           AND name NOT LIKE 'Start offer%' AND name NOT LIKE 'Offer %' AND name NOT LIKE 'Expense %'
           AND name NOT LIKE 'Recruitment%' AND name NOT LIKE 'Offboarding %' AND name NOT LIKE 'Payroll %'
           AND name NOT LIKE 'Hire rollback%' AND name NOT LIKE 'RequireRole %'
           AND name NOT LIKE 'ATS probe%' AND name NOT LIKE 'DBT-%'`,
      ))[0],
    ));
  } finally {
    await conn.end();
  }
}

main().catch((e) => {
  console.error("Sweep failed:", e);
  process.exit(1);
});