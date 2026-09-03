import fs from "fs";
import mysql from "mysql2/promise";
import dotenv from "dotenv";
import { api, getTokens } from "./e2e-lib.mjs";

dotenv.config();
const out = [];
const t = (s) => out.push(s);
const show = (label, r, extra) => {
  const msg = r.data?.message ?? r.data?.error ?? "";
  t(`${label}: HTTP ${r.status}${msg ? " — " + msg : ""}${extra ? " | " + extra : ""}`);
};

// fix seed flag so linked employees can mark attendance
const conn = await mysql.createConnection({
  host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME, port: +(process.env.DB_PORT || 3306),
});
await conn.query("UPDATE employees SET is_platform_user='yes' WHERE email IN ('audit-member@test.local','audit-orgadmin@test.local')");
// backdate SLA candidate to 4 days ago
const [cand] = await conn.query("SELECT id FROM verification_requests WHERE uuid=?", [fs.readFileSync("./e2e-sla-candidate.txt", "utf8").trim()]);
if (cand.length) await conn.query("UPDATE verification_requests SET created_at = DATE_SUB(NOW(), INTERVAL 4 DAY) WHERE id=?", [cand[0].id]);
await conn.end();

const { admin: adminToken, org: orgToken, member: memberToken } = await getTokens();

// ─── 8b. UNMATCHED accept & assign ───
t("\n=== 8b. UNMATCHED accept & assign ===");
{
  const list = await api("GET", "/admin/verification-requests/null-organization?page=1&limit=10", { token: adminToken });
  const target = (list.data?.data?.items ?? []).find((o) => o.name === "E2E Target University");
  t(`target unmatched org: ${target?.uuid} website=${target?.website}`);

  const detail = await api("GET", `/admin/verification-requests/null-organization/${target.uuid}`, { token: adminToken });
  show("view unmatched org detail", detail, `requests=${detail.data?.data?.requests?.length ?? detail.data?.data?.request_count ?? "?"}`);

  const orgs = await api("GET", "/admin/organizations?page=1&limit=50", { token: adminToken });
  const e2eOrg = orgs.data.data.items.find((o) => o.name === "AUDIT E2E ORG");
  const accepted = await api("PATCH", `/admin/verification-requests/${target.uuid}/accept`, {
    token: adminToken,
    body: { issuing_organization_uuid: e2eOrg.uuid },
  });
  show("accept & assign to real org", accepted);
}

// ─── 9b. SLA flow ───
t("\n=== 9b. UNRESPONSIVE / SLA flow ===");
{
  const slaList = await api("GET", "/admin/verification-requests/sla?page=1&limit=10", { token: adminToken });
  show("SLA list after backdating", slaList, `total=${slaList.data?.data?.total}`);
  const item = (slaList.data?.data?.items ?? []).find((r) => r.document_type === "Contract");
  t(`sla item: ${item?.uuid} doc=${item?.document_type} sla_flag=${item?.sla_flagged_at ?? "(n/a)"} reminder=${item?.sla_reminder_sent_at ?? "(none)"}`);

  if (item) {
    const acted = await api("PATCH", `/admin/verification-requests/sla/${item.uuid}`, {
      token: adminToken,
      body: { status: "verified", verification_remarks: "SLA escalation - admin verified" },
    });
    show("admin acts on SLA-breached request", acted);

    // submitter notification created?
    const notifs = await api("GET", "/notifications?page=1&limit=20", { token: adminToken });
    // notification goes to the requester (plain user) — check plain user's notifications instead
  }
}

// notification for original submitter (plain user)
{
  const relogin = await getTokens();
  const notifs = await api("GET", "/notifications?page=1&limit=20", { token: relogin.plain });
  const slaNotif = (notifs.data?.data?.items ?? []).filter((n) => n.type === "request_verified" || (n.message || "").includes("Contract"));
  show("submitter notifications after SLA action", notifs, `matching=${slaNotif.length} sample="${slaNotif[0]?.message ?? "(none)"}"`);
}

