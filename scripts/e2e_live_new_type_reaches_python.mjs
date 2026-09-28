/**
 * The point of the whole exercise: a document type added by a system admin in the
 * UI must reach the Python OCR service, and the service must extract that
 * document with the schema the admin chose.
 *
 * The type catalogue used to be hard-coded in two repositories, so a new type was
 * impossible without a code change. It is now a database table, and the backend
 * pushes it to the document service. This proves the whole chain, end to end,
 * with a real PDF and real Tesseract OCR:
 *
 *   admin adds a type  ->  the service resolves it  ->  a real document submitted
 *   under that type is extracted with the CHOSEN schema's fields
 *
 * The second half is the one that matters. A type that merely appears in a
 * dropdown is cosmetic; a type that is extracted with name+CNIC when the admin
 * asked for name+CNIC+DOB is actually working.
 *
 * Usage: node scripts/e2e_live_new_type_reaches_python.mjs
 */
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import mysql from "mysql2/promise";
import { signAccessToken } from "../src/utils/jwt.js";

dotenv.config({ quiet: true });

const BASE = `http://localhost:${process.env.PORT || 5000}/api/v1`;
const DOC = process.env.DOC_SERVICE_URL || "http://localhost:5001";
const DATA = path.resolve(process.cwd(), "_testdata");
const KEEP = process.env.KEEP_TEST_DATA === "1";

