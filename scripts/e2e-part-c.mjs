import fs from "fs";
import { api, getTokens } from "./e2e-lib.mjs";

const out = [];
const t = (s) => out.push(s);
const show = (label, r, extra) => {
  const msg = r.data?.message ?? r.data?.error ?? "";
  t(`${label}: HTTP ${r.status}${msg ? " — " + msg : ""}${extra ? " | " + extra : ""}`);
};

const { admin: adminToken, org: orgToken, member: memberToken, plain: plainToken } = await getTokens();

// ─── 8. UNMATCHED ORGS ───
t("\n=== 8. UNMATCHED ORGS ===");
let unmatchedReqUuid, unmatchedOrgUuid;
{
  const list = await api("GET", "/admin/verification-requests/null-organization?page=1&limit=10", { token: adminToken });
  show("list unmatched-org requests", list, `total=${list.data?.data?.total}`);
  const first = (list.data?.data?.items ?? []).find((r) => r.unmatched_org_name === "E2E Target University");
  unmatchedReqUuid = first?.uuid;
  unmatchedOrgUuid = first?.unmatched_org_uuid;
  t(`found e2e unmatched request: ${unmatchedReqUuid} org=${unmatchedOrgUuid} website=${first?.unmatched_org_website ?? "(none)"}`);

  if (unmatchedOrgUuid) {
    const detail = await api("GET", `/admin/verification-requests/null-organization/${unmatchedReqUuid}`, { token: adminToken });
    show("view unmatched org detail", detail);
  }

  // accept & assign to real org
  const orgs = await api("GET", "/admin/organizations?page=1&limit=50", { token: adminToken });
  const e2eOrg = orgs.data.data.items.find((o) => o.name === "AUDIT E2E ORG");
  const accepted = await api("PATCH", `/admin/verification-requests/${unmatchedReqUuid}/accept`, {
    token: adminToken,
    body: { issuing_organization_uuid: e2eOrg.uuid },
  });
  show("accept & assign to real org", accepted);

  // create another unmatched request, then admin directly verifies it
  const fd = new FormData();
  fd.append("document_type", "Diploma");
  fd.append("other_organization_name", "E2E Direct Verify Institute");
  fd.append("other_organization_website", "https://e2e-direct.test");
  fd.append("document", new Blob([Buffer.from("%PDF-1.4 unmatched")], { type: "application/pdf" }), "u.pdf");
  const mk = await api("POST", "/verification-requests", { token: plainToken, form: fd });
  const mkUuid = mk.data?.data?.request?.uuid;
  const directVerify = await api("PATCH", `/admin/verification-requests/null-organization/${mkUuid}/verify`, {
    token: adminToken,
    body: { status: "verified", verification_remarks: "direct verify by admin" },
  });
  show("admin directly verifies unmatched request", directVerify);

  const afterList = await api("GET", "/admin/verification-requests/null-organization?page=1&limit=10", { token: adminToken });
  show("unmatched list after handling", afterList, `remaining=${afterList.data?.data?.total}`);
}

// ─── 9. UNRESPONSIVE / SLA ───
t("\n=== 9. UNRESPONSIVE (SLA) ===");
{
  // registered->registered under_review request from member to E2E ORG
  const fd = new FormData();
  fd.append("document_type", "Contract");
  fd.append("issuing_organization_uuid", "");
  fd.append("other_organization_name", "IGNORED");
  fd.append("document", new Blob([Buffer.from("%PDF-1.4 sla")], { type: "application/pdf" }), "s.pdf");
  // actually send to registered org: need its uuid
  const orgs = await api("GET", "/admin/organizations?page=1&limit=50", { token: adminToken });
  const e2eOrg = orgs.data.data.items.find((o) => o.name === "AUDIT E2E ORG");
  const fd2 = new FormData();
  fd2.append("document_type", "Contract");
  fd2.append("issuing_organization_uuid", e2eOrg.uuid);
  fd2.append("document", new Blob([Buffer.from("%PDF-1.4 sla")], { type: "application/pdf" }), "s.pdf");
  const created = await api("POST", "/verification-requests", { token: plainToken, form: fd2 });
  show("create request -> E2E ORG (for SLA test)", created);
  const slaReqUuid = created.data?.data?.request?.uuid;
  t(`sla candidate: ${slaReqUuid} (will backdate created_at via SQL next step)`);

  const slaListBefore = await api("GET", "/admin/verification-requests/sla?page=1&limit=10", { token: adminToken });
  show("SLA list BEFORE backdating", slaListBefore, `total=${slaListBefore.data?.data?.total}`);
  fs.writeFileSync("./e2e-sla-candidate.txt", slaReqUuid || "");
}

