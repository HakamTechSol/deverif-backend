import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Guards SQL column references against the real schema.
 *
 * The rest of the backend suite mocks `pool.query`, which returns rows for ANY
 * string it is handed. Invalid SQL therefore looked identical to valid SQL, and
 * a query selecting a non-existent column passed CI while returning
 * ER_BAD_FIELD_ERROR -> HTTP 500 in the running app. That is exactly how
 * `SELECT uuid, full_name, designation FROM employees` shipped: `employees` has
 * `designation_id` and the NAME lives in `designations`, so every /my-letters
 * route 500'd while 1093 tests were green.
 *
 * A mock cannot catch a schema mistake. This can: it reads the migrations, so
 * the expected schema is the same one the database was built from.
 */

const ROOT = process.cwd();
const MIGRATIONS = join(ROOT, "migrations");

/**
 * Column names per table, derived by REPLAYING the migrations in order.
 *
 * Replaying matters: reading only CREATE TABLE gives the wrong answer. The
 * employees table was created with `designation VARCHAR(100)`, then
 * 20260913 added `designation_id` and dropped `designation`. Validating against
 * the CREATE TABLE alone would have reported the live schema as still having
 * `designation` — the exact inverse of the bug this file exists to catch.
 */
function schemaFromMigrations() {
  const tables = new Map();

  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort(); // chronological: the date prefix is sortable

  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS, file), "utf8");

    // CREATE TABLE name ( ... ) [ENGINE=...] [;]
    // The trailing ENGINE/CHARSET clause must be tolerated: these files close
    // with ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;", not a bare ")".
    const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?\s*\(([\s\S]*?)\n\)\s*[^;]*;/gi;
    let m;
    while ((m = re.exec(sql))) {
      const [, table, body] = m;
      tables.set(table.toLowerCase(), columnsFromBlock(body));
    }

    // ADD COLUMN [IF NOT EXISTS] `name` TYPE
    const addRe = /ALTER\s+TABLE\s+`?(\w+)`?\s+ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?\s+(?:BIGINT|INT|TINYINT|VARCHAR|CHAR|TEXT|LONGTEXT|DATETIME|TIMESTAMP|DATE|TIME|DECIMAL|BOOLEAN|JSON|ENUM|BLOB|LONGBLOB)/gi;
    while ((m = addRe.exec(sql))) {
      const [, table, col] = m;
      if (!tables.has(table.toLowerCase())) continue;
      tables.get(table.toLowerCase()).add(col.toLowerCase());
    }

    // DROP COLUMN `name`  (possibly several in one statement)
    const dropRe = /ALTER\s+TABLE\s+`?(\w+)`?\s+DROP\s+(?:COLUMN\s+)?`?(\w+)`?/gi;
    while ((m = dropRe.exec(sql))) {
      const [, table, col] = m;
      tables.get(table.toLowerCase())?.delete(col.toLowerCase());
    }
  }
  return tables;
}

/** Column names from the inside of a CREATE TABLE body. */
function columnsFromBlock(body) {
  const cols = new Set();
  for (const line of body.split("\n")) {
    // A column line is an identifier followed by a type. Skip constraint
    // keywords that can also begin a line.
    const c = line.match(
      /^\s*`?(\w+)`?\s+(?:BIGINT|INT|TINYINT|VARCHAR|CHAR|TEXT|LONGTEXT|DATETIME|TIMESTAMP|DATE|TIME|DECIMAL|BOOLEAN|JSON|ENUM|BLOB|LONGBLOB)/i,
    );
    if (c) cols.add(c[1].toLowerCase());
  }
  return cols;
}

const SCHEMA = schemaFromMigrations();

/**
 * Pull "SELECT <list> FROM <table>" out of a source file.
 *
 * Only SINGLE-table selects are returned. A JOIN's columns belong to the joined
 * table, and attributing them to the FROM table would report every aliased
 * column as missing — a guard that cries wolf gets deleted, so it stays silent
 * where it cannot be accurate.
 */
function selectsIn(source) {
  const found = [];
  const re = /SELECT\s+([\s\S]*?)\s+FROM\s+`?(\w+)`?/gi;
  let m;
  while ((m = re.exec(source))) {
    const [, list, table] = m;

    // Look ahead to the end of this template literal / statement for a JOIN.
    // Start AFTER the FROM clause: the opening backtick of the SQL literal sits
    // immediately before SELECT, so scanning from m.index would match it and
    // cut the scope off before any JOIN.
    const after = source.slice(m.index + m[0].length, m.index + m[0].length + 900);
    const end = after.search(/`|\$\{/);
    const scope = end > 0 ? after.slice(0, end) : after;
    if (/\bJOIN\b/i.test(scope)) continue;

    const cols = list
      .split(",")
      .map((c) => c.trim())
      // "e.uuid AS employee_uuid" -> uuid
      .map((c) => c.replace(/^\w+\./, "").split(/\s+AS\s+/i)[0].trim())
      .map((c) => c.replace(/[`]/g, ""))
      // Skip expressions: COUNT(*), COALESCE(...), literals.
      .filter((c) => /^\w+$/.test(c) && !/^\d+$/.test(c))
      .map((c) => c.toLowerCase());

    found.push({ table: table.toLowerCase(), cols, snippet: list.trim().slice(0, 120) });
  }
  return found;
}

const FILES = [
  "src/controllers/myLetters.controller.js",
  "src/services/hrLetters.service.js",
];

describe("SQL references real columns", () => {
  it("the migrations expose a parseable schema", () => {
    // If this fails the guard below is silently vacuous, which is worse than
    // having no guard at all.
    expect(SCHEMA.size).toBeGreaterThan(5);
    expect(SCHEMA.get("employees")?.has("designation_id")).toBe(true);
    // The bug: employees has no bare `designation` column.
    expect(SCHEMA.get("employees")?.has("designation")).toBe(false);
  });

  for (const file of FILES) {
    it(`${file} only selects columns that exist`, () => {
      const selects = selectsIn(readFileSync(join(ROOT, file), "utf8"));
      expect(selects.length).toBeGreaterThan(0);

      const problems = [];
      for (const { table, cols, snippet } of selects) {
        const known = SCHEMA.get(table);
        if (!known) continue; // table not in migrations; another suite covers it
        for (const col of cols) {
          if (!known.has(col)) {
            problems.push(`${table}.${col}  (in: ${snippet})`);
          }
        }
      }
      expect(problems, `Columns that do not exist:\n  ${problems.join("\n  ")}`).toEqual([]);
    });
  }
});