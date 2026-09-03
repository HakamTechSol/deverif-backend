import fs from "fs";
import mysql from "mysql2/promise";
import dotenv from "dotenv";
import { api, getTokens } from "./e2e-lib.mjs";
dotenv.config();
const { admin, org, member, plain } = await getTokens();

console.log("=== RE-TEST AFTER FIXES ===");

// 1. leave types now expose id; edit/delete work
const lt = await api("GET", "/org/leave-types", { token: org });
const casual = (lt.data?.data?.leaveTypes || []).find((x) => x.name.startsWith("Casual"));
console.log("leave type has id:", casual?.id !== undefined, "| id=" + casual?.id);
const edited = await api("PUT", "/org/leave-types/" + casual.id, { token: org, body: { name: "Casual E2E Updated", days_allowed_per_year: 8 } });
console.log("edit leave type:", edited.status, edited.data?.message);

const apply = await api("POST", "/leaves", { token: member, body: { leave_type_id: casual.id, start_date: "2026-09-10", end_date: "2026-09-12", reason: "e2e" } });
console.log("apply leave:", apply.status, apply.data?.message);
const lu = apply.data?.data?.leaveRequest?.uuid;
const bad = await api("POST", "/leaves", { token: member, body: { leave_type_id: casual.id, start_date: "2026-09-15", end_date: "2026-09-10" } });
console.log("end<start error:", bad.status, "-", bad.data?.message);
const dec = await api("PATCH", "/leaves/" + lu + "/decide", { token: org, body: { status: "approved" } });
console.log("approve leave:", dec.status, dec.data?.message);
const bal = await api("GET", "/leaves/balance", { token: member });
const b = (bal.data?.data?.balances || []).find((x) => x.leave_type_id === casual.id);
console.log("balance: used=" + b?.used + " remaining=" + b?.remaining + " (expect 3 / 5)");
const delInUse = await api("DELETE", "/org/leave-types/" + casual.id, { token: org });
console.log("delete in-use type:", delInUse.status, "-", delInUse.data?.message);

// 2. notifications mark-read
const n = await api("GET", "/notifications?page=1&limit=5", { token: plain });
const nid = n.data?.data?.items?.[0]?.id;
console.log("notification id present:", nid !== undefined);
if (nid) {
  const mr = await api("POST", "/notifications/" + nid + "/read", { token: plain });
  console.log("mark notification read:", mr.status, mr.data?.message);
}

// 3. SLA action after FK fix
const sla = await api("GET", "/admin/verification-requests/sla?page=1&limit=10", { token: admin });
const item = (sla.data?.data?.items || []).find((r) => r.document_type === "Contract");
console.log("sla item found:", !!item);
if (item) {
  const acted = await api("PATCH", "/admin/verification-requests/sla/" + item.uuid, { token: admin, body: { status: "verified", verification_remarks: "SLA escalation - admin verified" } });
  console.log("admin SLA action:", acted.status, acted.data?.message ?? acted.data?.error);
  if (acted.status === 200) {
    const cert = await api("GET", "/verification-requests/" + item.uuid + "/certificate", { token: plain, raw: true });
    const buf = Buffer.from(await cert.arrayBuffer());
    console.log("cert download: HTTP " + cert.status + " bytes=" + buf.length + " magic=" + buf.slice(0, 5).toString());
  }
}
const n2 = await api("GET", "/notifications?page=1&limit=10", { token: plain });
const slaNotif = (n2.data?.data?.items || []).find((x) => (x.message || "").includes("unresponsive"));
console.log("submitter SLA notification:", slaNotif ? JSON.stringify(slaNotif.message) : "(none)");
