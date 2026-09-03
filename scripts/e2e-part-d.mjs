import fs from "fs";
import { api, getTokens, login } from "./e2e-lib.mjs";

const out = [];
const t = (s) => out.push(s);
const show = (label, r, extra) => {
  const msg = r.data?.message ?? r.data?.error ?? "";
  t(`${label}: HTTP ${r.status}${msg ? " — " + msg : ""}${extra ? " | " + extra : ""}`);
};

const { admin: adminToken, org: orgToken, plain: plainToken } = await getTokens();

// ─── 15. LOGIN HISTORY ───
t("\n=== 15. LOGIN HISTORY ===");
{
  const list = await api("GET", "/admin/login-history?page=1&limit=10", { token: adminToken });
  show("list login history", list, `total=${list.data?.data?.total}`);
  const items = list.data?.data?.items ?? [];
  if (items.length) {
    t(`sample rows:`);
    for (const r of items.slice(0, 5)) {
      t(`  ${r.identity_type} id=${r.identity_id} ip=${r.ip_address} success=${r.success} at=${r.login_at}`);
    }
    const localhostOnly = items.every((r) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(r.ip_address || ""));
    t(`all IPs are loopback (expected on local run): ${localhostOnly}`);
    t(`user_agent captured: ${items[0].user_agent ? "yes (" + String(items[0].user_agent).slice(0, 40) + "...)" : "NO"}`);
  }

  const filtered = await api("GET", "/admin/login-history?page=1&limit=10&search=audit-admin", { token: adminToken });
  show("filter by search=audit-admin", filtered, `total=${filtered.filtered_total ?? filtered.data?.data?.total}`);
  const failed = await api("GET", "/admin/login-history?page=1&limit=10&success=no", { token: adminToken });
  show("filter success=no", failed, `total=${failed.data?.data?.total}`);
}

// ─── 16. ACTIVITY LOGS ───
t("\n=== 16. ACTIVITY LOGS ===");
{
  const list = await api("GET", "/admin/audit-logs?page=1&limit=10", { token: adminToken });
  show("list activity logs", list, `total=${list.data?.data?.total}`);
  const items = list.data?.data?.items ?? [];
  for (const r of items.slice(0, 8)) {
    t(`  [${r.created_at}] ${r.actor_type}/${r.actor_name}: ${r.action} -> ${r.entity_type} ${String(r.entity_id).slice(0, 8)}...`);
  }

  // walkthrough actions present?
  const recent = await api("GET", "/admin/audit-logs?page=1&limit=50", { token: adminToken });
  const acts = (recent.data?.data?.items ?? []).map((r) => r.action);
  const expected = ["employee.create", "employee.update", "template.create", "template.update", "leave.create", "leave.approve", "attendance.check_in", "attendance.check_out", "salary_record.create", "request.verify"];
  const missing = expected.filter((a) => !acts.includes(a));
  t(`walkthrough actions visible in last 50: ${acts.length} entries; missing from window: [${missing.join(", ") || "none"}]`);

  // actor+date filter (compound index path)
  const today = new Date().toISOString().slice(0, 10);
  const actorFiltered = await api("GET", `/admin/audit-logs?actor_type=user&date_from=${today}&page=1&limit=20`, { token: adminToken });
  const afItems = actorFiltered.data?.data?.items ?? [];
  show(`actor_type=user + date_from=${today}`, actorFiltered, `total=${actorFiltered.data?.data?.total} allUserActors=${afItems.every((i) => i.actor_type === "user")} allToday=${afItems.every((i) => i.created_at >= today)}`);

  // action+date filter (compound index path)
  const actionFiltered = await api("GET", `/admin/audit-logs?action=leave.approve&date_from=${today}&page=1&limit=20`, { token: adminToken });
  const acItems = actionFiltered.data?.data?.items ?? [];
  show(`action=leave.approve + date_from=${today}`, actionFiltered, `total=${actionFiltered.data?.data?.total} allCorrectAction=${acItems.every((i) => i.action === "leave.approve")}`);

  // actions dropdown endpoint
  const actionsList = await api("GET", "/admin/audit-logs/actions", { token: adminToken });
  show("distinct actions dropdown", actionsList, `count=${actionsList.data?.data?.items?.length}`);
}

// ─── 17. SETTINGS ───
t("\n=== 17. SETTINGS ===");
{
  // admin profile update
  const meBefore = await api("GET", "/admin/auth/me", { token: adminToken });
  t(`admin me before: name=${meBefore.data?.data?.admin?.full_name ?? meBefore.data?.data?.full_name} phone=${meBefore.data?.data?.admin?.phone ?? meBefore.data?.data?.phone}`);

  const upd = await api("PATCH", "/admin/auth/profile", {
    token: adminToken,
    body: { full_name: "Audit Platform Admin Jr.", phone: "+923009998887" },
  });
  show("admin profile update", upd);

  const meAfter = await api("GET", "/admin/auth/me", { token: adminToken });
  const a = meAfter.data?.data?.admin ?? meAfter.data?.data;
  t(`admin me after: name=${a?.full_name} phone=${a?.phone} (expect updated values)`);

  // user profile update (multipart like the UI)
  const fd = new FormData();
  fd.append("full_name", "Audit Plain User Updated");
  fd.append("phone", "+923007775554");
  const userUpd = await api("PATCH", "/users/me", { token: plainToken, form: fd });
  show("user profile update (name+phone)", userUpd);

  const me = await api("GET", "/users/me", { token: plainToken });
  t(`user me after: name=${me.data?.data?.user?.full_name} phone=${me.data?.data?.user?.phone}`);

  // language change + persistence across re-login
  const langUr = await api("PATCH", "/users/preferred-language", { token: plainToken, body: { language: "ur" } });
  show("user sets language=ur", langUr);
  const relogin = await login({ email: "audit-plain@test.local", password: "AuditPlain#123" });
  t(`after re-login: preferred_language=${relogin.me?.user?.preferred_language} name=${relogin.me?.user?.full_name} (persistence check)`);

  const adminLang = await api("PATCH", "/admin/auth/me/preferred-language", { token: adminToken, body: { language: "ur" } });
  show("admin sets language=ur", adminLang);
  const adminRelogin = await login({ email: "audit-admin@test.local", password: "AuditAdmin#123" });
  t(`admin after re-login: preferred_language=${adminRelogin.me?.user?.preferred_language}`);

  // restore languages
  await api("PATCH", "/users/preferred-language", { token: relogin.accessToken, body: { language: "en" } });
  await api("PATCH", "/admin/auth/me/preferred-language", { token: adminRelogin.accessToken, body: { language: "en" } });

  // password never returned anywhere
  t(`password field in any profile response: admin=${JSON.stringify(meAfter.data?.data).includes("password")} user=${JSON.stringify(me.data?.data).includes("password")}`);
}

// ─── LOGOUT ───
t("\n=== LOGOUT ===");
{
  const fresh = await login({ email: "audit-member@test.local", password: "AuditMember#123" });
  const tok = fresh.accessToken;
  const lo = await api("POST", "/auth/user/logout", { token: tok });
  show("logout", lo);
  const reuse = await api("GET", "/users/me", { token: tok });
  show("reuse token AFTER logout (expect 401)", reuse);
  const refreshAttempt = await api("POST", "/auth/refresh");
  show("refresh without cookie (expect 401)", refreshAttempt);
}

fs.writeFileSync("./e2e-results-d.json", JSON.stringify(out, null, 2));
console.log(out.join("\n"));
