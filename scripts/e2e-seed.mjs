import mysql from "mysql2/promise";
import bcrypt from "bcryptjs";
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

const uuid = () => crypto.randomUUID();
const hash = (p) => bcrypt.hashSync(p, 10);

// Clean any previous e2e seed
const [prevOrgs] = await conn.query("SELECT id FROM organizations WHERE name='AUDIT E2E ORG'");
for (const o of prevOrgs) {
  await conn.query("DELETE FROM employees WHERE organization_id=?", [o.id]);
  await conn.query("DELETE FROM leave_types WHERE organization_id=?", [o.id]);
}
await conn.query("DELETE FROM users WHERE email LIKE 'audit-%@test.local'");
await conn.query("DELETE FROM admin_profiles WHERE email='audit-admin@test.local'");

// Org (idempotent)
let ORG_ID;
{
  const [existing] = await conn.query("SELECT id FROM organizations WHERE name='AUDIT E2E ORG'");
  if (existing.length) {
    ORG_ID = existing[0].id;
  } else {
    await conn.query(
      "INSERT INTO organizations (name, verified, organization_type, business_email, subscription_status, subscription_plan) VALUES ('AUDIT E2E ORG','yes','software_house','e2e-org@test.local','active','basic')"
    );
    const [[org]] = await conn.query("SELECT id FROM organizations WHERE name='AUDIT E2E ORG'");
    ORG_ID = org.id;
  }
}

// Platform admin
await conn.query(
  "INSERT INTO admin_profiles (uuid,email,password,full_name,status,preferred_language) VALUES (?, 'audit-admin@test.local', ?, 'Audit Platform Admin','active','en')",
  [uuid(), hash("AuditAdmin#123")]
);

// Users
async function mkUser(email, pass, name, organization, orgRole, cnic) {
  const u = uuid();
  await conn.query(
    "INSERT INTO users (uuid,email,password,full_name,cnic,status,org_role,preferred_language,subscription_plan,is_verified,organization) VALUES (?,?,?,?, ?, 'active', ?, 'en','free','yes', ?)",
    [u, email, hash(pass), name, cnic, orgRole || "member", organization]
  );
  const [[row]] = await conn.query("SELECT id, uuid FROM users WHERE email=?", [email]);
  return row;
}

const orgAdmin = await mkUser("audit-orgadmin@test.local", "AuditOrg#123", "Audit OrgAdmin", ORG_ID, "org_admin", "90000-1111111-1");
const member = await mkUser("audit-member@test.local", "AuditMember#123", "Audit Member", ORG_ID, null, "90000-2222222-2");
const plain = await mkUser("audit-plain@test.local", "AuditPlain#123", "Audit Plain User", null, null, "90000-4444444-4");

// Employees: linked for orgAdmin + member; one unlinked employee for CRUD
async function mkEmp(name, email, cnic, linkedUuid) {
  const u = uuid();
  await conn.query(
    "INSERT INTO employees (uuid,organization_id,full_name,email,cnic,designation,department,status,is_platform_user,linked_user_uuid) VALUES (?,?,?,?,?,'Engineer','Eng','active','no',?)",
    [u, ORG_ID, name, email, cnic, linkedUuid || null]
  );
  const [[row]] = await conn.query("SELECT id, uuid FROM employees WHERE email=?", [email]);
  return row;
}

const empOrgAdmin = await mkEmp("Audit OrgAdmin", "audit-orgadmin@test.local", "90000-1111111-1", orgAdmin.uuid);
const empMember = await mkEmp("Audit Member", "audit-member@test.local", "90000-2222222-2", member.uuid);
const empPlain = await mkEmp("Plain Employee", "audit-plain-emp@test.local", "90000-3333333-3", null);

// Leave types + balances
await conn.query("INSERT INTO leave_types (organization_id,name,days_allowed_per_year) VALUES (?, 'Annual', 20), (?, 'Sick', 10)", [ORG_ID, ORG_ID]);

console.log(JSON.stringify({ ORG_ID, orgAdmin, member, plain, empOrgAdmin, empMember, empPlain }));
await conn.end();
