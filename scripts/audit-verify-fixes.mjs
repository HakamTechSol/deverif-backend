import jwt from "jsonwebtoken";
import dotenv from "dotenv";

dotenv.config();

const BASE = "http://localhost:" + (process.env.PORT || 5000) + "/api/v1";
const ADMIN_UUID = process.argv[2];
const ORG_ADMIN_UUID = process.argv[3];
const ORG_ID = parseInt(process.argv[4], 10);
const LEAVE_TYPE_ID = parseInt(process.argv[5], 10);

const sign = (payload) =>
  jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: "30m",
    issuer: process.env.JWT_ISSUER || "dvarif-api",
    audience: process.env.JWT_AUDIENCE || "dvarif-client",
  });

const adminToken = sign({ type: "admin", userId: ADMIN_UUID, role: "admin", email: "admin@test.local" });
const userToken = sign({ type: "user", userId: ORG_ADMIN_UUID, role: "user", organization: ORG_ID, org_role: "org_admin" });
const H = (t) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });

async function call(name, path, method, token, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: H(token),
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  console.log(`${name}: HTTP ${r.status} ${j.message ? "- " + j.message : ""}`);
  return { status: r.status, body: j };
}

// 0. Allow the local loopback IP for attendance checks
await call("Add IP ::1", `/org/attendance/ips`, "POST", userToken, { ip: "::1" });
await call("Add IP 127.0.0.1", `/org/attendance/ips`, "POST", userToken, { ip: "127.0.0.1" });

// 1. Create a leave request as the org-admin user
const created = await call("Create leave (user)", "/leaves", "POST", userToken, {
  leave_type_id: LEAVE_TYPE_ID,
  start_date: "2026-09-01",
  end_date: "2026-09-03",
  reason: "audit e2e",
});
const leaveUuid = created.body?.data?.leaveRequest?.uuid;

// 2. THE CRITICAL FIX CHECK: platform-admin approval (previously FK violation -> 500)
if (leaveUuid) {
  await call("Admin approves leave (was 500)", `/admin/leaves/${leaveUuid}/decide`, "PATCH", adminToken, { status: "approved" });
}

// 3. Double-decision race guard: deciding again must now 409
if (leaveUuid) {
  await call("Re-decide same leave (expect 409)", `/admin/leaves/${leaveUuid}/decide`, "PATCH", adminToken, { status: "rejected" });
}

// 4. Attendance: first check-in OK, second must be friendly 409
await call("Check-in #1", "/attendance/check-in", "POST", userToken);
await call("Check-in #2 (expect 409)", "/attendance/check-in", "POST", userToken);

// 5. OTP limiter: hammer verify-otp with wrong codes -> expect 429 by attempt ~11
let last;
for (let i = 1; i <= 12; i++) {
  const r = await fetch(BASE + "/auth/verify-otp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity_type: "user", identity_id: ORG_ADMIN_UUID, otp: "000000" }),
  });
  last = `${i}:${r.status}`;
}
console.log("OTP limiter sequence:", last, "(expect 429 by the 11th)");
