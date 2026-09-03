import fs from "fs";
import { api, log, getTokens } from "./e2e-lib.mjs";

const out = [];
const t = (s) => out.push(s);
const show = (label, r, extra) => {
  const msg = r.data?.message ?? r.data?.error ?? "";
  const line = `${label}: HTTP ${r.status}${msg ? " — " + msg : ""}${extra ? " | " + extra : ""}`;
  t(line);
};

// ─── Logins ───
const { admin: adminToken, org: orgToken, plain: plainToken } = await getTokens();
t(`tokens acquired: admin=${!!adminToken} org=${!!orgToken} plain=${!!plainToken}`);

// ─── 2. DASHBOARD ───
t("\n=== 2. DASHBOARD ===");
{
  const r = await api("GET", "/dashboard", { token: adminToken });
  show("GET /dashboard (admin)", r, `total_users=${r.data?.data?.total_users} total_orgs=${r.data?.data?.total_organizations}`);
  const r2 = await api("GET", "/dashboard/user", { token: orgToken });
  show("GET /dashboard/user (org-admin)", r2, JSON.stringify(r2.data?.data)?.slice(0, 120));
  const r3 = await api("GET", "/dashboard/user", { token: plainToken });
  show("GET /dashboard/user (plain)", r3);
}

// ─── 3. USERS ───
t("\n=== 3. USERS ===");
let newUserId;
{
  const list = await api("GET", "/admin/users?page=1&limit=10", { token: adminToken });
  show("list users", list, `total=${list.data?.data?.total}`);

  const created = await api("POST", "/admin/users", {
    token: adminToken,
    body: { full_name: "E2E Test User", email: "audit-created-user@test.local", cnic: "90000-5555555-5" },
  });
  show("create user", created);
  newUserId = created.data?.data?.user?.uuid;

  const dup = await api("POST", "/admin/users", {
    token: adminToken,
    body: { full_name: "Dup", email: "audit-created-user@test.local", cnic: "90000-5555555-5" },
  });
  show("create duplicate user (expect clear error)", dup);

  const search = await api("GET", "/admin/users?page=1&limit=10&search=E2E", { token: adminToken });
  show("search users 'E2E'", search, `found=${search.data?.data?.total}`);

  // status toggle must not erase other fields
  const before = (await api("GET", `/admin/users?page=1&limit=50&search=audit-created-user`, { token: adminToken })).data?.data?.items?.[0];
  const toggled = await api("PATCH", `/admin/users/${newUserId}/org-role`, {
    token: adminToken,
    body: { org_role: "member" },
  });
  show("set org_role=member", toggled);
  const after = (await api("GET", `/admin/users?page=1&limit=50&search=audit-created-user`, { token: adminToken })).data?.data?.items?.[0];
  t(`status-toggle integrity: name before="${before?.full_name}" after="${after?.full_name}" email intact=${after?.email === "audit-created-user@test.local"} cnic intact=${!!after?.cnic}`);

  const edited = await api("PUT", `/admin/users/${newUserId}`, {
    token: adminToken,
    body: { full_name: "E2E Test User Edited", phone: "+923001112223" },
  });
  show("edit user", edited, `name=${edited.data?.data?.user?.full_name}`);

  const deleted = await api("DELETE", `/admin/users/${newUserId}`, { token: adminToken });
  show("delete user", deleted);

  // pagination
  const p2 = await api("GET", "/admin/users?page=2&limit=2", { token: adminToken });
  show("pagination page=2 limit=2", p2, `items=${p2.data?.data?.items?.length} totalPages=${p2.data?.data?.totalPages}`);

  // permission: org-admin should NOT access admin user management
  const forbidden = await api("GET", "/admin/users", { token: orgToken });
  show("org-admin GET /admin/users (expect 401/403)", forbidden);
}

// ─── 4. EMPLOYEES ───
t("\n=== 4. EMPLOYEES ===");
let empUuid;
{
  const listA = await api("GET", "/admin/employees?page=1&limit=10", { token: adminToken });
  show("admin list employees", listA, `total=${listA.data?.data?.total}`);
  const first = listA.data?.data?.items?.[0];
  if (first) t(`added_by populated: added_by_name=${first.added_by_name ?? "(null)"} promoted_by_name=${first.promoted_by_name ?? "(null)"}`);

  const created = await api("POST", "/org/employees", {
    token: orgToken,
    body: { full_name: "New Emp E2E", email: "audit-new-emp@test.local", cnic: "90000-6666666-6", designation: "QA", department: "Eng" },
  });
  show("org-admin create employee", created);
  empUuid = created.data?.data?.employee?.uuid;

  const updated = await api("PUT", `/org/employees/${empUuid}`, {
    token: orgToken,
    body: { full_name: "New Emp E2E Updated", email: "audit-new-emp@test.local", cnic: "90000-6666666-6", designation: "Senior QA", department: "Eng" },
  });
  show("org-admin edit employee", updated, `designation=${updated.data?.data?.employee?.designation}`);

  const scoped = await api("GET", "/org/employees?page=1&limit=100", { token: orgToken });
  const foreignEmails = (scoped.data?.data?.items ?? []).filter((e) => e.email === "audit-plain@test.local");
  show("org scoping check (no foreign employees)", scoped, `foreignLeaked=${foreignEmails.length} totalInOrg=${scoped.data?.data?.total}`);

  // promote flow
  const promoted = await api("POST", `/org/employees/${empUuid}/promote`, { token: orgToken });
  show("org-admin promote employee", promoted, `warning=${promoted.data?.data?._email_warning ?? "none"}`);

  const asUserList = await api("GET", "/admin/users?page=1&limit=20&search=audit-new-emp", { token: adminToken });
  show("promoted employee appears in Users", asUserList, `found=${asUserList.data?.data?.total}`);

  const empAfter = await api("GET", "/org/employees?page=1&limit=100&search=audit-new-emp", { token: orgToken });
  const pe = empAfter.data?.data?.items?.[0];
  t(`promoted flags: is_platform_user=${pe?.is_platform_user} linked_user=${pe?.linked_user_uuid ? "yes" : "no"} promoted_by_name=${pe?.promoted_by_name ?? "(null)"}`);

  // delete platform-linked employee must be blocked
  const delBlocked = await api("DELETE", `/org/employees/${empUuid}`, { token: orgToken });
  show("delete platform-user employee (expect block)", delBlocked);

  // delete non-platform employee
  const mk = await api("POST", "/org/employees", {
    token: orgToken,
    body: { full_name: "Deletable Emp", email: "audit-del-emp@test.local", cnic: "90000-7777777-7" },
  });
  const delOk = await api("DELETE", `/org/employees/${mk.data?.data?.employee?.uuid}`, { token: orgToken });
  show("delete non-platform employee", delOk);

  // IDOR: plain user hitting org endpoints
  const idor = await api("GET", "/org/employees", { token: plainToken });
  show("plain user GET /org/employees (expect 403)", idor);

  // admin cannot use org-scoped route without org context
  const adminOnOrg = await api("GET", "/org/employees", { token: adminToken });
  show("platform admin GET /org/employees (expect 400/403)", adminOnOrg);
}

fs.writeFileSync("./e2e-results-a.json", JSON.stringify(out, null, 2));
console.log(out.join("\n"));

