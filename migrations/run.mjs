/*
 * Migration runner for the Dverif backend.
 *
 * Keeps the configured MySQL/MariaDB database in sync with the SQL files in
 * this `migrations/` folder. Every applied migration is recorded in a
 * `schema_migrations` table (keyed by file name + a checksum of its contents),
 * so only files that have NOT yet been applied are run, in sorted order.
 *
 * SQL files are applied by shelling out to the `mysql` CLI client (the same
 * tool the project has always used) so that files containing mysql-CLI
 * directives like `DELIMITER` / triggers work correctly — node's mysql2 driver
 * cannot execute those.
 *
 * Getting the mysql client:
 *   - Set MYSQL_BIN to the full path of mysql.exe (e.g. on Windows
 *     "C:\\Program Files\\MySQL\\MySQL Workbench 8.0 CE\\mysql.exe").
 *   - If unset, a few common paths are probed.
 *
 * Usage (from the `backend/` directory):
 *   node migrations/run.mjs
 *
 * Applying only specific new files on top of an existing, already-migrated DB:
 *   RUN_ONLY=20260831_create_support_tickets.sql node migrations/run.mjs
 *
 * First-run on a PRE-EXISTING database (one built by hand before this runner
 * existed, e.g. an already-working `verification_app` DB): the runner detects
 * known core tables already present and therefore marks the existing migration
 * files as "applied" without re-running them (they were applied manually), then
 * runs any brand-new files. Pass RUN_ONLY for any new files so they actually get
 * applied instead of being absorbed into the backfill.
 *
 * First-run on a FRESH, empty database: nothing exists, so every migration file
 * is applied in order to build the schema from scratch.
 *
 * The runner only ever ADDS missing schema and never drops or mutates existing
 * objects, so it is safe to run repeatedly (idempotent).
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import mysql from "mysql2/promise";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const DB = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: Number(process.env.DB_PORT || 3306),
};

function md5(content) {
  return crypto.createHash("md5").update(content).digest("hex");
}

function resolveMysqlBin() {
  if (process.env.MYSQL_BIN) return process.env.MYSQL_BIN;
  const candidates = [
    "C:\\Program Files\\MySQL\\MySQL Workbench 8.0 CE\\mysql.exe",
    "C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\mysql.exe",
    "C:\\Program Files\\MySQL\\MySQL Server 8.4\\bin\\mysql.exe",
    "C:\\xampp\\mysql\\bin\\mysql.exe",
    "C:\\laragon\\bin\\mysql\\mysql-8.0.30-winx64\\bin\\mysql.exe",
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return "mysql"; // fall back to PATH
}

function applyFile(bin, filePath) {
  const args = [
    "-h", DB.host,
    "-u", DB.user,
    "-P", String(DB.port),
    "--default-character-set=utf8mb4",
    DB.database,
  ];
  // password via env to avoid it showing in process lists
  const env = { ...process.env, MYSQL_PWD: DB.password || "" };
  const stdin = fs.readFileSync(filePath, "utf8");
  execFileSync(bin, args, { input: stdin, env, stdio: ["pipe", "inherit", "inherit"] });
}

async function main() {
  const checkConn = await mysql.createConnection({
    host: DB.host,
    user: DB.user,
    password: DB.password,
    database: DB.database,
  });
  let conn;
  try {
    conn = checkConn;

    await conn.query(`
      CREATE TABLE IF NOT EXISTS \`schema_migrations\` (
        \`id\` int(11) NOT NULL AUTO_INCREMENT,
        \`filename\` varchar(255) NOT NULL,
        \`checksum\` char(32) NOT NULL,
        \`applied_at\` datetime NOT NULL DEFAULT current_timestamp(),
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uq_schema_migrations_filename\` (\`filename\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    const files = fs
      .readdirSync(__dirname)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    if (files.length === 0) {
      console.log("No migration files found.");
      return;
    }

    const [appliedRows] = await conn.query("SELECT filename, checksum FROM schema_migrations");
    const applied = new Map(appliedRows.map((r) => [r.filename, r.checksum]));

    // Is this a pre-existing (hand-built) database rather than an empty one?
    const [usersRows] = await conn.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema=? AND table_name=?",
      [DB.database, "users"]
    );
    const preExistingDb = usersRows.length > 0;

    const runOnly = new Set(
      (process.env.RUN_ONLY || "").split(",").map((s) => s.trim()).filter(Boolean)
    );

    // Pre-existing DB + empty tracking table => treat current .sql files as the
    // historical baseline (they were applied manually) and record them, EXCEPT
    // the ones named in RUN_ONLY which are brand new and must actually run.
    if (preExistingDb && applied.size === 0) {
      let seeded = 0;
      for (const f of files) {
        const content = fs.readFileSync(path.join(__dirname, f), "utf8");
        const sum = md5(content);
        if (!applied.has(f) && !runOnly.has(f)) {
          await conn.query(
            "INSERT INTO schema_migrations (filename, checksum) VALUES (?, ?)",
            [f, sum]
          );
          applied.set(f, sum);
          seeded++;
        }
      }
      console.log(
        `Pre-existing DB detected — recorded ${seeded} existing migration(s) as already applied (${runOnly.size} file(s) marked to run via RUN_ONLY).`
      );
    }

    const bin = resolveMysqlBin();
    let ran = 0;
    for (const f of files) {
      const content = fs.readFileSync(path.join(__dirname, f), "utf8");
      const sum = md5(content);

      if (applied.has(f) && applied.get(f) === sum) continue;

      if (applied.has(f) && applied.get(f) !== sum) {
        console.warn(
          `  Changed migration "${f}" (checksum differs) — skipping to avoid a destructive re-run.`
        );
        continue;
      }

      console.log(`  Applying: ${f}`);
      applyFile(bin, path.join(__dirname, f));

      await conn.query(
        "INSERT INTO schema_migrations (filename, checksum) VALUES (?, ?)",
        [f, sum]
      );
      ran++;
    }

    console.log(`\nDone. Applied ${ran} new migration(s). ${files.length} migration(s) tracked.`);
  } finally {
    if (conn) await conn.end();
  }
}

main().catch((e) => {
  console.error("Migration failed:", e);
  process.exit(1);
});
