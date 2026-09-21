import jwt from "jsonwebtoken";
import "dotenv/config";
import mysql from "mysql2/promise";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:5000/api/v1/verification-requests";
const TMP = "C:/Users/SD1FB~1.JUN/AppData/Local/Temp/opencode";
const VALID_PNG = path.join(TMP, "req_doc.png");
const CORRUPT_PDF = path.join(TMP, "req_corrupt.pdf");
const DOCS_DIR = path.resolve(process.cwd(), "uploads", "documents");

const results = [];
function check(name, ok, extra = "") {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  -> " + extra : ""}`);
}

const pool = await mysql.createConnection({
  host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME, port: Number(process.env.DB_PORT || 3306),
});

// Create fresh test user
const [insUser] = await pool.query(
  "INSERT INTO users (uuid, full_name, email, password, status, org_role, preferred_language, organization, is_verified, feature_access) VALUES (UUID(), 'AutoVer Test User', ?, ?, 'active', 'employee', 'en', NULL, 'yes', ?)",
  [`autover-test-${Date.now()}@dvarif.test`, "x", JSON.stringify({ generate_request: true })]
);
const TEST_USER_ID = insUser.insertId;
const [[uu]] = await pool.query("SELECT uuid FROM users WHERE id=?", [TEST_USER_ID]);
const TEST_USER_UUID = uu.uuid;

const token = jwt.sign(
  { type: "user", role: "user", userId: TEST_USER_UUID },
  process.env.JWT_SECRET,
  { expiresIn: "30m", issuer: process.env.JWT_ISSUER || "dverif-api", audience: process.env.JWT_AUDIENCE || "dverif-client", algorithm: "HS256" }
);

function formOf(fields, filePath) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    fd.append(k, v);
  }
  if (filePath) {
    const buf = fs.readFileSync(filePath);
    fd.append("document", new Blob([buf], { type: "application/octet-stream" }), path.basename(filePath));
  }
  return fd;
}

async function send(method, url, formData) {
  const res = await fetch(url, { method, headers: { Authorization: `Bearer ${token}` }, body: formData });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json };
}
const post = (url, fd) => send("POST", url, fd);
const put = (url, fd) => send("PUT", url, fd);

const NAME_VALID = "TEST OWNER ONE";
const CNIC_DIGITS = "3520212345671";

let createdUuid = null;
let linkedPersonIds = [];
const baseFields = { document_type: "CV", document_owner_name: NAME_VALID, document_owner_cnic: CNIC_DIGITS, other_organization_name: "AutoVer Test Org" };

