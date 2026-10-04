import mysql from "mysql2";

import ApiError from "../../utils/ApiError.js";
import { logAudit, getActorFromReq } from "../../utils/auditLog.js";

/**
 * Full logical database backup: schema + data, as a .sql file.
 *
 * WHAT THIS CONTAINS: every table's CREATE TABLE statement, every index, every
 * view and every row of every table —” which includes hashed user passwords, the
 * AES-encrypted CNIC values on `persons`, JWT secrets if any were ever stored,
 * and every uploaded document's metadata. A backup file is therefore a
 * credential-equivalent artifact: anyone holding it can impersonate an account.
 * Hence the controls below.
 *
 * WHY IT IS ADMIN-ONLY: mounted behind `authAdminEnv`, so a system-admin JWT is
 * required and an org user cannot reach it. Every run is written to the audit log
 * with the acting admin, because "who exported the whole database" is one of the
 * most important questions anyone can ask of a production system.
 *
 * IMPLEMENTATION NOTES
 * - Generated in Node rather than by shelling out to `mysqldump`: mysqldump is
 *   not guaranteed to be installed alongside the app, and it would put database
 *   credentials on a child process command line. The runner in migrations/ has
 *   the same constraint and probes for the binary; this endpoint deliberately
 *   has no such dependency.
 * - Streamed row by row, never materialised as one string. A large table would
 *   otherwise have to fit in memory twice (driver buffer + string) before a byte
 *   is sent.
 * - `SELECT *` is escaped per value (not per row) because the row shape comes
 *   from the driver, not from user input, and the values may be objects/JSON.
 */

