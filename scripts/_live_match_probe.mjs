/**
 * Live proof that the RUNNING document service carries the identity-binding
 * code, using REAL PDFs (so the genuine render + Tesseract OCR path runs, not
 * a text-file shortcut).
 *
 * Usage: node scripts/_live_match_probe.mjs
 */
import fs from "node:fs";
import path from "node:path";

function readApiKey() {
  const envPath = path.resolve(process.cwd(), "../python-backend/.env");
  const text = fs.readFileSync(envPath, "utf8");
  const line = text.split(/\r?\n/).find((l) => l.trim().startsWith("DOC_SERVICE_API_KEY="));
  if (!line) throw new Error("DOC_SERVICE_API_KEY not found in python-backend/.env");
  return line.split("=").slice(1).join("=").trim();
}

const API_KEY = readApiKey();
const BASE = process.env.DOC_SERVICE_URL || "http://localhost:5001";
const HEADERS = { "X-API-Key": API_KEY };
const DATA = path.resolve(process.cwd(), "_testdata");

function fixture(name) {
  const p = path.join(DATA, name);
  return new File([fs.readFileSync(p)], name, { type: "application/pdf" });
}

async function postMatch({ a, b, typeA, typeB }) {
  const fd = new FormData();
  fd.append("file_a", fixture(a));
  fd.append("file_b", fixture(b));
  fd.append("document_type_a", typeA);
  fd.append("document_type_b", typeB);
  const res = await fetch(`${BASE}/match`, { method: "POST", headers: HEADERS, body: fd });
  return { status: res.status, body: await res.json() };
}

function show(label, expected, r) {
  const d = r.body?.data || {};
  const actual = `match=${d.match} conf=${d.confidence} identity_mismatch=${d.identity_mismatch} auto_match_eligible=${d.auto_match_eligible}`;
  console.log(`\n--- ${label}`);
  console.log(`    HTTP ${r.status}  ${actual}`);
  for (const reason of d.reasons || []) console.log(`      * ${reason}`);
  return d;
}

console.log("=".repeat(78));
console.log("LIVE /match PROBE — real PDFs, real Tesseract OCR, running service");
console.log("=".repeat(78));

const d1 = show(
  "same CNIC, same letter (EXPECT match=true, eligible=true)",
  null,
  await postMatch({
    a: "letter_cnic_a.pdf",
    b: "letter_cnic_a.pdf",
    typeA: "Offer Letter",
    typeB: "Offer Letter",
  })
);

const d2 = show(
  "DIFFERENT printed CNICs, everything else identical (EXPECT match=false, identity_mismatch=true)",
  null,
  await postMatch({
    a: "letter_cnic_a.pdf",
    b: "letter_cnic_b.pdf",
    typeA: "Offer Letter",
    typeB: "Offer Letter",
  })
);

const d3 = show(
  "CNIC on one side only (EXPECT identity_mismatch=true, not a clean 100)",
  null,
  await postMatch({
    a: "letter_cnic_a.pdf",
    b: "letter_no_cnic.pdf",
    typeA: "Offer Letter",
    typeB: "Offer Letter",
  })
);

const d4 = show(
  "two CNIC cards, different numbers (EXPECT match=false, conf=0)",
  null,
  await postMatch({
    a: "cnic_card_a.pdf",
    b: "cnic_card_b.pdf",
    typeA: "CNIC / National ID Copy",
    typeB: "CNIC / National ID Copy",
  })
);

const d5 = show(
  "same CNIC card twice (EXPECT match=true, conf=100)",
  null,
  await postMatch({
    a: "cnic_card_a.pdf",
    b: "cnic_card_a.pdf",
    typeA: "CNIC / National ID Copy",
    typeB: "CNIC / National ID Copy",
  })
);

const d6 = show(
  "NDA vs a DIFFERENT person's NDA (EXPECT auto_match_eligible=false, conf=0)",
  null,
  await postMatch({
    a: "nda_a.pdf",
    b: "nda_b.pdf",
    typeA: "NDA — Non-Disclosure Agreement",
    typeB: "NDA — Non-Disclosure Agreement",
  })
);

const d7 = show(
  "CNIC card submitted against a CNIC-less letter reference (EXPECT not a clean match)",
  null,
  await postMatch({
    a: "cnic_card_a.pdf",
    b: "letter_no_cnic.pdf",
    typeA: "CNIC / National ID Copy",
    typeB: "Offer Letter",
  })
);

console.log("\n" + "=".repeat(78));
const checks = [
  ["same identity is clean", d1.match === true && d1.auto_match_eligible === true && d1.identity_mismatch === false],
  ["differing CNIC blocked", d2.match === false && d2.identity_mismatch === true && d2.auto_match_eligible === false],
  ["one-sided CNIC blocked", d3.identity_mismatch === true && d3.auto_match_eligible === false],
  ["two different CNIC cards rejected", d4.match === false && d4.confidence === 0],
  ["same CNIC card matches", d5.match === true && d5.confidence === 100],
  ["identity-poor type never eligible", d6.auto_match_eligible === false && d6.confidence === 0],
  ["CNIC vs CNIC-less reference not clean", d7.confidence < 100 && d7.auto_match_eligible === false],
];
console.log("\nVERDICT");
let ok = true;
for (const [label, pass] of checks) {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}`);
  if (!pass) ok = false;
}
console.log(`\n${ok ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED"}`);
process.exit(ok ? 0 : 1);
