/**
 * LIVE END-TO-END verification test against the running stack (:5000 Node +
 * :5001 Python + MariaDB), using REAL PDF fixtures and REAL Tesseract OCR.
 *
 * What it proves, in order:
 *
 *   A. The document-replay bug is closed. An org approves a document for one
 *      person; the SAME BYTES re-submitted under a DIFFERENT CNIC must land in
 *      the reviewer's inbox instead of being auto-verified. The positive control
 *      â€” same bytes, same person â€” must still auto-verify, or the feature is
 *      simply broken rather than fixed.
 *
 *   B. The reference-match path honours the document service's identity
 *      verdict. An employee has a reference document that prints CNIC X; a
 *      submission that prints a DIFFERENT CNIC must not auto-approve even
 *      though it was staged against that employee's own reference.
 *
 *   C. An identity-poor document type (an NDA) never auto-approves.
 *
 * Auth: tokens are minted with the application's own signAccessToken(), so the
 * real auth middleware and every downstream check run. Only the OTP email
 * delivery step is skipped (the dev SMTP catcher is not running).
 *
 * Every row this creates is removed at the end unless KEEP_TEST_DATA=1.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import dotenv from "dotenv";
import mysql from "mysql2/promise";
import { signAccessToken } from "../src/utils/jwt.js";

dotenv.config();

const BASE = `http://localhost:${process.env.PORT || 5000}/api/v1`;
const DATA = path.resolve(process.cwd(), "_testdata");
const KEEP = process.env.KEEP_TEST_DATA === "1";

// Unique per run so repeated runs never collide on the uniqueness constraints.
const TAG = crypto.randomBytes(4).toString("hex");
const CNIC_X = "4210112345671"; // Asim Khan  â€” printed on the reference letter
const CNIC_Y = "3520276543219"; // Bilal Ahmed â€” a different person entirely
const OWNER_X = "Asim Khan";
const OWNER_Y = "Bilal Ahmed";

const db = await mysql.createConnection({
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "verification_app",
});

const results = [];
function check(label, pass, detail) {
  results.push({ label, pass, detail });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail ? `\n          ${detail}` : ""}`);
}
function skip(label, why) {
  console.log(`  SKIP  ${label}\n          ${why}`);
}

/**
 * Scenario B and C need `employee_documents.extracted_data` to exist. On a
 * database where the reference-canonical-fields migration has not been applied
 * the reference upload 500s, so those scenarios are reported as SKIPPED rather
 * than as failures â€” the drift is an environment problem, not a verdict on the
 * code under test.
 */
// mysql2/promise resolves query() as [rows, fields] — destructure the rows, or
// the map below runs over the two-element tuple and every c.Field is undefined.
const [edCols] = await db.query("SHOW COLUMNS FROM employee_documents");
const edFields = new Set(edCols.map((c) => c.Field));
const REFERENCE_UPLOAD_SUPPORTED = ["extracted_data", "extraction_status", "extraction_error", "extracted_at"].every(
  (f) => edFields.has(f)
);
const missingRefColumns = ["extracted_data", "extraction_status", "extraction_error", "extracted_at"].filter(
  (f) => !edFields.has(f)
);