try {
  fs.writeFileSync(CORRUPT_PDF, "%PDF-1.7\nthis is a truncated pdf body\n");

  // 1: document_owner_name required
  {
    const fd = formOf({ document_type: "CV", document_owner_cnic: CNIC_DIGITS, other_organization_name: "AutoVer Test Org" }, VALID_PNG);
    const r = await post(BASE + "/", fd);
    check("create missing name -> 400 required", r.status === 400 && /document_owner_name is required/.test(r.json?.message), `status=${r.status}`);
  }

  // 1b: whitespace-only name -> 400
  {
    const fd = formOf({ document_type: "CV", document_owner_name: "   ", document_owner_cnic: CNIC_DIGITS, other_organization_name: "AutoVer Test Org" }, VALID_PNG);
    const r = await post(BASE + "/", fd);
    check("create whitespace name -> 400 required", r.status === 400 && /document_owner_name is required/.test(r.json?.message), `status=${r.status}`);
  }

  // 2: document_owner_cnic required
  {
    const fd = formOf({ document_type: "CV", document_owner_name: NAME_VALID, other_organization_name: "AutoVer Test Org" }, VALID_PNG);
    const r = await post(BASE + "/", fd);
    check("create missing cnic -> 400 required", r.status === 400 && /document_owner_cnic is required/.test(r.json?.message), `status=${r.status}`);
  }

  // 3: invalid cnic (12 digits)
  {
    const fd = formOf({ document_type: "CV", document_owner_name: NAME_VALID, document_owner_cnic: "35202-123456", other_organization_name: "AutoVer Test Org" }, VALID_PNG);
    const r = await post(BASE + "/", fd);
    check("create invalid cnic -> 400", r.status === 400 && /must be a valid CNIC/.test(r.json?.message), `status=${r.status}`);
  }

  // 4: corrupt file rejected
  {
    const fd = formOf(baseFields, CORRUPT_PDF);
    const r = await post(BASE + "/", fd);
    check("create corrupt file -> 400 File is corrupt or invalid", r.status === 400 && r.json?.message === "File is corrupt or invalid", `status=${r.status} msg=${r.json?.message}`);
  }

  // 5: valid create
  {
    const fd = formOf(baseFields, VALID_PNG);
    const r = await post(BASE + "/", fd);
    check("create valid -> 201", r.status === 201, `status=${r.status} msg=${r.json?.message}`);
    if (r.status === 201) {
      createdUuid = r.json.data.request.uuid;
    }
  }

  // 5b: DB truth after create
  if (createdUuid) {
    const [[row]] = await pool.query(
      "SELECT document_owner_name, status, document_hash, linked_person_id FROM verification_requests WHERE uuid=?", [createdUuid]
    );
    check("create DB: name persisted", row.document_owner_name === NAME_VALID, `got=${row.document_owner_name}`);
    check("create DB: status under_review", row.status === "under_review", `got=${row.status}`);
    check("create DB: document_hash stored", typeof row.document_hash === "string" && row.document_hash.length === 64);
    check("create DB: linked_person_id set", row.linked_person_id !== null && row.linked_person_id !== undefined, `got=${row.linked_person_id}`);
    if (row.linked_person_id) linkedPersonIds.push(row.linked_person_id);
  }

  // 6: update omitting owner fields -> unchanged
  if (createdUuid) {
    const fd = formOf({ document_type: "CV", other_organization_name: "AutoVer Test Org" }, VALID_PNG);
    const r = await put(`${BASE}/my/sent/${createdUuid}`, fd);
    check("update omit fields -> 200", r.status === 200, `status=${r.status}`);
    const [[row]] = await pool.query("SELECT document_owner_name FROM verification_requests WHERE uuid=?", [createdUuid]);
    check("name unchanged after omit", row.document_owner_name === NAME_VALID, `got=${row.document_owner_name}`);
  }

  // 7: empty name on a NAMED record -> 400
  if (createdUuid) {
    const fd = formOf({ document_type: "CV", document_owner_name: "", other_organization_name: "AutoVer Test Org" }, VALID_PNG);
    const r = await put(`${BASE}/my/sent/${createdUuid}`, fd);
    check("update empty name on named record -> 400", r.status === 400 && r.json?.message === "document_owner_name is required", `status=${r.status} msg=${r.json?.message}`);
  }

  // 8: invalid cnic on update -> 400
  if (createdUuid) {
    const fd = formOf({ document_type: "CV", document_owner_cnic: "123", other_organization_name: "AutoVer Test Org" }, VALID_PNG);
    const r = await put(`${BASE}/my/sent/${createdUuid}`, fd);
    check("update invalid cnic -> 400", r.status === 400 && /must be a valid CNIC/.test(r.json?.message), `status=${r.status}`);
  }

  // 9: update with valid new name + cnic -> persisted
  if (createdUuid) {
    const fd = formOf({ document_type: "CV", document_owner_name: "TEST OWNER TWO", document_owner_cnic: "37405-9876543-1", other_organization_name: "AutoVer Test Org" }, VALID_PNG);
    const r = await put(`${BASE}/my/sent/${createdUuid}`, fd);
    check("update valid name+cnic -> 200", r.status === 200, `status=${r.status}`);
    const [[row]] = await pool.query("SELECT document_owner_name FROM verification_requests WHERE uuid=?", [createdUuid]);
    check("name updated to TEST OWNER TWO", row.document_owner_name === "TEST OWNER TWO", `got=${row.document_owner_name}`);
  }

  // 10: OLD null-name record stays editable
  {
    const [ins] = await pool.query(
      `INSERT INTO verification_requests (user_id, document_type, status, submitted_at, document_path, document_format, verification_method, created_at)
       VALUES (?, 'CV', 'under_review', NOW(), '/uploads/documents/null-test.pdf', 'pdf', 'manual', NOW())`,
      [TEST_USER_ID]
    );
    const [[nr]] = await pool.query("SELECT uuid, document_owner_name FROM verification_requests WHERE id=?", [ins.insertId]);
    const nullRecordUuid = nr.uuid;
    check("null-record: exists with null name", nr.document_owner_name === null, `got=${nr.document_owner_name}`);

    // empty name on a NULL record -> allowed, stays null
    const fd1 = formOf({ document_type: "CV", document_owner_name: "", other_organization_name: "AutoVer Test Org" }, VALID_PNG);
    const r1 = await put(`${BASE}/my/sent/${nullRecordUuid}`, fd1);
    const [[row1]] = await pool.query("SELECT document_owner_name FROM verification_requests WHERE uuid=?", [nullRecordUuid]);
    check("null-record: empty name -> 200 stays null", r1.status === 200 && row1.document_owner_name === null, `status=${r1.status} name=${row1.document_owner_name}`);

    // valid name on the null record -> succeeds
    const fd2 = formOf({ document_type: "CV", document_owner_name: "NULL EDIT OK", other_organization_name: "AutoVer Test Org" }, VALID_PNG);
    const r2 = await put(`${BASE}/my/sent/${nullRecordUuid}`, fd2);
    const [[row2]] = await pool.query("SELECT document_owner_name FROM verification_requests WHERE uuid=?", [nullRecordUuid]);
    check("null-record: set name -> 200", r2.status === 200 && row2.document_owner_name === "NULL EDIT OK", `status=${r2.status} name=${row2.document_owner_name}`);
  }
} catch (e) {
  check("uncaught error", false, `${e.message}`);
} finally {
  try {
    const [reqs] = await pool.query("SELECT id, document_path FROM verification_requests WHERE user_id=?", [TEST_USER_ID]);
    for (const rq of reqs) {
      const fname = path.basename(rq.document_path || "");
      if (fname && fname !== "null-test.pdf") {
        const p = path.join(DOCS_DIR, fname);
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
    }
    await pool.query("DELETE FROM verification_requests WHERE user_id=?", [TEST_USER_ID]);
    await pool.query("DELETE FROM audit_logs WHERE actor_id=? AND actor_type='user'", [TEST_USER_ID]);
    await pool.query("DELETE FROM users WHERE id=?", [TEST_USER_ID]);
    if (linkedPersonIds.length) await pool.query("DELETE FROM persons WHERE id IN (?)", [linkedPersonIds]);
    await pool.query("DELETE FROM unmatched_organizations WHERE name='AutoVer Test Org'");
    console.log("[cleanup done]");
  } catch (e) {
    console.error("[cleanup failed]", e.message);
  }
  await pool.end();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);