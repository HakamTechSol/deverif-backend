// Full verification-request flow end-to-end test.
//
// This script drives the REAL API + REAL database to exercise the whole
// pipeline that the roster/reference + auto-match features built around:
//
//   1) Reference endpoints   POST /org/employees/reference
//                            POST /org/employees/:uuid/archive-reference
//                            GET  /org/employees?reference=1
//   2) Exact-hash fast path  Same PDF bytes as the stored employee document
//                            -> automatic verify WITHOUT the OCR service.
//   3) Different-file path   A different PDF -> OCR fuzzy match. Observes the
//                            decision tree (auto_matched / manual_review) or
//                            deferred (not_attempted) if the OCR service is down.
//
// Requirements
//   - Backend server running:   cd backend && npm run dev   (:5000)
//   - MySQL reachable via backend/.env DB_* vars
//   - python-backend OPTIONAL (auto-detected for section 4)
//
// Usage
//   node _e2e_verify_flow.mjs                # run the flow
//   E2E_CLEANUP=1 node _e2e_verify_flow.mjs  # ALSO delete the seeded test rows

import "dotenv/config";
import { createConnection } from "mysql2/promise";
import bcrypt from "bcryptjs";
import PDFKit from "pdfkit";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.API_BASE_URL || "http://localhost:5000/api/v1";
const DOCS_DIR = path.join(__dirname, "uploads", "documents");
const DOC_SERVICE_URL = (process.env.DOC_SERVICE_URL || "http://localhost:5001").replace(/\/+$/, "");

// ---- unique run identity -------------------------------------------------
const SUFFIX = Date.now().toString().slice(-7);
const ORG_NAME = `E2E Verify Org ${SUFFIX}`;
const ADMIN_EMAIL = `e2e_admin_${SUFFIX}@example.com`;
const ADMIN_PASS = "Test@1234";
const OWNER_NAME = "Asim Khan";
const OWNER_CNIC_DIGITS = "4210112345671";
const OWNER_CNIC_HYPHEN = "42101-1234567-1";
const REF_CREATE_NAME = "Salman Rao";
const REF_CREATE_CNIC = "3520299999999";
const ARCHIVE_CNIC = "3520212345678";
const ED_FILENAME = `e2e_ref_${SUFFIX}.pdf`;

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
let db = null;
let seeded = false;
function section(t) { console.log(`\n${"=".repeat(70)}\n\u25b6 ${t}\n${"=".repeat(70)}`); }
function ok(cond, name, extra = "") { results.push({ name, ok: !!cond, extra }); console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${extra ? `   (${extra})` : ""}`); }
function note(t) { console.log(`  \u2022 ${t}`); }
function dataOf(json) { return json && json.data !== undefined ? json.data : json || {}; }

async function api(pathStr, { method = "GET", token, body, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (form) {
    payload = form;
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${pathStr}`, { method, headers, body: payload });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json, data: dataOf(json) };
}