function timestampSlug(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

/**
 * Escape one value into a MySQL literal.
 *
 * Exported so the escaping can be tested directly rather than re-implemented in
 * a test (a test that copies the rules proves only that the copy is consistent
 * with itself). A dump that cannot be replayed is the failure mode this whole
 * endpoint exists to avoid, so the rules are pinned here:
 *
 * - binary/buffer columns become hex literals (`X'..'`) so a BLOB round-trips
 *   byte-for-byte instead of being mangled by charset conversion;
 * - JSON columns, which mysql2 hands back already parsed, are re-stringified so
 *   the dump carries the document rather than [object Object];
 * - quotes, backslashes, newlines, tabs, NUL and other control characters are
 *   escaped; everything else (including emoji and Urdu text) passes through as
 *   UTF-8.
 */
export function sqlValue(value) {
  if (value === null || value === undefined) return "NULL";

  if (Buffer.isBuffer(value)) return `X'${value.toString("hex")}'`;

  if (value instanceof Date) {
    // Rendered unquoted-safe: a DATE/DATETIME literal.
    return `'${value.toISOString().slice(0, 19).replace("T", " ")}'`;
  }

  if (typeof value === "boolean") return value ? "1" : "0";

  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";

  if (typeof value === "object") {
    // JSON columns come back parsed by mysql2; re-stringify so the dump carries
    // the document rather than [object Object].
    return sqlString(JSON.stringify(value));
  }

  return sqlString(String(value));
}

function sqlString(value) {
  let out = "'";
  for (const ch of value) {
    const code = ch.codePointAt(0);
    switch (ch) {
      case "\0":
        out += "\\0";
        break;
      case "\b":
        out += "\\b";
        break;
      case "\n":
        out += "\\n";
        break;
      case "\r":
        out += "\\r";
        break;
      case "\t":
        out += "\\t";
        break;
      case "\x1a":
        out += "\\Z";
        break;
      case "'":
        out += "\\'";
        break;
      case '"':
        out += '\\"';
        break;
      case "\\":
        out += "\\\\";
        break;
      default:
        // Escape control characters and NUL-ish code points; everything else,
        // including emoji and Urdu text, passes through as UTF-8.
        if (code < 0x20 || code === 0x7f) {
          out += `\\x${code.toString(16).padStart(2, "0")}`;
        } else {
          out += ch;
        }
    }
  }
  return out + "'";
}

function columnList(columns) {
  // information_schema.COLUMNS returns COLUMN_NAME; SHOW COLUMNS returns Field.
  // This reads COLUMN_NAME, which is what the query below actually selects.
  return columns.map((c) => `\`${c.COLUMN_NAME}\``).join(", ");
}

function write(res, chunk) {
  return res.write(chunk);
}

export async function downloadDatabaseBackup(req, res) {
  const database = process.env.DB_NAME;
  if (!database) {
    throw new ApiError(500, "DB_NAME is not configured");
  }

  const startedAt = new Date();
  const filename = `dverif-backup-${database}-${timestampSlug(startedAt)}.sql`;

  let connection;
  let tableCount = 0;
  let rowCount = 0;

  // The CALLBACK connection, not mysql2/promise: only the callback API returns a
  // Query object that is async-iterable, and streaming row by row is the whole
  // point —” a promise connection would buffer every row of a table in memory
  // before the first byte of the dump is written. The few metadata reads are
  // promisified individually by `q()` below.
  try {
    connection = await new Promise((resolve, reject) => {
      const c = mysql.createConnection({
        host: process.env.DB_HOST || "localhost",
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database,
        port: Number(process.env.DB_PORT || 3306),
        connectTimeout: 10000,
        // Multi-statement is deliberately OFF: nothing here executes SQL, it
        // only reads it. Keeping it off means a crafted table name can never
        // turn a dump into an execution.
        multipleStatements: false,
      });
      c.once("error", reject);
      c.connect((err) => (err ? reject(err) : resolve(c)));
    });
  } catch (error) {
    throw new ApiError(503, `Could not connect to the database: ${error.message}`);
  }

  /** Promisified query, for the small metadata reads only. */
  const q = (sql, params) =>
    new Promise((resolve, reject) =>
      connection.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
    );

  // Headers go out before the first byte so a failure mid-dump cannot leave a
  // half-written file that looks complete to whoever saved it.
  res.setHeader("Content-Type", "application/sql; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");

  try {
    write(
      res,
      `-- Dverif database backup\n` +
        `-- Database: ${database}\n` +
        `-- Generated: ${startedAt.toISOString()}\n` +
        `-- Generated by: ${req.admin?.email || "unknown"} (system admin)\n` +
        `-- Contains FULL DATA including credentials and encrypted personal data. Treat as secret.\n` +
        `--\n` +
        `-- Restore with:  mysql -u <user> -p <database> < this-file.sql\n\n` +
        `SET NAMES utf8mb4;\n` +
        `SET FOREIGN_KEY_CHECKS = 0;\n` +
        `SET SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';\n\n`
    );

    const tables = await q(
      `SELECT TABLE_NAME AS name, TABLE_TYPE AS type
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ?
        ORDER BY TABLE_NAME ASC`,
      [database]
    );

    const baseTables = tables.filter((t) => t.type === "BASE TABLE");
    const views = tables.filter((t) => t.type === "VIEW");

    for (const view of views) {
      const createRows = await q(`SHOW CREATE VIEW \`${view.name.replace(/`/g, "``")}\``);
      const ddl = createRows?.[0]?.["Create View"];
      if (ddl) {
        write(res, `-- View: ${view.name}\nDROP VIEW IF EXISTS \`${view.name.replace(/`/g, "``")}\`;\n${ddl};\n\n`);
      }
    }

    for (const table of baseTables) {
      const safeName = table.name.replace(/`/g, "``");

      const createRows = await q(`SHOW CREATE TABLE \`${safeName}\``);
      const ddl = createRows?.[0]?.["Create Table"];
      if (!ddl) continue;
      write(res, `-- Table: ${table.name}\nDROP TABLE IF EXISTS \`${safeName}\`;\n${ddl};\n\n`);

      const columns = await q(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
        [database, table.name]
      );
      if (!columns.length) continue;

      const cols = columnList(columns);

      // Streamed row by row through mysql2's Query.stream().
      //
      // Why not LIMIT/OFFSET paging: the server re-scans the skipped rows on
      // every page, so a large table would be read O(n^2) times in total. Why not
      // a plain query(): the callback API hands back a Query whose rows all
      // arrive together, so a big table would have to fit in memory before a
      // single byte of the dump is written. (A `for await` over the Query would
      // be ideal, but mysql2 3.17 does not make Query async-iterable — only
      // .stream() exists — hence the event API below.)
      try {
        await new Promise((resolve, reject) => {
          let pending = [];

          // Returns false when the socket is congested and the caller should wait
          // for 'drain' before reading more.
          const emit = () => {
            if (!pending.length) return true;
            const flushed = res.write(
              `INSERT INTO \`${safeName}\` (${cols}) VALUES\n${pending.join(",\n")};\n`
            );
            pending = [];
            return flushed;
          };

          const stream = connection.query(`SELECT ${cols} FROM \`${safeName}\``).stream({
            highWaterMark: 500,
          });

          stream.on("data", (row) => {
            pending.push(`(${Object.values(row).map(sqlValue).join(",")})`);
            rowCount += 1;
            // One INSERT per ~200 rows keeps statements a sane size and this
            // process's memory flat regardless of how big the table is.
            if (pending.length >= 200) {
              if (!emit()) {
                stream.pause();
                res.once("drain", () => stream.resume());
              }
            }
          });
          stream.on("end", () => {
            emit();
            resolve();
          });
          stream.on("error", reject);
        });
      } catch (error) {
        // One unreadable table must not abort the whole backup: note it and keep
        // going, so the operator still gets everything else plus a record of the
        // gap. Anything already written stays valid.
        write(
          res,
          `-- WARNING: could not read data from \`${safeName}\`: ${String(error.message).replace(/\n/g, " ")}\n\n`
        );
      }
      write(res, "\n");
      tableCount += 1;
    }

    write(res, `SET FOREIGN_KEY_CHECKS = 1;\n`);

    const finishedAt = new Date();
    logAudit({
      ...getActorFromReq(req),
      action: "database.backup",
      entityType: "database",
      entityId: database,
      details: {
        filename,
        tables: tableCount,
        views: views.length,
        rows: rowCount,
        duration_ms: finishedAt.getTime() - startedAt.getTime(),
      },
      req,
    });

    console.log(
      `[db-backup] ${req.admin?.email} exported ${database}: ${tableCount} tables, ` +
        `${views.length} views, ${rowCount} rows in ${finishedAt.getTime() - startedAt.getTime()}ms -> ${filename}`
    );

    res.end();
  } catch (error) {
    console.error("[db-backup] dump failed:", error.message);
    // Headers are already sent, so a JSON error body is no longer possible.
    // End the response and make the truncation explicit in what was written.
    if (!res.headersSent) {
      throw new ApiError(500, `Database backup failed: ${error.message}`);
    }
    if (!res.writableEnded) {
      res.write(`\n-- BACKUP FAILED: ${String(error.message).replace(/\n/g, " ")}\n`);
      res.end();
    }
  } finally {
    if (connection) {
      await connection.end().catch(() => {});
    }
  }
}