// ─── 10. LEAVE TYPES ───
t("\n=== 10. LEAVE TYPES ===");
{
  const orgTypes = await api("GET", "/org/leave-types", { token: orgToken });
  show("org-admin list leave types", orgTypes, `count=${orgTypes.data?.data?.leaveTypes?.length}`);

  const createdType = await api("POST", "/org/leave-types", {
    token: orgToken,
    body: { name: "Casual E2E", days_allowed_per_year: 6 },
  });
  show("org-admin create leave type", createdType);
  const typeId = createdType.data?.data?.leaveType?.id;

  const editedType = await api("PUT", `/org/leave-types/${typeId}`, {
    token: orgToken,
    body: { name: "Casual E2E Updated", days_allowed_per_year: 8 },
  });
  show("org-admin edit leave type", editedType, `name=${editedType.data?.data?.leaveType?.name}`);

  // employee leave lifecycle
  const balance = await api("GET", "/leaves/balance", { token: memberToken });
  show("member leave balance", balance, JSON.stringify(balance.data?.data?.balances)?.slice(0, 100));

  const apply = await api("POST", "/leaves", {
    token: memberToken,
    body: { leave_type_id: typeId, start_date: "2026-09-10", end_date: "2026-09-12", reason: "e2e leave" },
  });
  show("member applies for leave", apply);
  const leaveUuid = apply.data?.data?.leaveRequest?.uuid;

  const badDates = await api("POST", "/leaves", {
    token: memberToken,
    body: { leave_type_id: typeId, start_date: "2026-09-15", end_date: "2026-09-10", reason: "bad" },
  });
  show("member applies end<start (expect clear error)", badDates);

  const orgLeaves = await api("GET", "/org/leaves?status=pending&page=1&limit=10", { token: orgToken });
  show("org-admin pending leaves list", orgLeaves, `total=${orgLeaves.data?.data?.total}`);

  const decided = await api("PATCH", `/leaves/${leaveUuid}/decide`, { token: orgToken, body: { status: "approved" } });
  show("org-admin approves leave", decided);

  const balanceAfter = await api("GET", "/leaves/balance", { token: memberToken });
  const b = (balanceAfter.data?.data?.balances ?? []).find((x) => x.leave_type_id === typeId);
  t(`balance after approval: allocated=${b?.total_allocated} used=${b?.used} remaining=${b?.remaining} (expect used=3 remaining=5 of 8)`);

  const delTypeWhileInUse = await api("DELETE", `/org/leave-types/${typeId}`, { token: orgToken });
  show("delete in-use leave type (expect block/clear error)", delTypeWhileInUse);

  // platform admin leave-type management endpoints exist?
  const adminCreate = await api("POST", "/admin/leaves/types", {
    token: adminToken,
    body: { organization_uuid: "", name: "Admin Made Type", days_allowed_per_year: 5 },
  });
  show("platform admin POST /admin/leaves/types (design says should be blocked!)", adminCreate);
}

// ─── 11. ATTENDANCE ───
t("\n=== 11. ATTENDANCE ===");
{
  const addIp = await api("POST", "/org/attendance/ips", { token: orgToken, body: { ip: "::1" } });
  show("org-admin allow ::1 (local loopback)", addIp, `ips=${JSON.stringify(addIp.data?.data?.allowedIps ?? addIp.data?.data)}`);

  const ips = await api("GET", "/org/attendance/ips", { token: orgToken });
  show("org-admin list allowed IPs", ips, JSON.stringify(ips.data?.data));

  const checkin = await api("POST", "/attendance/check-in", { token: memberToken });
  show("member check-in from ALLOWED ip", checkin);

  const dupCheckin = await api("POST", "/attendance/check-in", { token: memberToken });
  show("duplicate check-in (expect clear 409)", dupCheckin);

  const checkout = await api("POST", "/attendance/check-out", { token: memberToken });
  show("member check-out", checkout);

  // disallowed IP test: remove ::1 then org-admin tries check-in
  const rmIp = await api("DELETE", "/org/attendance/ips?ip=::1", { token: orgToken });
  show("org-admin removes ::1", rmIp);
  const checkinBlocked = await api("POST", "/attendance/check-in", { token: orgToken });
  show("check-in from DISALLOWED ip (expect 403)", checkinBlocked);

  const orgRecords = await api("GET", "/org/attendance?page=1&limit=10", { token: orgToken });
  show("org-admin attendance records", orgRecords, `total=${orgRecords.data?.data?.total}`);

  const adminRecords = await api("GET", "/admin/attendance?page=1&limit=10", { token: adminToken });
  show("platform admin attendance records (view)", adminRecords, `total=${adminRecords.data?.data?.total}`);

  // admin IP management exists at API level (design conflict)
  const adminIpAdd = await api("POST", "/admin/attendance/ips", { token: adminToken, body: { organization_uuid: "", ip: "10.0.0.1" } });
  show("platform admin POST /admin/attendance/ips (design says should be blocked!)", adminIpAdd);
}

