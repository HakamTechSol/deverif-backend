import mysql from "mysql2/promise";
import crypto from "crypto";
import dotenv from "dotenv";

dotenv.config();

const conn = await mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: +(process.env.DB_PORT || 3306),
});

// Seed org (removed during cleanup) — idempotent
let ORG_ID;
{
  const [existing] = await conn.query("SELECT id FROM organizations WHERE name='AUDIT SEED ORG'");
  if (existing.length) {
    ORG_ID = existing[0].id;
  } else {
    const [orgRes] = await conn.query(
      "INSERT INTO organizations (name, verified, organization_type) VALUES ('AUDIT SEED ORG', 'yes', 'software_house')"
    );
    ORG_ID = orgRes.insertId;
  }
}

const N_EMP = 3000;
const N_ATT = 15000;
const N_LEAVE = 6000;
const N_SAL = 9000;
const N_AUDIT = 100000;
const N_LH = 5000;

// Reset any previous partial seed for this org so the script is idempotent
await conn.query("DELETE FROM attendance_records WHERE organization_id=?", [ORG_ID]);
await conn.query("DELETE FROM salary_records WHERE organization_id=?", [ORG_ID]);
await conn.query("DELETE FROM leave_balances WHERE employee_uuid IN (SELECT uuid FROM (SELECT uuid FROM employees WHERE organization_id=?) x)", [ORG_ID]);
await conn.query("DELETE FROM leave_requests WHERE employee_uuid IN (SELECT uuid FROM (SELECT uuid FROM employees WHERE organization_id=?) x)", [ORG_ID]);
await conn.query("DELETE FROM employees WHERE organization_id=?", [ORG_ID]);
await conn.query("DELETE FROM leave_types WHERE organization_id=?", [ORG_ID]);
await conn.query("DELETE FROM users WHERE email='seed-orgadmin@test.local'");
await conn.query("DELETE FROM audit_logs WHERE ip_address='39.45.1.2' AND actor_name LIKE 'Actor %'");
await conn.query("DELETE FROM login_history WHERE user_agent='Mozilla/5.0 seed'");

async function bulkInsert(table, columns, rows, chunk = 500) {
  const placeholders = `(${columns.map(() => "?").join(",")})`;
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    await conn.query(
      `INSERT INTO ${table} (${columns.join(",")}) VALUES ${slice.map(() => placeholders).join(",")}`,
      slice.flat()
    );
  }
}

const uuid = () => crypto.randomUUID();
const iso = (d) => d.toISOString().slice(0, 10);

// employees
const empUuids = [];
const empRows = [];
for (let i = 0; i < N_EMP; i++) {
  const u = uuid();
  empUuids.push(u);
  const created = new Date(Date.now() - Math.floor(Math.random() * 300) * 86400000);
  empRows.push([u, ORG_ID, `Employee ${i}`, `emp${i}@test.local`, null, `${100000 + i}-1234567-${i % 10}`, "Engineer", "Eng", "active", "no", null, null, null, null]);
}
await bulkInsert("employees", ["uuid","organization_id","full_name","email","phone","cnic","designation","department","status","is_platform_user","linked_user_uuid","added_by_uuid","promoted_by_uuid","promoted_at"], empRows);

// leave_types
const [lt] = await conn.query("INSERT INTO leave_types (organization_id,name,days_allowed_per_year) VALUES (?, 'Annual (seed)', 20)", [ORG_ID]);
const ltId = lt.insertId;

// leave_requests
const lrRows = [];
for (let i = 0; i < N_LEAVE; i++) {
  const s = new Date(Date.now() - Math.floor(Math.random() * 200) * 86400000);
  const e = new Date(s.getTime() + Math.floor(Math.random() * 5) * 86400000);
  lrRows.push([uuid(), empUuids[i % N_EMP], ltId, iso(s), iso(e), null, ["pending","approved","rejected"][i % 3], null, null]);
}
await bulkInsert("leave_requests", ["uuid","employee_uuid","leave_type_id","start_date","end_date","reason","status","approved_by","approved_at"], lrRows);

