/*
 * Reconcile `schema_migrations` checksums for files that were EDITED AFTER BEING APPLIED.
 *
 * ================================ WHY THIS EXISTS ================================
 *
 * run.mjs records md5(file contents) and refuses to run a file whose checksum has
 * changed since it was applied:
 *
 *     Changed migration "X" (checksum differs) - skipping to avoid a destructive re-run.
 *
 * That guard is right - it stops a re-run of a bare `ALTER TABLE ... ADD COLUMN` from
 * dying on a duplicate column. But it means an edit made to a file AFTER it shipped
 * locks that file out forever: the guard can never tell the difference between
 *
 *   (a) a documentation-only change - comments, formatting - where the applied schema
 *       already matches the file exactly, and skipping is correct; and
 *   (b) a genuine change that was never applied, where skipping means a piece of schema
 *       silently never lands.
 *
 * This tool resolves that by RECHECKING THE LEDGER ONLY. It never applies DDL.
 *
 * ================================ WHAT IT WILL NOT DO ================================
 *
 * It will not guess. Files must be named explicitly on the command line, and the tool
 * prints the drift it found for each so a human can decide. There is deliberately no
 * "--all" or auto-discovery mode: a blanket bless of every drifted file would make case
 * (b) indistinguishable from case (a) and would hide a migration that never ran.
 *
 * Usage:
 *   node migrations/reconcile_checksums.mjs 20261107_payroll_auto_computation.sql
 *   node migrations/reconcile_checksums.mjs --check 20261107_payroll_auto_computation.sql
 *
 * --check reports without writing.
 *
 * SAFETY NOTE. Re-recording a checksum asserts "the schema in this database already
 * matches this file's content". Only run it after verifying that yourself - for each
 * file, confirm every object it creates exists in the live schema with the definition
 * the file specifies. run.mjs cannot make that judgement, and neither can this script.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import mysql from "mysql2/promise";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

function md5(content) {
  return crypto.createHash("md5").update(content).digest("hex");
}

async function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes("--check");
  const files = args.filter((a) => !a.startsWith("--"));

  if (!files.length) {
    console.error(
      "Usage: node migrations/reconcile_checksums.mjs [--check] <file.sql> [more.sql ...]\n" +
        "No files were named, so nothing would be touched by design. Name each file explicitly.",
    );
    process.exit(1);
  }

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: Number(process.env.DB_PORT || 3306),
  });

  try {
    const [recorded] = await conn.query("SELECT filename, checksum FROM schema_migrations");
    const ledger = new Map(recorded.map((r) => [r.filename, r.checksum]));

    let drifted = 0;
    let fixed = 0;

    for (const name of files) {
      const full = path.join(__dirname, name);
      if (!fs.existsSync(full)) {
        console.error(`  SKIP  ${name} - not on disk`);
        continue;
      }
      if (!ledger.has(name)) {
        console.error(`  SKIP  ${name} - not in schema_migrations (it has never been applied;`);
        console.error(`        running it is the correct action, not reconciling a checksum)`);
        continue;
      }

      const onDisk = md5(fs.readFileSync(full, "utf8"));
      const inLedger = ledger.get(name);

      if (onDisk === inLedger) {
        console.log(`  OK    ${name} - checksum already matches`);
        continue;
      }

      drifted += 1;
      console.log(`  DRIFT ${name}`);
      console.log(`          recorded: ${inLedger}`);
      console.log(`          on disk:   ${onDisk}`);

      if (checkOnly) continue;

      // UPDATE, not INSERT: the unique key is on filename, and the row already exists.
      await conn.query("UPDATE schema_migrations SET checksum=? WHERE filename=?", [onDisk, name]);
      console.log(`          -> ledger updated`);
      fixed += 1;
    }

    console.log(
      `\n${drifted} drifted, ${checkOnly ? "0 written (--check)" : fixed} written.`,
    );
    if (drifted && !checkOnly) {
      console.log(
        "Verify before trusting this: confirm every object these files create already\n" +
          "exists in the database with the definition the file specifies.",
      );
    }
  } finally {
    await conn.end();
  }
}

main().catch((e) => {
  console.error("Checksum reconciliation failed:", e);
  process.exit(1);
});