// ─── 12. PAYROLL ───
t("\n=== 12. PAYROLL ===");
{
  const emps = await api("GET", "/org/employees?page=1&limit=50&search=audit-member", { token: orgToken });
  const empUuid = emps.data?.data?.items?.[0]?.uuid;

  const created = await api("POST", "/org/salary-records", {
    token: orgToken,
    body: { employee_uuid: empUuid, month: 8, year: 2026, basic_salary: 150000, allowances: 10000, deductions: 5000 },
  });
  show("org-admin create salary record", created, `net=${created.data?.data?.salaryRecord?.net_salary}`);
  const salUuid = created.data?.data?.salaryRecord?.uuid;

  const dupSal = await api("POST", "/org/salary-records", {
    token: orgToken,
    body: { employee_uuid: empUuid, month: 8, year: 2026, basic_salary: 150000 },
  });
  show("duplicate month salary (expect clear error)", dupSal);

  const list = await api("GET", "/org/salary-records?page=1&limit=10", { token: orgToken });
  show("org-admin salary list", list, `total=${list.data?.data?.total}`);

  if (salUuid) {
    const slip = await api("GET", `/org/salary-records/${salUuid}/payslip`, { token: orgToken, raw: true });
    const buf = Buffer.from(await slip.arrayBuffer());
    t(`payslip download: HTTP ${slip.status} bytes=${buf.length} pdfMagic=${buf.slice(0, 5).toString()}`);
  }

  const adminList = await api("GET", "/admin/salary-records?page=1&limit=10", { token: adminToken });
  show("platform admin salary list (view)", adminList, `total=${adminList.data?.data?.total}`);

  const adminCreate = await api("POST", "/admin/salary-records", {
    token: adminToken,
    body: { employee_uuid: empUuid, month: 7, year: 2026, basic_salary: 120000 },
  });
  show("platform admin POST /admin/salary-records (design says should be blocked!)", adminCreate);
}

// ─── 13. PAYMENTS ───
t("\n=== 13. PAYMENTS ===");
{
  const history = await api("GET", "/admin/payment?page=1&limit=10", { token: adminToken });
  show("admin payment history", history, `total=${history.data?.data?.total}`);

  const orgs = await api("GET", "/admin/organizations?page=1&limit=50", { token: adminToken });
  const e2eOrg = orgs.data.data.items.find((o) => o.name === "AUDIT E2E ORG");

  // manual payment record
  const pay = await api("POST", "/admin/payment", {
    token: adminToken,
    body: { user_uuid: "", amount: 2500, payment_method: "manual", transaction_reference: "E2E-TXN-001", purpose: "subscription" },
  });
  show("record manual payment (no user_uuid — expect validation)", pay);

  // subscription set with explicit amount
  const sub = await api("PATCH", `/admin/organizations/${e2eOrg.uuid}/subscription`, {
    token: adminToken,
    body: { plan: "monthly", amount: 1999 },
  });
  show("set subscription monthly amount=1999", sub, `expiry=${sub.data?.data?.organization?.subscription_expiry ?? sub.data?.data?.subscription_expiry}`);

  // subscription without amount (optional?)
  const subNoAmount = await api("PATCH", `/admin/organizations/${e2eOrg.uuid}/subscription`, {
    token: adminToken,
    body: { plan: "yearly" },
  });
  show("set subscription yearly WITHOUT amount (optional?)", subNoAmount);

  // user-side billing scoped by org
  const myPlanMember = await api("GET", "/payment/plan", { token: memberToken });
  show("user-side /payment/plan (member of org)", myPlanMember, `payments=${myPlanMember.data?.data?.payments?.length ?? "?"} plan=${myPlanMember.data?.data?.org_subscription?.plan ?? "?"}`);
  const myPlanPlain = await api("GET", "/payment/plan", { token: plainToken });
  show("user-side /payment/plan (no org)", myPlanPlain);

  const cancel = await api("DELETE", `/admin/organizations/${e2eOrg.uuid}/subscription`, { token: adminToken });
  show("cancel subscription", cancel);
}

// ─── 14. LEADS ───
t("\n=== 14. LEADS ===");
{
  const contact = await api("POST", "/leads/contact", {
    body: { name: "E2E Contact", email: "lead@test.local", phone: "+923334455667", message: "e2e contact form submission" },
  });
  show("public contact form", contact);

  const access = await api("POST", "/leads/request-access", {
    body: { contact_name: "E2E Access", organization_name: "E2E Access Org", email: "access@test.local", phone: "+923334455668", message: "e2e access request" },
  });
  show("public access request", access);

  const clist = await api("GET", "/admin/leads/contact?page=1&limit=10", { token: adminToken });
  show("admin contact leads list", clist, `total=${clist.data?.data?.total} hasE2E=${(clist.data?.data?.items ?? []).some((l) => l.email === "lead@test.local")}`);
  const rlist = await api("GET", "/admin/leads/request-access?page=1&limit=10", { token: adminToken });
  show("admin access requests list", rlist, `total=${rlist.data?.data?.total} hasE2E=${(rlist.data?.data?.items ?? []).some((l) => l.email === "access@test.local")}`);
}

fs.writeFileSync("./e2e-results-c.json", JSON.stringify(out, null, 2));
console.log(out.join("\n"));
