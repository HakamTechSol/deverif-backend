/** Remove any leftover rows from interrupted e2e live-test runs (FK-safe order). */
import fs from "node:fs";
import path from "node:path";
import mysql from "mysql2/promise";
import dotenv from "dotenv";

dotenv.config({ quiet: true });
const { DOCS_DIR } = await import("../src/config/uploadPaths.js");

const c = await mysql.createConnection({
  host: "localhost",
  user: "root",
  password: "",
  database: "verification_app",
});

async function wipeTestUser(uuid) {
  // Child tables first — invite_tokens references users.
  for (const t of ["invite_tokens", "notifications", "login_otps", "login_history", "refresh_tokens"]) {
    try {
      await c.query(`DELETE FROM \`${t}\` WHERE user_uuid=?`, [uuid]);
    } catch {
      /* table or column may not exist; not fatal */
    }
  }
  await c.query("DELETE FROM users WHERE uuid=?", [uuid]);
}

const [users] = await c.query(
  "SELECT uuid, full_name, email FROM users WHERE email LIKE 'e2e.ref.%@test.local'"
);
console.log(`leftover test users: ${users.length}`);
for (const u of users) console.log(`  ${u.uuid}  ${u.full_name}  ${u.email}`);

const [emps] = await c.query(
  "SELECT uuid, full_name, cnic FROM employees WHERE email LIKE 'e2e.ref.%@test.local' OR cnic='4210112345671'"
);
console.log(`leftover test employees: ${emps.length}`);

for (const e of emps) {
  const [docs] = await c.query("SELECT id, file_path FROM employee_documents WHERE employee_uuid=?", [e.uuid]);
  for (const d of docs) {
    const p = path.join(DOCS_DIR, path.basename(d.file_path || ""));
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
  }
  await c.query("DELETE FROM employee_documents WHERE employee_uuid=?", [e.uuid]);
  await c.query("DELETE FROM employees WHERE uuid=?", [e.uuid]);
  console.log(`  removed employee ${e.uuid} (+${docs.length} doc rows, files deleted)`);
}

for (const u of users) {
  await wipeTestUser(u.uuid);
  console.log(`  removed user ${u.uuid}`);
}

// Any verification requests / person rows belonging to the two test CNICs.
const [p] = await c.query(
  "SELECT id, full_name FROM persons WHERE cnic_hash IN (SHA2('4210112345671',256), SHA2('3520276543219',256))"
);
console.log(`\ntest person rows: ${p.length}`);
for (const x of p) {
  await c.query("DELETE FROM person_documents WHERE person_id=?", [x.id]);
  await c.query("DELETE FROM verification_requests WHERE linked_person_id=?", [x.id]);
  await c.query("DELETE FROM persons WHERE id=?", [x.id]);
  console.log(`  removed person ${x.id} (${x.full_name}) and its requests/ledger rows`);
}

await c.end();
console.log("\ncleanup done");