const results = [];
function check(label, pass, detail) {
  results.push({ label, pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail ? `\n          ${detail}` : ""}`);
}

const CNIC = "42101-1234567-1";
const CNIC_DIGITS = "4210112345671";
const NEW_TYPE = `Vaccination Certificate ${Date.now().toString(36)}`;

const db = await mysql.createConnection({
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "verification_app",
});

const [[admin]] = await db.query("SELECT uuid, email FROM admin_profiles ORDER BY id LIMIT 1");
const token = signAccessToken({ type: "admin", userId: admin.uuid, role: "admin", email: admin.email });

async function api(method, route, body) {
  const headers = { Authorization: `Bearer ${token}` };
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(BASE + route, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
}

function pyHeaders() {
  return { "X-API-Key": process.env.DOC_SERVICE_API_KEY, "Content-Type": "application/json" };
}

/** Post a real PDF to the service's /ocr/extract as a given document type. */
async function extractAs(pdf, documentType) {
  const fd = new FormData();
  fd.append("file", new File([fs.readFileSync(path.join(DATA, pdf))], pdf, { type: "application/pdf" }));
  fd.append("document_type", documentType);
  const res = await fetch(`${DOC}/ocr/extract`, {
    method: "POST",
    headers: { "X-API-Key": process.env.DOC_SERVICE_API_KEY },
    body: fd,
  });
  return { status: res.status, data: await res.json() };
}

console.log("=".repeat(80));
console.log("LIVE TEST — a new document type reaches the Python OCR service");
console.log("=".repeat(80));
console.log(`  new type : "${NEW_TYPE}"`);
console.log(`  schema   : cnic  (name + CNIC + date of birth)`);

let newId = null;
try {
  // ─── 1. the admin adds it ──────────────────────────────────────────────────
  const created = await api("POST", "/admin/document-types", {
    name: NEW_TYPE,
    schema_key: "cnic",
  });
  newId = created.data?.data?.document_type?.id;
  check("1. the admin can add the type", created.status === 201 && Boolean(newId), `HTTP ${created.status} id=${newId}`);

  // ─── 2. it reaches the service ─────────────────────────────────────────────
  // The push is fire-and-forget, so allow it a moment.
  await new Promise((r) => setTimeout(r, 2500));

  const status = await api("GET", "/admin/document-types/sync-status");
  check(
    "2. the service reports being in step",
    status.data?.data?.status?.reachable === true,
    `reachable=${status.data?.data?.status?.reachable} catalogue=${status.data?.data?.status?.catalogue_count}`
  );

  const resolved = await fetch(`${DOC}/schemas/resolve`, {
    method: "POST",
    headers: pyHeaders(),
    body: JSON.stringify({ types: [{ label: NEW_TYPE, schema_key: "cnic" }] }),
  }).then((r) => r.json());
  check(
    "3. the service resolves the brand-new label",
    resolved?.data?.resolved?.[0]?.schema_key === "cnic",
    JSON.stringify(resolved?.data?.resolved)
  );

  // ─── 3. AND THE POINT: it changes real extraction ──────────────────────────
  // A CNIC card carrying name + CNIC + DOB, submitted under the new type. With
  // the 'cnic' schema the DOB must be extracted; under a schema that does not
  // declare dob (or the default 'generic') it must not be. That difference is
  // what proves the service is using the admin's choice and not a fallback.
  const asNew = await extractAs("cnic_card_a.pdf", NEW_TYPE);
  const newFields = asNew.data?.data?.fields || {};

  check(
    "4. the service extracts it with the CHOSEN schema (dob is read)",
    asNew.status === 200 && Boolean(newFields.dob?.value) && newFields.dob.value === "1990-08-05",
    `document_type=${asNew.data?.data?.document_type} dob=${newFields.dob?.value} cnic=${newFields.cnic?.value}`
  );
  check(
    "5. the CNIC and name are read too",
    newFields.cnic?.value === CNIC_DIGITS && newFields.name?.value === "Asim Khan",
    `name=${newFields.name?.value} cnic=${newFields.cnic?.value}`
  );

  // The same document under an unknown type degrades to 'generic', which has no
  // dob field at all. Comparing the two is what shows the schema genuinely
  // drives extraction rather than the difference being a coincidence.
  const asGeneric = await extractAs("cnic_card_a.pdf", "Some Type Nobody Registered");
  const genericFields = asGeneric.data?.data?.fields || {};
  check(
    "6. an UNREGISTERED type would only get the generic schema (no dob)",
    genericFields.dob === undefined || genericFields.dob?.value == null,
    `generic document_type=${asGeneric.data?.data?.document_type} fields=${JSON.stringify(Object.keys(genericFields))}`
  );
  check(
    "7. so the DOB in check 4 came from the admin's chosen schema, not a default",
    Boolean(newFields.dob?.value) && genericFields.dob === undefined,
    `with new type: dob=${newFields.dob?.value} | with unknown type: dob=${genericFields.dob?.value ?? "field absent"}`
  );

  // ─── 4. it shows up for org users in the dropdown feed ─────────────────────
  const [[orgUser]] = await db.query(
    "SELECT uuid, email, organization, org_role FROM users WHERE org_role='org_admin' ORDER BY id LIMIT 1"
  );
  const orgToken = signAccessToken({
    type: "user",
    userId: orgUser.uuid,
    role: "user",
    organization: orgUser.organization,
    org_role: orgUser.org_role,
  });
  const feed = await fetch(`${BASE}/document-types`, { headers: { Authorization: `Bearer ${orgToken}` } }).then((r) =>
    r.json()
  );
  const names = (feed?.data?.items || []).map((i) => i.value);
  check(
    "8. the new type appears in the feed that fills the upload dropdowns",
    names.includes(NEW_TYPE),
    `${names.length} types offered, new type present=${names.includes(NEW_TYPE)}`
  );

  // ─── 5. hiding it takes it out of the dropdowns ────────────────────────────
  if (newId) {
    await api("PUT", `/admin/document-types/${newId}`, { is_active: false });
    await new Promise((r) => setTimeout(r, 1500));
    const feed2 = await fetch(`${BASE}/document-types`, { headers: { Authorization: `Bearer ${orgToken}` } }).then(
      (r) => r.json()
    );
    const names2 = (feed2?.data?.items || []).map((i) => i.value);
    check("9. hiding a type removes it from the dropdowns", !names2.includes(NEW_TYPE), `present=${names2.includes(NEW_TYPE)}`);

    // ...and the service forgets it too (the push REPLACES the catalogue).
    const gone = await fetch(`${DOC}/schemas/resolve`, {
      method: "POST",
      headers: pyHeaders(),
      body: JSON.stringify({ types: [{ label: NEW_TYPE, schema_key: "cnic" }] }),
    }).then((r) => r.json());
    check(
      "10. and the service stops resolving it as a custom type",
      gone?.data?.resolved?.[0]?.schema_key === "generic",
      JSON.stringify(gone?.data?.resolved)
    );
  }
} catch (error) {
  console.error("\n!! ERROR:", error.message);
  results.push({ label: "test run completed", pass: false, detail: error.message });
} finally {
  if (!KEEP) {
    const [strays] = await db.query("SELECT id FROM document_types WHERE name LIKE 'Vaccination Certificate %'");
    for (const s of strays) await db.query("DELETE FROM document_types WHERE id=?", [s.id]);
    if (strays.length) console.log(`  cleanup: removed ${strays.length} test type(s)`);
    // Leave the service in step with the real catalogue again.
    const remaining = await db.query(
      "SELECT name, schema_key FROM document_types WHERE is_active=1 ORDER BY sort_order, id"
    );
    await fetch(`${DOC}/schemas`, {
      method: "PUT",
      headers: pyHeaders(),
      body: JSON.stringify({ types: remaining[0].map((r) => ({ label: r.name, schema_key: r.schema_key })) }),
    }).catch(() => {});
  }
  await db.end();
}

const failed = results.filter((r) => !r.pass);
console.log("\n" + "=".repeat(80));
console.log(`SUMMARY: ${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("\nFAILED:");
  for (const f of failed) console.log(`  - ${f.label}`);
}
console.log("=".repeat(80));
process.exit(failed.length ? 1 : 0);