// ─── 10b. LEAVES full lifecycle ───
t("\n=== 10b. LEAVES lifecycle ===");
{
  const types = await api("GET", "/org/leave-types", { token: orgToken });
  const casual = (types.data?.data?.leaveTypes ?? []).find((x) => x.name.startsWith("Casual"));
  t(`using leave type id=${casual?.id} name=${casual?.name} days=${casual?.days_allowed_per_year}`);

  const editedType = await api("PUT", `/org/leave-types/${casual.id}`, {
    token: orgToken,
    body: { name: "Casual E2E Updated", days_allowed_per_year: 8 },
  });
  show("org-admin edit leave type", editedType);

  const apply = await api("POST", "/leaves", {
    token: memberToken,
    body: { leave_type_id: casual.id, start_date: "2026-09-10", end_date: "2026-09-12", reason: "e2e leave" },
  });
  show("member applies for leave (3 days)", apply);
  const leaveUuid = apply.data?.data?.leaveRequest?.uuid;

  const badDates = await api("POST", "/leaves", {
    token: memberToken,
    body: { leave_type_id: casual.id, start_date: "2026-09-15", end_date: "2026-09-10", reason: "bad" },
  });
  show("apply end<start (expect clear error)", badDates);

  const mine = await api("GET", "/leaves/mine?page=1&limit=10", { token: memberToken });
  show("member 'my leaves'", mine, `total=${mine.data?.data?.total}`);

  const decided = await api("PATCH", `/leaves/${leaveUuid}/decide`, { token: orgToken, body: { status: "approved" } });
  show("org-admin approves leave", decided);

  const balanceAfter = await api("GET", "/leaves/balance", { token: memberToken });
  const b = (balanceAfter.data?.data?.balances ?? []).find((x) => x.leave_type_id === casual.id);
  t(`balance after approval: allocated=${b?.total_allocated} used=${b?.used} remaining=${b?.remaining} (expect used=3 remaining=5)`);

  const delTypeWhileInUse = await api("DELETE", `/org/leave-types/${casual.id}`, { token: orgToken });
  show("delete in-use leave type (expect block)", delTypeWhileInUse);

  // platform admin manage-type endpoint with valid org uuid (design conflict proof)
  const orgs = await api("GET", "/admin/organizations?page=1&limit=50", { token: adminToken });
  const e2eOrg = orgs.data.data.items.find((o) => o.name === "AUDIT E2E ORG");
  const adminCreateType = await api("POST", "/admin/leaves/types", {
    token: adminToken,
    body: { organization_uuid: e2eOrg.uuid, name: "Admin Made Type", days_allowed_per_year: 5 },
  });
  show("platform admin creates leave type in org (design says blocked!)", adminCreateType);
}

// ─── 11b. ATTENDANCE with fixed flags ───
t("\n=== 11b. ATTENDANCE ===");
{
  const addIp = await api("POST", "/org/attendance/ips", { token: orgToken, body: { ip: "::1" } });
  show("org-admin allow ::1", addIp);

  const checkin = await api("POST", "/attendance/check-in", { token: memberToken });
  show("member check-in from ALLOWED ip", checkin);

  const dupCheckin = await api("POST", "/attendance/check-in", { token: memberToken });
  show("duplicate check-in (expect clear 409)", dupCheckin);

  const checkout = await api("POST", "/attendance/check-out", { token: memberToken });
  show("member check-out", checkout);

  const rmIp = await api("DELETE", "/org/attendance/ips?ip=::1", { token: orgToken });
  show("org-admin removes ::1", rmIp);
  const blocked = await api("POST", "/attendance/check-in", { token: orgToken });
  show("check-in from DISALLOWED ip (expect 403 clear error)", blocked);

  const today = await api("GET", "/attendance/today", { token: memberToken });
  show("member today status", today, JSON.stringify(today.data?.data)?.slice(0, 120));
}

fs.writeFileSync("./e2e-results-c2.json", JSON.stringify(out, null, 2));
console.log(out.join("\n"));