// attendance_records — deterministic distinct dates per employee (unique key safe)
const attRows = [];
for (let i = 0; i < N_ATT; i++) {
  const dayIndex = Math.floor(i / N_EMP); // 0..4 per employee
  const d = new Date(Date.now() - (dayIndex * 3 + 1) * 86400000);
  attRows.push([uuid(), empUuids[i % N_EMP], ORG_ID, d, d, "39.45.1.2", null, iso(d), i % 2 ? "checked_out" : "checked_in"]);
}
await bulkInsert("attendance_records", ["uuid","employee_uuid","organization_id","check_in_at","check_out_at","check_in_ip","check_out_ip","date","status"], attRows);

// salary_records — distinct (employee, year, month) per unique key
const salRows = [];
for (let i = 0; i < N_SAL; i++) {
  const e = i % N_EMP;
  const seq = Math.floor(i / N_EMP); // 0..2
  const y = 2024 + seq;
  const m = seq * 4 + (e % 4) + 1;
  salRows.push([uuid(), empUuids[e], ORG_ID, m, y, 100000, 5000, 2000, 103000, null, null]);
}
try {
  await bulkInsert("salary_records", ["uuid","employee_uuid","organization_id","month","year","basic_salary","allowances","deductions","net_salary","notes","created_by"], salRows);
} catch (e) {
  console.log("salary insert note:", e.message.slice(0, 80));
}

// audit_logs
const actions = ["request.create","request.verify","employee.create","leave.approve","attendance.check_in","template.create","salary_record.create"];
const audRows = [];
for (let i = 0; i < N_AUDIT; i++) {
  const ts = new Date(Date.now() - Math.floor(Math.random() * 365) * 86400000);
  audRows.push([uuid(), i % 5 === 0 ? "admin" : "user", i + 1, `Actor ${i % 500}`, actions[i % actions.length], "verification_request", uuid(), JSON.stringify({ i }), "39.45.1.2", ts]);
}
await bulkInsert("audit_logs", ["uuid","actor_type","actor_id","actor_name","action","entity_type","entity_id","details","ip_address","created_at"], audRows, 1000);

// login_history
const lhRows = [];
for (let i = 0; i < N_LH; i++) {
  const ts = new Date(Date.now() - Math.floor(Math.random() * 180) * 86400000);
  lhRows.push([uuid(), i % 7 === 0 ? "admin" : "user", (i % 50) + 1, "39.45.1." + (i % 250), "Mozilla/5.0 seed", ts, i % 4 === 0 ? "no" : "yes"]);
}
await bulkInsert("login_history", ["uuid","identity_type","identity_id","ip_address","user_agent","login_at","success"], lhRows);

// org-admin test user (for requireOrgAdmin endpoints)
const [ou] = await conn.query(
  "INSERT INTO users (full_name,email,phone,password,cnic,status,subscription_plan,subscription_expiry,organization,profile_image,is_verified,created_at,org_role) VALUES ('Seed OrgAdmin','seed-orgadmin@test.local',NULL,'x','99999-9999999-9','active','free',NULL,?,NULL,'yes',NOW(),'org_admin')",
  [ORG_ID]
);
const [[orgAdminUser]] = await conn.query("SELECT uuid FROM users WHERE id=?", [ou.insertId]);

// linked employee for the org-admin user (needed by leave/attendance controllers)
await conn.query(
  "INSERT INTO employees (uuid,organization_id,full_name,email,cnic,status,is_platform_user,linked_user_uuid) VALUES (?, ?, 'Seed OrgAdmin Emp','seed-orgadmin@test.local','99999-9999999-8','active','yes',?)",
  [uuid(), ORG_ID, orgAdminUser.uuid]
);

// leave balance row for approval tests
await conn.query(
  "INSERT INTO leave_balances (employee_uuid,leave_type_id,year,total_allocated,used,remaining) SELECT e.uuid, ?, YEAR(NOW()), 20, 0, 20 FROM employees e WHERE e.email='seed-orgadmin@test.local'",
  [ltId]
);

console.log(JSON.stringify({ orgAdminUser: orgAdminUser.uuid, leaveTypeId: ltId }));
await conn.end();