async function api(method, route, { token, body, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(BASE + route, {
    method,
    headers,
    body: form || (body ? JSON.stringify(body) : undefined),
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

function pdfForm({ file, documentType, orgUuid, ownerName, ownerCnic }) {
  const fd = new FormData();
  fd.append("document", new File([fs.readFileSync(path.join(DATA, file))], file, { type: "application/pdf" }));
  fd.append("document_type", documentType);
  fd.append("issuing_organization_uuid", orgUuid);
  fd.append("document_owner_name", ownerName);
  fd.append("document_owner_cnic", ownerCnic);
  return fd;
}

async function tokenFor(user) {
  // Same claim set the real OTP login issues (auth.otp.controller.js).
  return signAccessToken({
    type: "user",
    userId: user.uuid,
    role: "user",
    organization: user.organization,
    org_role: user.org_role,
  });
}

const [[verifier]] = await db.query("SELECT uuid, email, organization, org_role FROM users WHERE id=1");
const [[requester]] = await db.query("SELECT uuid, email, organization, org_role FROM users WHERE id=2");
const [[vOrg]] = await db.query("SELECT uuid, name FROM organizations WHERE id=?", [verifier.organization]);
const [[rOrg]] = await db.query("SELECT uuid, name FROM organizations WHERE id=?", [requester.organization]);

const verifierToken = await tokenFor(verifier);
const requesterToken = await tokenFor(requester);

console.log("=".repeat(80));
console.log("LIVE END-TO-END VERIFICATION TEST");
console.log("=".repeat(80));
console.log(`  requester : user#2 ${requester.email}  (org ${rOrg.name})`);
console.log(`  verifier  : user#1 ${verifier.email}  (org ${vOrg.name})`);
console.log(`  fixtures  : ${DATA}`);
console.log(`  run tag   : ${TAG}`);

const createdRequests = [];
let createdEmployeeUuid = null;
let createdEmployeeEmail = null;

// â”€â”€â”€ SETUP: an employee in the verifying org, with a reference document â”€â”€â”€â”€â”€
async function setup() {
  const email = `e2e.ref.${TAG}@test.local`;
  createdEmployeeEmail = email;
  const r = await api("POST", "/org/employees", {
    token: verifierToken,
    body: {
      full_name: OWNER_X,
      cnic: CNIC_X,
      email,
      phone: "0300" + Math.floor(1000000 + Math.random() * 8999999),
      designation: "Software Engineer",
      joining_date: "2024-01-01",
    },
  });
  if (r.status !== 201 && r.status !== 200) {
    throw new Error(`employee create failed: ${r.status} ${JSON.stringify(r.data)}`);
  }
  createdEmployeeUuid = r.data?.data?.employee?.uuid || r.data?.data?.uuid;
  if (!createdEmployeeUuid) throw new Error(`no employee uuid in response: ${JSON.stringify(r.data)}`);
  console.log(`\n  setup: employee ${OWNER_X} (CNIC ${CNIC_X}) created in ${vOrg.name}`);

  if (!REFERENCE_UPLOAD_SUPPORTED) {
    console.log("  setup: SKIPPED reference document upload (schema drift â€” see note below)");
    return;
  }

  // The reference document: a real letter that PRINTS CNIC X. Deliberately a
  // DIFFERENT file from the scenario-A replay fixture — if they were the same
  // bytes, A1's "first submission must go to review" would be short-circuited by
  // the reference-match exact-hash fast path and would stop testing anything.
  const fd = new FormData();
  fd.append(
    "documents",
    new File([fs.readFileSync(path.join(DATA, "letter_ref_a.pdf"))], "letter_ref_a.pdf", { type: "application/pdf" })
  );
  fd.append("document_type", "Offer Letter");
  const d = await api("POST", `/org/employees/${createdEmployeeUuid}/documents`, {
    token: verifierToken,
    form: fd,
  });
  if (d.status !== 201 && d.status !== 200) {
    throw new Error(`reference upload failed: ${d.status} ${JSON.stringify(d.data)}`);
  }
  console.log("  setup: reference document uploaded (letter_ref_a.pdf, prints CNIC " + CNIC_X + ")");
}

async function submit({ file, documentType, ownerName, ownerCnic }) {
  const r = await api("POST", "/verification-requests", {
    token: requesterToken,
    form: pdfForm({ file, documentType, orgUuid: vOrg.uuid, ownerName, ownerCnic }),
  });
  if (r.status !== 201) {
    return { ok: false, status: r.status, data: r.data };
  }
  const req = r.data?.data?.request ?? r.data?.request ?? r.data?.data;
  createdRequests.push(req.uuid);
  return { ok: true, status: r.status, req, auto: r.data?.data?.auto_verified };
}

async function approve(uuid) {
  return api("PATCH", `/verification-requests/${uuid}/verify`, {
    token: verifierToken,
    body: { status: "verified", verification_remarks: "e2e live test approval" },
  });
}

async function dbState(uuid) {
  const [rows] = await db.query(
    `SELECT status, verification_method, match_status, match_confidence, linked_person_id,
            document_validation_status
       FROM verification_requests WHERE uuid=?`,
    [uuid]
  );
  return rows[0] || null;
}

async function inVerifierInbox() {
  // Paginated shape: ok(res, paginatedResponse(...)) -> data.items
  const r = await api("GET", "/verification-requests/my/inbox?limit=100", { token: verifierToken });
  const data = r.data?.data;
  return Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
}

try {
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  console.log("\n" + "-".repeat(80));
  console.log("SETUP");
  console.log("-".repeat(80));
  await setup();

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  console.log("\n" + "-".repeat(80));
  console.log("A. DOCUMENT REPLAY â€” same bytes, different person");
  console.log("-".repeat(80));

  // A1: the first, honest submission. Must go to a human.
  const a1 = await submit({ file: "letter_replay_a.pdf", documentType: "Offer Letter", ownerName: OWNER_X, ownerCnic: CNIC_X });
  check(
    "A1 first submission of the letter goes to review, not auto-verified",
    a1.ok && a1.req.status === "under_review",
    a1.ok ? `status=${a1.req.status} method=${a1.req.verification_method} auto_verified=${a1.auto}` : `HTTP ${a1.status} ${JSON.stringify(a1.data)}`
  );

  // A2: the reviewer approves it FOR CNIC X. This is the "prior approval" the
  //     replay attack tries to borrow.
  const ap = await approve(a1.req.uuid);
  const a1state = await dbState(a1.req.uuid);
  check(
    "A2 reviewer approves it for CNIC X",
    ap.status === 200 && a1state?.status === "verified",
    `HTTP ${ap.status} db_status=${a1state?.status} method=${a1state?.verification_method}`
  );

  // A3: THE REPLAY. Identical bytes, a DIFFERENT person's CNIC.
  const a3 = await submit({ file: "letter_replay_a.pdf", documentType: "Offer Letter", ownerName: OWNER_Y, ownerCnic: CNIC_Y });
  const a3state = a3.ok ? await dbState(a3.req.uuid) : null;
  check(
    "A3 REPLAY: same document + DIFFERENT CNIC must NOT auto-verify",
    a3.ok && a3state?.status === "under_review" && a3state?.verification_method !== "auto",
    a3.ok
      ? `status=${a3state?.status} method=${a3state?.verification_method} match_status=${a3state?.match_status} auto_verified=${a3.auto}`
      : `HTTP ${a3.status} ${JSON.stringify(a3.data)}`
  );
  check(
    "A3b REPLAY produced no QR certificate for the wrong person",
    a3.ok && !a3.req.qr_token,
    a3.ok ? `qr_token=${a3.req.qr_token}` : "n/a"
  );

  // A4: positive control â€” the SAME person may re-submit and still auto-verify.
  const a4 = await submit({ file: "letter_replay_a.pdf", documentType: "Offer Letter", ownerName: OWNER_X, ownerCnic: CNIC_X });
  const a4state = a4.ok ? await dbState(a4.req.uuid) : null;
  check(
    "A4 CONTROL: same document + SAME CNIC still auto-verifies",
    a4.ok && a4state?.status === "verified" && a4state?.verification_method === "auto",
    a4.ok ? `status=${a4state?.status} method=${a4state?.verification_method} auto_verified=${a4.auto}` : `HTTP ${a4.status} ${JSON.stringify(a4.data)}`
  );

  // A5: the replay must actually be visible to the reviewer, not silently dropped.
  const inbox = await inVerifierInbox();
  const a3uuid = a3.req?.uuid;
  check(
    "A5 the replayed request is sitting in the reviewer's inbox",
    inbox.some((x) => x.uuid === a3uuid),
    `inbox size=${inbox.length}, replay present=${inbox.some((x) => x.uuid === a3uuid)}`
  );

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  console.log("\n" + "-".repeat(80));
  console.log("B. REFERENCE MATCH â€” a document whose printed CNIC is the wrong person");
  console.log("-".repeat(80));

  if (!REFERENCE_UPLOAD_SUPPORTED) {
    skip(
      "B1/B2 reference-match scenarios",
      `employee_documents is missing ${missingRefColumns.join(", ")} â€” migration ` +
        `backend/migrations/20260928_reference_document_canonical_fields.sql has not been applied ` +
        `to this database, so uploading a reference document 500s. This is pre-existing ` +
        `environment drift, not a result of the code under test.`
    );
  } else {
    // B1: the employee has a reference printing CNIC X. Submit a CNIC card that
    //     PRINTS CNIC Y while claiming to be X. Staging finds the reference by the
    //     claimed CNIC, so the comparison definitely runs.
    const b1 = await submit({ file: "cnic_card_b.pdf", documentType: "CNIC / National ID Copy", ownerName: OWNER_X, ownerCnic: CNIC_X });
    const b1state = b1.ok ? await dbState(b1.req.uuid) : null;
    check(
      "B1 submission printing a DIFFERENT CNIC does not auto-verify",
      b1.ok && b1state?.status !== "verified",
      b1.ok
        ? `status=${b1state?.status} method=${b1state?.verification_method} match_status=${b1state?.match_status} confidence=${b1state?.match_confidence}`
        : `HTTP ${b1.status} ${JSON.stringify(b1.data)}`
    );
    check(
      "B1b it is routed to a human rather than abandoned",
      b1.ok && ["manual_review", "not_attempted", "no_reference_found"].includes(b1state?.match_status),
      b1.ok ? `match_status=${b1state?.match_status}` : "n/a"
    );

    // B2: positive control â€” a CNIC card printing the SAME CNIC must auto-verify.
    const b2 = await submit({ file: "cnic_card_a.pdf", documentType: "CNIC / National ID Copy", ownerName: OWNER_X, ownerCnic: CNIC_X });
    const b2state = b2.ok ? await dbState(b2.req.uuid) : null;
    check(
      "B2 CONTROL: submission printing the SAME CNIC auto-verifies",
      b2.ok && b2state?.status === "verified",
      b2.ok ? `status=${b2state?.status} method=${b2state?.verification_method} auto_verified=${b2.auto}` : `HTTP ${b2.status} ${JSON.stringify(b2.data)}`
    );
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  console.log("\n" + "-".repeat(80));
  console.log("C. IDENTITY-POOR DOCUMENT TYPE â€” an NDA");
  console.log("-".repeat(80));

  if (!REFERENCE_UPLOAD_SUPPORTED) {
    skip("C1 NDA scenario", "depends on the reference-upload path, which is blocked by the same schema drift");
  } else {
    const c1 = await submit({ file: "nda_a.pdf", documentType: "NDA â€” Non-Disclosure Agreement", ownerName: OWNER_X, ownerCnic: CNIC_X });
    const c1state = c1.ok ? await dbState(c1.req.uuid) : null;
    check(
      "C1 an NDA is never auto-verified on a name match alone",
      c1.ok && c1state?.status !== "verified",
      c1.ok ? `status=${c1state?.status} method=${c1state?.verification_method} match_status=${c1state?.match_status}` : `HTTP ${c1.status} ${JSON.stringify(c1.data)}`
    );
  }
} catch (err) {
  console.error("\n!! TEST RUN ERROR:", err.message);
  results.push({ label: "test run completed without error", pass: false, detail: err.message });
} finally {
  // â”€â”€â”€ CLEANUP â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (!KEEP && createdRequests.length) {
    const ids = createdRequests.map((u) => u);
    const personIds = [];
    for (const uuid of ids) {
      const [r] = await db.query("SELECT linked_person_id FROM verification_requests WHERE uuid=?", [uuid]);
      if (r[0]?.linked_person_id) personIds.push(r[0].linked_person_id);
    }
    await db.query(`DELETE FROM person_documents WHERE verified_by_verification_request_id IN (SELECT id FROM verification_requests WHERE uuid IN (${ids.map(() => "?").join(",")}))`, ids);
    await db.query(`DELETE FROM verification_requests WHERE uuid IN (${ids.map(() => "?").join(",")})`, ids);
    if (personIds.length) {
      const ph = personIds.map(() => "?").join(",");
      await db.query(`DELETE FROM person_documents WHERE person_id IN (${ph})`, personIds);
      await db.query(`DELETE FROM persons WHERE id IN (${ph})`, personIds);
    }
    console.log(`\n  cleanup: removed ${ids.length} test verification request(s)`);
  }
  if (!KEEP && createdEmployeeUuid) {
    // Creating an employee WITH an email also provisions a platform `users` row
    // (and an invite_tokens row), so all three have to go or the next run hits a
    // CNIC-uniqueness 409.
    const [userRows] = await db.query("SELECT uuid FROM users WHERE email=?", [createdEmployeeEmail]);
    for (const u of userRows) {
      for (const t of ["invite_tokens", "notifications", "login_otps", "login_history", "refresh_tokens"]) {
        await db.query(`DELETE FROM \`${t}\` WHERE user_uuid=?`, [u.uuid]).catch(() => {});
      }
      await db.query("DELETE FROM users WHERE uuid=?", [u.uuid]);
    }
    await db.query("DELETE FROM employee_documents WHERE employee_uuid=?", [createdEmployeeUuid]);
    await db.query("DELETE FROM employees WHERE uuid=?", [createdEmployeeUuid]);
    console.log(`  cleanup: removed the test employee${userRows.length ? " and its provisioned user" : ""}`);
  }
  await db.end();
}

// â”€â”€â”€ SUMMARY â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const failed = results.filter((r) => !r.pass);
console.log("\n" + "=".repeat(80));
console.log(`SUMMARY: ${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("\nFAILED:");
  for (const f of failed) console.log(`  - ${f.label}`);
}
console.log("=".repeat(80));
process.exit(failed.length ? 1 : 0);