function makePdf(lines) {
  return new Promise((resolve, reject) => {
    const doc = new PDFKit({ size: "A4", margin: 60 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.fontSize(13);
    lines.forEach((l) => doc.text(l, { lineGap: 6 }));
    doc.end();
  });
}

function cnicHash(digits) {
  return sha256(String(digits).replace(/[^0-9]/g, ""));
}

const REF_LINES = [
  "EMPLOYMENT CONFIRMATION LETTER",
  `Reference No. E2E-${SUFFIX}`,
  "Date: 2026-09-16",
  "",
  "To Whom It May Concern,",
  `This letter confirms that ${OWNER_NAME}, holder of CNIC ${OWNER_CNIC_HYPHEN}, is`,
  "regularly employed at this organization as Senior Software Engineer",
  "and has been with us since March 2019.",
  "Signed for and on behalf of the employer.",
];

const DIFF_LINES = [
  "TRANSCRIPT OF RECORDS",
  "Registrar's Office - Verity Heights University",
  "",
  `Certificate No: TR-${SUFFIX}`,
  "This transcript certifies that Rita Lemos, CNIC 35202-9876543-2, completed the",
  "Bachelor of Science degree programme and was conferred the degree in 2023.",
  "",
  "Issued on 2026-09-16 by the Office of the Registrar.",
];

// ---------------------------------------------------------------------------

async function main() {
  console.log(`\nE2E verification-request flow  (run ${SUFFIX})`);
  console.log(`backend base: ${BASE}`);
  console.log(`doc service : ${DOC_SERVICE_URL}`);

  // ---- Section 0: connectivity ------------------------------------------
  section("0. Connectivity");
  let backendUp = true;
  try {
    await fetch(`${BASE}/marketing/plans`, { signal: AbortSignal.timeout(4000) });
  } catch {
    backendUp = false;
  }
  ok(backendUp, "Backend reachable", backendUp ? "" : "start it with: cd backend && npm run dev");
  if (!backendUp) return;

  let pythonUp = false;
  let pythonNote = "";
  try {
    const h = await fetch(`${DOC_SERVICE_URL}/health`, { signal: AbortSignal.timeout(4000) });
    pythonUp = h.ok;
  } catch { /* down */ }
  ok(pythonUp, "OCR service reachable", pythonUp ? "fuzzy-match tests will run live" : "down -> exact-hash still works, fuzzy path will be deferred");
  pythonNote = pythonUp ? "live OCR" : "DOWN (deferred path expected)";

  // ---- Section 1: seed ---------------------------------------------------
  section("1. Seed org / plan / admin / employees / reference document");
  db = await createConnection({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  });
  const conn = db;

  const orgUuid = crypto.randomUUID();
  const [planRes] = await conn.execute(
    `INSERT INTO subscription_plans (uuid, name, monthly_price, daily_request_quota, description, is_public, is_custom)
     VALUES (UUID(), ?, 0, 100, ?, 0, 1)`,
    [`E2E Plan ${SUFFIX}`, `auto-created by verification flow E2E run ${SUFFIX}`]
  );
  const planId = planRes.insertId;

  const [orgRes] = await conn.execute(
    `INSERT INTO organizations (uuid, name, verified, subscription_status, subscription_plan_id)
     VALUES (?, ?, 'yes', 'active', ?)`,
    [orgUuid, ORG_NAME, planId]
  );
  const orgId = orgRes.insertId;

  const hashedPass = await bcrypt.hash(ADMIN_PASS, 12);
  const [userRes] = await conn.execute(
    `INSERT INTO users (uuid, full_name, email, password, cnic, status, org_role, organization, feature_access, is_verified, created_at)
     VALUES (UUID(), 'E2E Admin', ?, ?, '1111111111111', 'active', 'org_admin', ?, '{}', 'no', NOW())`,
    [ADMIN_EMAIL, hashedPass, orgId]
  );
  const adminId = userRes.insertId;
  const [[adminUser]] = await conn.execute("SELECT uuid FROM users WHERE id=?", [adminId]);
  const adminUuid = adminUser.uuid;

  const asimUuid = crypto.randomUUID();
  const archiveUuid = crypto.randomUUID();
  await conn.execute(
    `INSERT INTO employees (uuid, organization_id, full_name, cnic, status, is_platform_user, added_by_uuid, created_at)
     VALUES (?, ?, ?, ?, 'active', 'no', ?, NOW())`,
    [asimUuid, orgId, OWNER_NAME, OWNER_CNIC_DIGITS, adminUuid]
  );
  await conn.execute(
    `INSERT INTO employees (uuid, organization_id, full_name, cnic, status, is_platform_user, added_by_uuid, created_at)
     VALUES (?, ?, 'Tara Qadir', ?, 'active', 'no', ?, NOW())`,
    [archiveUuid, orgId, ARCHIVE_CNIC, adminUuid]
  );

  const refPdf = await makePdf(REF_LINES);
  const diffPdf = await makePdf(DIFF_LINES);
  if (!fs.existsSync(DOCS_DIR)) fs.mkdirSync(DOCS_DIR, { recursive: true });
  const edPath = path.join(DOCS_DIR, ED_FILENAME);
  fs.writeFileSync(edPath, refPdf);
  const edHash = sha256(refPdf);
  await conn.execute(
    `INSERT INTO employee_documents (uuid, employee_uuid, document_type, file_name, file_path, file_size, uploaded_by_uuid, document_hash, created_at)
     VALUES (UUID(), ?, 'Employment Letter', ?, ?, ?, ?, ?, NOW())`,
    [asimUuid, ED_FILENAME, `documents/${ED_FILENAME}`, refPdf.length, adminUuid, edHash]
  );
  seeded = true;

  ok(true, "Seeded org + active plan (quota 100) + admin + roster employees + reference doc");

  // ---- Section 2: reference endpoints ------------------------------------
  section("2. Reference endpoints (create / archive / list?reference=1)");
  const login = await api("/auth/user/login", { method: "POST", body: { email: ADMIN_EMAIL, password: ADMIN_PASS } });
  ok(login.status === 200 && login.data.token, "Admin login", login.data.user ? login.data.user.full_name : `HTTP ${login.status}`);
  const token = login.data.token;

  const listDefault1 = await api("/org/employees", { token });
  const namesDefault1 = (listDefault1.data.items || []).map((e) => e.full_name);
  ok(listDefault1.status === 200 && namesDefault1.includes(OWNER_NAME) && namesDefault1.includes("Tara Qadir"), "Roster list shows seeded employees", namesDefault1.join(", "));

  const refCreate = await api("/org/employees/reference", { method: "POST", token, body: { full_name: REF_CREATE_NAME, cnic: REF_CREATE_CNIC } });
  ok(refCreate.status === 201 && refCreate.data.employee?.record_type === "learned_reference", "createReference -> 201 learned_reference");

  const listRef1 = await api("/org/employees?reference=1", { token });
  const refNames = (listRef1.data.items || []).map((e) => e.full_name);
  ok(listRef1.status === 200 && refNames.includes(REF_CREATE_NAME), "list ?reference=1 includes reference record", refNames.join(", "));

  const listDefault2 = await api("/org/employees", { token });
  const namesDefault2 = (listDefault2.data.items || []).map((e) => e.full_name);
  ok(listDefault2.status === 200 && !namesDefault2.includes(REF_CREATE_NAME), "default list hides reference record");

  const archiveRes = await api(`/org/employees/${archiveUuid}/archive-reference`, { method: "POST", token });
  ok(archiveRes.status === 200 && archiveRes.data.employee?.record_type === "learned_reference" && archiveRes.data.employee?.status === "resigned",
     "archiveReference -> record_type learned_reference + status resigned");

  const listRef2 = await api("/org/employees?reference=1", { token });
  const refNames2 = (listRef2.data.items || []).map((e) => e.full_name);
  ok(listRef2.status === 200 && refNames2.includes("Tara Qadir"), "archived employee now in reference list", refNames2.join(", "));

  const crossOrg = await api("/org/employees/reference", {
    method: "POST",
    token,
    body: { full_name: REF_CREATE_NAME, cnic: REF_CREATE_CNIC },
  });
  ok(crossOrg.status === 409, "duplicate CNIC in org -> 409 Conflict", `got ${crossOrg.status}`);

  // ---- Section 3: exact-hash auto-verify ---------------------------------
  section("3. Verification request - EXACT HASH fast path (no OCR needed)");
  const form1 = new FormData();
  form1.append("document", new Blob([refPdf], { type: "application/pdf" }), "employee_letter.pdf");
  form1.append("document_type", "Employment Letter");
  form1.append("issuing_organization_uuid", orgUuid);
  form1.append("document_owner_name", OWNER_NAME);
  form1.append("document_owner_cnic", OWNER_CNIC_HYPHEN);
  const req1 = await api("/verification-requests", { method: "POST", token, form: form1 });
  const r1 = req1.data.request || {};
  ok(req1.status === 201, "createRequest (same bytes) -> 201", req1.status);
  ok(r1.status === "under_review" && r1.match_status === "not_attempted", "initial: status=under_review, match_status=not_attempted");
  ok(Boolean(r1.matched_employee_document_id), "staged against reference employee document", `docId=${r1.matched_employee_document_id}`);
  ok(r1.document_hash === edHash, "document_hash = SHA-256 of uploaded file", r1.document_hash?.slice(0, 16) + "\u2026");

  await api("/verification-requests/my/inbox", { token });
  let r1Final = null;
  let attempt = 0;
  for (; attempt < 15; attempt++) {
    const d = await api(`/verification-requests/my/inbox/${r1.uuid}`, { token });
    r1Final = d.data.request || {};
    if (r1Final.status === "verified" && r1Final.match_status === "auto_matched") break;
    await sleep(700);
  }
  ok(r1Final.status === "verified", "auto-approved -> status=verified", `${attempt + 1} polls`);
  ok(r1Final.match_status === "auto_matched", "match_status=auto_matched");
  ok(Number(r1Final.match_confidence) === 100, "match_confidence=100 (exact hash)", String(r1Final.match_confidence));
  ok((r1Final.matched_document_name || "").endsWith(ED_FILENAME), "matched_document_name = employee doc file", r1Final.matched_document_name);
  ok(r1Final.matched_employee_name === OWNER_NAME, "matched_employee_name = Asim Khan", r1Final.matched_employee_name);
  ok((r1Final.verification_method || "").includes("auto"), "verification_method marks auto path", r1Final.verification_method);

  const inboxList = await api("/verification-requests/my/inbox", { token });
  const inboxRow = (inboxList.data.items || []).find((x) => x.uuid === r1.uuid);
  ok(Boolean(inboxRow?.match_status) && Number(inboxRow?.match_confidence) === 100, "inbox row exposes match badge fields", inboxRow ? `${inboxRow.match_status} / ${inboxRow.match_confidence}` : "row not found");

  // ---- Section 4: different-file fuzzy path ------------------------------
  section("4. Verification request - DIFFERENT FILE (fuzzy path)");
  const form2 = new FormData();
  form2.append("document", new Blob([diffPdf], { type: "application/pdf" }), "degree_transcript.pdf");
  form2.append("document_type", "Degree Transcript");
  form2.append("issuing_organization_uuid", orgUuid);
  form2.append("document_owner_name", OWNER_NAME);
  form2.append("document_owner_cnic", OWNER_CNIC_HYPHEN);
  const req2 = await api("/verification-requests", { method: "POST", token, form: form2 });
  const r2 = req2.data.request || {};
  ok(req2.status === 201, "createRequest (different bytes) -> 201");
  ok(r2.status === "under_review" && r2.match_status === "not_attempted", "initial: status=under_review, match_status=not_attempted");

  let r2Final = null;
  let attempt2 = 0;
  for (; attempt2 < 20; attempt2++) {
    const d = await api(`/verification-requests/my/inbox/${r2.uuid}`, { token });
    r2Final = d.data.request || {};
    if (r2Final.match_status && r2Final.match_status !== "not_attempted") break;
    await sleep(700);
  }
  if (pythonUp) {
    const ms = r2Final.match_status;
    const conf = r2Final.match_confidence;
    ok(ms === "manual_review", "different file -> match_status=manual_review", `got ${ms} / conf=${conf}`);
    if (ms === "manual_review") ok(Number(conf) < 90, "match_confidence < 90 (no auto-approve)", String(conf));
    ok(r2Final.status === "under_review", "stays under_review (not auto-approved)", r2Final.status);
  } else {
    ok((r2Final.match_status || "not_attempted") === "not_attempted", "OCR down -> match deferred (not_attempted), no crash", r2Final.match_status);
  }
  note(`final state: match_status=${r2Final.match_status} confidence=${r2Final.match_confidence} status=${r2Final.status} (service: ${pythonNote})`);

  // ---- Section 5: summary ------------------------------------------------
  section("5. Summary");
  const fails = results.filter((r) => !r.ok);
  console.log(`\n  ${results.length - fails.length}/${results.length} checks passed${fails.length ? "  (FAILED: " + fails.map((f) => f.name).join(" | ") + ")" : ""}`);

  console.log(`
  What you just observed
   1. Reference endpoints  : createReference 201, archiveReference flips row to
      learned_reference + resigned, ?reference=1 filters the reference list.
   2. Exact-hash fast path : re-submitting the SAME file -> document_hash equal ->
      confidence 100 -> auto-mapped + auto-approved, NO OCR service required.
   3. Fuzzy path           : a DIFFERENT file -> OCR/text match is scored
      (0.6*name + 0.4*cnic, fuzzy >=88%). {python up} -> manual_review when below
      the 90% auto-approve bar; {python down} -> deferred to not_attempted and
      retried later - the backend never crashes on service outage.
`);

  await conn.end();
  db = null;

  if (process.env.E2E_CLEANUP === "1") {
    section("Cleanup");
    await cleanupRun();
    console.log("  \u2713 Test rows + uploaded reference PDF removed.");
  } else {
    console.log(`  Leave nothing behind later with:\n    E2E_CLEANUP=1 node _e2e_verify_flow.mjs`);
  }

  process.exitCode = fails.length ? 1 : 0;
  process.exit(process.exitCode);
}

async function cleanupRun() {
  let c = db;
  let own = false;
  if (!c) {
    c = await createConnection({
      host: process.env.DB_HOST, user: process.env.DB_USER,
      password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
    });
    own = true;
  }
  try {
    const hashes = [cnicHash(OWNER_CNIC_DIGITS), cnicHash("3520298765432")];
    if (typeof adminId !== "undefined") {
      await c.execute("DELETE FROM verification_requests WHERE user_id=?", [adminId]);
    }
    for (const h of hashes) {
      await c.execute("DELETE FROM person_documents WHERE person_id IN (SELECT id FROM persons WHERE cnic_hash=?)", [h]);
      await c.execute("DELETE FROM persons WHERE cnic_hash=?", [h]);
    }
    if (typeof orgId !== "undefined") {
      await c.execute("DELETE FROM employees WHERE organization_id=?", [orgId]);
      await c.execute("DELETE FROM users WHERE id=?", [adminId]);
      await c.execute("DELETE FROM organizations WHERE id=?", [orgId]);
      await c.execute("DELETE FROM daily_request_usage WHERE organization_id=?", [orgId]);
    }
    if (typeof planId !== "undefined") {
      await c.execute("DELETE FROM subscription_plans WHERE id=?", [planId]);
    }
  } finally {
    if (own) await c.end();
  }
  const edPath2 = path.join(DOCS_DIR, ED_FILENAME);
  if (fs.existsSync(edPath2)) fs.unlinkSync(edPath2);
}

main().catch(async (e) => {
  console.error("\n✗ E2E flow errored:", e.message);
  if (seeded) {
    console.error("  cleaning up partial seed data for this run\u2026");
    await cleanupRun().catch((ce) => console.error("  cleanup error:", ce.message));
  } else if (db) {
    await db.end().catch(() => {});
  }
  process.exitCode = 1;
  process.exit(1);
});