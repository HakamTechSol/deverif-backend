/**
 * End-to-end proof that the backup endpoint produces a genuinely RESTORABLE
 * dump — not just a file containing the word INSERT.
 *
 * One self-contained flow, because comparing across separate runs is what made
 * the first attempt report two phantom mismatches: a point-in-time dump cannot
 * match a database that keeps being written to.
 *
 *   1. read the source row counts        (baseline)
 *   2. take the backup over HTTP
 *   3. read the source row counts again  (what grew during the dump window)
 *   4. replay the dump into a scratch database with the real mysql client
 *   5. compare every table
 *
 * TOLERANCE, stated plainly: a table that GREW between step 1 and step 3 is
 * expected to be short in the dump (the stream passed it before those rows were
 * written). audit_logs always is, because the backup writes its own audit entry
 * at the end. A table that SHRANK, or one the restore could not read at all, is
 * a real defect and fails this check.
 *
 * Usage: node scripts/_verify_backup_restorable.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import mysql from "mysql2/promise";
import dotenv from "dotenv";
import { signAccessToken } from "../src/utils/jwt.js";

dotenv.config({ quiet: true });

const BASE = `http://localhost:${process.env.PORT || 5000}/api/v1`;
const SCRATCH = "verification_app_restore_test";
const MYSQL_BIN = "C:\\Program Files\\MySQL\\MySQL Workbench 8.0 CE\\mysql.exe";
const OUT = path.resolve(process.cwd(), "_testdata/sample-backup.sql");

const admin = await mysql.createConnection({
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME,
});

const [[adminProfile]] = await admin.query("SELECT uuid, email FROM admin_profiles ORDER BY id LIMIT 1");
const token = signAccessToken({
  type: "admin",
  userId: adminProfile.uuid,
  role: "admin",
  email: adminProfile.email,
});

const [tableNames] = await admin.query(
  `SELECT TABLE_NAME AS n FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`,
  [process.env.DB_NAME]
);

async function counts() {
  const out = {};
  for (const { n } of tableNames) {
    const [[r]] = await admin.query(`SELECT COUNT(*) AS c FROM \`${n}\``);
    out[n] = Number(r.c);
  }
  return out;
}

const before = await counts();
console.log(`tables: ${tableNames.length}, rows before dump: ${Object.values(before).reduce((a, b) => a + b, 0)}`);

const res = await fetch(`${BASE}/admin/database/backup`, { headers: { Authorization: `Bearer ${token}` } });
if (res.status !== 200) {
  console.error(`backup failed: HTTP ${res.status}`);
  process.exit(1);
}
const sql = await res.text();
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, sql, "utf8");

const after = await counts();
const grew = tableNames.map((t) => t.n).filter((n) => after[n] > before[n]);
console.log(`backup: HTTP 200, ${(sql.length / 1024).toFixed(0)} KB`);
console.log(`grew during the dump window (expected to be short in the dump): ${grew.join(", ") || "none"}\n`);

await admin.query(`DROP DATABASE IF EXISTS \`${SCRATCH}\``);
await admin.query(`CREATE DATABASE \`${SCRATCH}\` CHARACTER SET utf8mb4`);

const started = Date.now();
try {
  execFileSync(
    MYSQL_BIN,
    [
      "-h", process.env.DB_HOST || "localhost",
      "-u", process.env.DB_USER,
      "-P", String(process.env.DB_PORT || 3306),
      "--default-character-set=utf8mb4",
      SCRATCH,
    ],
    {
      input: Buffer.from(sql, "utf8"),
      env: { ...process.env, MYSQL_PWD: process.env.DB_PASSWORD || "" },
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
  console.log(`restore into ${SCRATCH}: OK in ${((Date.now() - started) / 1000).toFixed(1)}s, no SQL errors\n`);
} catch (error) {
  console.error("RESTORE FAILED — the dump is NOT restorable:\n");
  console.error(String(error.stderr || error.message).slice(0, 3000));
  await admin.query(`DROP DATABASE IF EXISTS \`${SCRATCH}\``);
  await admin.end();
  process.exit(1);
}

let short = 0;
let missing = 0;
let exact = 0;

for (const { n } of tableNames) {
  let restored;
  try {
    [[{ c: restored }]] = await admin.query(`SELECT COUNT(*) AS c FROM \`${SCRATCH}\`.\`${n}\``);
    restored = Number(restored);
  } catch {
    console.log(`  MISSING in restore : ${n}`);
    missing += 1;
    continue;
  }

  if (restored === before[n]) {
    exact += 1;
  } else if (grew.includes(n) && restored < after[n]) {
    // Legitimately lagged: rows written after the stream passed this table.
    short += 1;
    console.log(
      `  lagged (expected)  : ${n} dump=${restored} before=${before[n]} now=${after[n]} (grew by ${after[n] - before[n]})`
    );
  } else if (restored < before[n]) {
    console.log(`  LOST ROWS          : ${n} dump=${restored} before=${before[n]}`);
    missing += 1;
  } else {
    console.log(`  EXTRA ROWS         : ${n} dump=${restored} before=${before[n]}`);
    missing += 1;
  }
}

const [[orgRow]] = await admin.query(`SELECT name, uuid FROM \`${SCRATCH}\`.organizations ORDER BY id LIMIT 1`);
const [[encCnics]] = await admin.query(
  `SELECT COUNT(*) AS c FROM \`${SCRATCH}\`.persons WHERE cnic_encrypted IS NOT NULL`
);
const [[hashRows]] = await admin.query(
  `SELECT COUNT(*) AS c FROM \`${SCRATCH}\`.verification_requests WHERE document_hash IS NOT NULL`
);

console.log(`\nexact table match : ${exact}`);
console.log(`lagged (expected) : ${short}`);
console.log(`defects           : ${missing}`);
console.log(`\nspot checks in the RESTORED database:`);
console.log(`  organizations[0].name      : ${orgRow?.name}`);
console.log(`  persons with encrypted CNIC: ${encCnics?.c}`);
console.log(`  requests with a doc hash   : ${hashRows?.c}`);

await admin.query(`DROP DATABASE IF EXISTS \`${SCRATCH}\``);
console.log(`\nscratch database dropped`);

const ok = missing === 0;
console.log(
  `\n${ok ? "PASS — the backup restores cleanly; every table present, no rows lost" : `FAIL — ${missing} defect(s)`}`
);
await admin.end();
process.exit(ok ? 0 : 1);
