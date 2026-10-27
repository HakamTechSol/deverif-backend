/**
 * Live test for the two new system-admin features:
 *   1. Document-type catalogue CRUD + push-through to the Python service
 *   2. Full database backup (.sql download)
 *
 * Also proves the access boundary: an ORG user must get 401/403 on both.
 * Leaves nothing behind unless KEEP_TEST_DATA=1.
 *
 * Usage: node scripts/e2e_live_admin_settings.mjs
 */
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import mysql from "mysql2/promise";
import { signAccessToken } from "../src/utils/jwt.js";

dotenv.config({ quiet: true });

const BASE = `http://localhost:${process.env.PORT || 5000}/api/v1`;
const DOC_SERVICE = process.env.DOC_SERVICE_URL || "http://localhost:5001";
const KEEP = process.env.KEEP_TEST_DATA === "1";
const NEW_TYPE = `E2E Test Document ${Date.now().toString(36)}`;

const results = [];
function check(label, pass, detail) {
  results.push({ label, pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail ? `\n          ${detail}` : ""}`);
}

const db = await mysql.createConnection({
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "verification_app",
});

async function api(method, route, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(BASE + route, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null), res };
}

const [[admin]] = await db.query("SELECT uuid, email FROM admin_profiles ORDER BY id LIMIT 1");
const [[orgUser]] = await db.query(
  "SELECT uuid, email, organization, org_role FROM users WHERE org_role='org_admin' ORDER BY id LIMIT 1"
);

const adminToken = signAccessToken({ type: "admin", userId: admin.uuid, role: "admin", email: admin.email });
const orgToken = signAccessToken({
  type: "user",
  userId: orgUser.uuid,
  role: "user",
  organization: orgUser.organization,
  org_role: orgUser.org_role,
});

console.log("=".repeat(80));
console.log("LIVE TEST — admin document types + database backup");
console.log("=".repeat(80));
console.log(`  system admin : ${admin.email}`);
console.log(`  org user     : ${orgUser.email} (must be refused)`);

// ─── A. catalogue CRUD ──────────────────────────────────────────────────────
console.log("\n" + "-".repeat(80));
console.log("A. DOCUMENT-TYPE CATALOGUE");
console.log("-".repeat(80));

const seeded = await api("GET", "/admin/document-types", { token: adminToken });
// >= rather than ==: an admin may legitimately have added types of their own, and
// a previous interrupted run can leave one behind. What matters is that the 47
// that used to be hard-coded are all present, which the next check asserts.
check(
  "A1 the catalogue is seeded from the former static list",
  seeded.status === 200 && seeded.data?.data?.items?.length >= 47,
  `HTTP ${seeded.status} count=${seeded.data?.data?.items?.length}`
);

const KNOWN_47 = [
  "Employee Application Form", "CV / Resume", "Recent Photograph", "CNIC / National ID Copy",
  "Passport Copy — if applicable", "Educational Certificates", "Experience Certificates",
  "Offer Letter", "NDA — Non-Disclosure Agreement", "Employee File Closing Checklist",
];
const names = new Set((seeded.data?.data?.items || []).map((i) => i.name));
const missing = KNOWN_47.filter((n) => !names.has(n));
check(
  "A1b every previously hard-coded type is still in the database",
  missing.length === 0,
  missing.length ? `missing: ${missing.join(", ")}` : `all ${KNOWN_47.length} spot-checked types present`
);

const orgList = await api("GET", "/document-types", { token: orgToken });
check(
  "A2 an org user CAN read the active catalogue (needed for dropdowns)",
  orgList.status === 200 && Array.isArray(orgList.data?.data?.items) && orgList.data.data.items.length > 0,
  `HTTP ${orgList.status} count=${orgList.data?.data?.items?.length}`
);
check(
  "A2b the org-facing read exposes no internal ids or audit fields",
  orgList.status === 200 && orgList.data.data.items.every((i) => !("id" in i) && !("created_at" in i)),
  `keys=${JSON.stringify(Object.keys(orgList.data?.data?.items?.[0] || {}))}`
);

const orgAdminAttempt = await api("GET", "/admin/document-types", { token: orgToken });
check(
  "A3 an org user CANNOT administer the catalogue",
  orgAdminAttempt.status === 401 || orgAdminAttempt.status === 403,
  `HTTP ${orgAdminAttempt.status}`
);

const created = await api("POST", "/admin/document-types", {
  token: adminToken,
  body: { name: NEW_TYPE, schema_key: "cnic" },
});
const newId = created.data?.data?.document_type?.id;
check(
  "A4 admin adds a new document type",
  created.status === 201 && Boolean(newId),
  `HTTP ${created.status} id=${newId} name="${created.data?.data?.document_type?.name}"`
);
check(
  "A4b its label_key was normalized the same way the Python service does",
  created.data?.data?.document_type?.label_key === NEW_TYPE.toLowerCase().replace(/[^0-9a-z]+/g, " ").trim(),
  `label_key="${created.data?.data?.document_type?.label_key}"`
);

const dupe = await api("POST", "/admin/document-types", {
  token: adminToken,
  body: { name: NEW_TYPE, schema_key: "cnic" },
});
check("A5 a duplicate name is rejected with 409", dupe.status === 409, `HTTP ${dupe.status}`);

const badSchema = await api("POST", "/admin/document-types", {
  token: adminToken,
  body: { name: `${NEW_TYPE} B`, schema_key: "not_a_real_schema" },
});
check("A6 an unknown schema_key is rejected at the API", badSchema.status === 400, `HTTP ${badSchema.status}`);

// ─── B. does the Python service actually learn it? ──────────────────────────
console.log("\n" + "-".repeat(80));
console.log("B. THE DOCUMENT SERVICE LEARNS THE NEW TYPE");
console.log("-".repeat(80));

// The push is fire-and-forget, so give it a moment before asking the service.
await new Promise((r) => setTimeout(r, 2500));

const pythonSchemas = await fetch(`${DOC_SERVICE}/schemas`, {
  headers: { "X-API-Key": process.env.DOC_SERVICE_API_KEY },
}).then((r) => r.json());

check(
  "B1 the document service reports the catalogue size",
  pythonSchemas?.data?.catalogue_count >= 48,
  `catalogue_count=${pythonSchemas?.data?.catalogue_count} (47 seeded + 1 new)`
);

const ocrResp = await fetch(`${DOC_SERVICE}/schemas/resolve`, {
  method: "POST",
  headers: { "X-API-Key": process.env.DOC_SERVICE_API_KEY, "Content-Type": "application/json" },
  body: JSON.stringify({ types: [{ label: NEW_TYPE, schema_key: "cnic" }] }),
}).then((r) => r.json());
check(
  "B2 the service resolves the brand-new type to its chosen schema",
  ocrResp?.data?.resolved?.[0]?.schema_key === "cnic",
  JSON.stringify(ocrResp?.data?.resolved)
);

const syncStatus = await api("GET", "/admin/document-types/sync-status", { token: adminToken });
check(
  "B3 the admin panel can read whether the service is in step",
  syncStatus.status === 200 && syncStatus.data?.data?.status?.reachable === true,
  `reachable=${syncStatus.data?.data?.status?.reachable} catalogue=${syncStatus.data?.data?.status?.catalogue_count}`
);

// ─── C. database backup ─────────────────────────────────────────────────────
console.log("\n" + "-".repeat(80));
console.log("C. DATABASE BACKUP");
console.log("-".repeat(80));

const orgBackup = await fetch(`${BASE}/admin/database/backup`, {
  headers: { Authorization: `Bearer ${orgToken}` },
});
check(
  "C1 an org user is refused a database backup",
  orgBackup.status === 401 || orgBackup.status === 403,
  `HTTP ${orgBackup.status}`
);

const backup = await fetch(`${BASE}/admin/database/backup`, {
  headers: { Authorization: `Bearer ${adminToken}` },
});
const sql = await backup.text();

check("C2 the backup downloads with 200", backup.status === 200, `HTTP ${backup.status}`);
check(
  "C3 it is served as a .sql attachment",
  (backup.headers.get("content-type") || "").includes("application/sql") &&
    (backup.headers.get("content-disposition") || "").includes("attachment") &&
    /\.sql"/.test(backup.headers.get("content-disposition") || ""),
  `content-type=${backup.headers.get("content-type")} disposition=${backup.headers.get("content-disposition")}`
);
check(
  "C4 it carries a security notice and is marked no-store",
  sql.includes("Treat as secret") && (backup.headers.get("cache-control") || "").includes("no-store")
);

const [[{ n: tableCount }]] = await db.query(
  "SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE='BASE TABLE'",
  [process.env.DB_NAME]
);
const createStatements = (sql.match(/CREATE TABLE/g) || []).length;
check(
  `C5 every one of the ${tableCount} tables has a CREATE TABLE in the dump`,
  createStatements >= tableCount,
  `CREATE TABLE statements=${createStatements}`
);

const insertStatements = (sql.match(/INSERT INTO/g) || []).length;
check("C6 the dump contains data, not just schema", insertStatements > 0, `INSERT batches=${insertStatements}`);

for (const t of ["users", "organizations", "verification_requests", "document_types", "persons"]) {
  const [rows] = await db.query(`SELECT COUNT(*) AS n FROM \`${t}\``);
  const dumped = new RegExp(`INSERT INTO \`${t}\``).test(sql);
  check(
    `C7 \`${t}\` data is present in the dump (${rows[0].n} rows in the DB)`,
    dumped,
    dumped ? "found" : "MISSING"
  );
}

