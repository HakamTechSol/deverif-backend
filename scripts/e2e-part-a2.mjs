import fs from "fs";
import { api, getTokens } from "./e2e-lib.mjs";

const out = [];
const t = (s) => out.push(s);
const show = (label, r, extra) => {
  const msg = r.data?.message ?? r.data?.error ?? "";
  t(`${label}: HTTP ${r.status}${msg ? " — " + msg : ""}${extra ? " | " + extra : ""}`);
};

const { admin: adminToken, org: orgToken } = await getTokens();

t("\n=== 3. USERS (corrected payloads) ===");
// create user WITH organization (as the UI does)
const created = await api("POST", "/admin/users", {
  token: adminToken,
  body: {
    organization: { name: "AUDIT E2E ORG" },
    user: { full_name: "E2E Created User", email: "audit-created-user@test.local", cnic: "90000-5555555-5", phone: "+923001112223" },
  },
});
show("create user (+existing org)", created);
const newUserId = created.data?.data?.user?.uuid;

const dup = await api("POST", "/admin/users", {
  token: adminToken,
  body: {
    organization: { name: "AUDIT E2E ORG" },
    user: { full_name: "Dup User", email: "audit-created-user@test.local", cnic: "90000-5555555-5" },
  },
});
show("create duplicate user (expect clear error)", dup);

const search = await api("GET", "/admin/users?page=1&limit=10&search=E2E Created", { token: adminToken });
show("search users", search, `found=${search.data?.data?.total}`);

// status toggle must not erase other fields
const before = search.data?.data?.items?.[0];
t(`before toggle: name=${before?.full_name} phone=${before?.phone} status=${before?.status} is_verified=${before?.is_verified}`);
const toggled = await api("PUT", `/admin/users/${newUserId}`, {
  token: adminToken,
  body: { status: "active" },
});
show("toggle status -> active", toggled);
const after = (await api("GET", `/admin/users?page=1&limit=10&search=E2E Created`, { token: adminToken })).data?.data?.items?.[0];
t(`after toggle: name=${after?.full_name} phone=${after?.phone} status=${after?.status} email=${after?.email} cnic=${after?.cnic ? "intact" : "ERASED"}`);
t(`INTEGRITY: ${after?.full_name === before?.full_name && after?.phone === before?.phone && after?.cnic ? "PASS — no fields erased" : "FAIL — fields lost!"}`);

const edited = await api("PUT", `/admin/users/${newUserId}`, {
  token: adminToken,
  body: { full_name: "E2E Created User Edited" },
});
show("edit user name", edited, `name=${edited.data?.data?.user?.full_name}`);

const deleted = await api("DELETE", `/admin/users/${newUserId}`, { token: adminToken });
show("delete user", deleted);

fs.writeFileSync("./e2e-results-users.json", JSON.stringify(out, null, 2));
console.log(out.join("\n"));