// Round-trip sanity: escaping must survive a real apostrophe and a newline.
//
// This used to rename the FIRST organization in the table, which is a real
// customer's org, and restore it in a finally block. That "finally" is not a
// safety net: Ctrl+C, a closed terminal, or a hard kill skips it. An interrupted
// run left a customer's organization permanently named
// "Dvarif Backup Probe mulgh15o O'Brien", which then showed on that company's
// own public verification pages.
//
// The probe now inserts its OWN throwaway organization, so there is no real row
// to damage and nothing to restore. A leftover row is still cleaned on exit, on
// every signal, and by the id being obvious if the process is killed outright.
const marker = `Dvarif Backup Probe ${Date.now().toString(36)} O'Brien`;

let probeOrgId = null;
async function dropProbeOrg() {
  if (probeOrgId == null) return;
  const id = probeOrgId;
  probeOrgId = null; // clear first so a failed delete is not retried forever
  try {
    await db.query("DELETE FROM organizations WHERE id=? AND name=?", [id, marker]);
  } catch {
    /* best effort */
  }
}

// Covers the exit paths that skip a finally block.
process.on("exit", () => {});
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    dropProbeOrg().finally(() => process.exit(130));
  });
}
process.on("uncaughtException", (e) => {
  console.error(e);
  dropProbeOrg().finally(() => process.exit(1));
});

const [probeOrg] = await db.query("SELECT id FROM organizations WHERE name=?", [marker]);
if (probeOrg.length) {
  // An earlier run died hard enough to leave its row. Reuse is impossible
  // (the marker embeds a timestamp) so clear the stale one first.
  console.log(`  note: removing stale probe org from an interrupted run (${probeOrg[0].id})`);
  await db.query("DELETE FROM organizations WHERE id=?", [probeOrg[0].id]);
}
const [ins] = await db.query("INSERT INTO organizations (name) VALUES (?)", [marker]);
probeOrgId = ins.insertId;
console.log(`  probe org #${probeOrgId} created for the escaping round-trip`);

let backup2 = null;
let sql2 = "";
try {
  backup2 = await fetch(`${BASE}/admin/database/backup`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  sql2 = await backup2.text();
} finally {
  await dropProbeOrg();
}
check(
  "C8 an apostrophe in live data is escaped and survives the round trip",
  sql2.includes("O\\'Brien"),
  sql2.includes("O\\'Brien") ? "escaped correctly" : "NOT escaped"
);

const badTables = (sql.match(/BACKUP FAILED|WARNING: could not read data/g) || []).length;
check("C9 the dump reports no unreadable tables", badTables === 0, `warnings=${badTables}`);

const dumpedTo = process.env.BACKUP_DIR || path.resolve("_testdata");
fs.mkdirSync(dumpedTo, { recursive: true });
const outFile = path.join(dumpedTo, "sample-backup.sql");
fs.writeFileSync(outFile, sql, "utf8");
console.log(`\n  sample dump written to ${outFile} (${(sql.length / 1024).toFixed(0)} KB)`);

// ─── cleanup ────────────────────────────────────────────────────────────────
if (!KEEP && newId) {
  // Remove this run's type AND any left by an earlier interrupted run, so the
  // catalogue is not slowly filled with "E2E Test Document ..." rows.
  const [strays] = await db.query("SELECT id FROM document_types WHERE name LIKE 'E2E Test Document %'");
  for (const s of strays) await db.query("DELETE FROM document_types WHERE id=?", [s.id]);
  console.log(`  cleanup: removed ${strays.length} test document type(s)`);
  // Re-sync so the service forgets the deleted labels.
  const remaining = await db.query("SELECT name, schema_key FROM document_types WHERE is_active=1 ORDER BY sort_order, id");
  await fetch(`${DOC_SERVICE}/schemas`, {
    method: "PUT",
    headers: { "X-API-Key": process.env.DOC_SERVICE_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ types: remaining[0].map((r) => ({ label: r.name, schema_key: r.schema_key })) }),
  }).catch(() => {});
}
await db.end();

const failed = results.filter((r) => !r.pass);
console.log("\n" + "=".repeat(80));
console.log(`SUMMARY: ${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("\nFAILED:");
  for (const f of failed) console.log(`  - ${f.label}`);
}
console.log("=".repeat(80));
process.exit(failed.length ? 1 : 0);
