import jwt from "jsonwebtoken";
import dotenv from "dotenv";

dotenv.config();

const BASE = "http://localhost:" + (process.env.PORT || 5000) + "/api/v1";
const JWT_SECRET = process.env.JWT_SECRET;

const ADMIN_UUID = process.argv[2];
const ORG_ADMIN_UUID = process.argv[3];
const ORG_ID = parseInt(process.argv[4], 10);

const adminToken = jwt.sign(
  { type: "admin", userId: ADMIN_UUID, role: "admin", email: "hunainhaidre78822@gmail.com" },
  JWT_SECRET,
  { expiresIn: "30m", issuer: process.env.JWT_ISSUER || "dverif-api", audience: process.env.JWT_AUDIENCE || "dverif-client" }
);

const userToken = jwt.sign(
  { type: "user", userId: ORG_ADMIN_UUID, role: "user", organization: ORG_ID, org_role: "org_admin" },
  JWT_SECRET,
  { expiresIn: "30m", issuer: process.env.JWT_ISSUER || "dverif-api", audience: process.env.JWT_AUDIENCE || "dverif-client" }
);

async function measure(name, path, token, { n = 20, concurrency = 5 } = {}) {
  const times = [];
  let failures = 0;
  async function one() {
    const t0 = performance.now();
    try {
      const r = await fetch(BASE + path, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) failures++;
      await r.arrayBuffer();
    } catch {
      failures++;
    }
    times.push(performance.now() - t0);
  }
  const workers = Array.from({ length: concurrency }, async () => {
    for (let i = 0; i < n / concurrency; i++) await one();
  });
  await Promise.all(workers);
  times.sort((a, b) => a - b);
  const avg = times.reduce((s, x) => s + x, 0) / times.length;
  const p50 = times[Math.floor(times.length * 0.5)];
  const p95 = times[Math.min(times.length - 1, Math.floor(times.length * 0.95))];
  console.log(
    `${name.padEnd(46)} avg=${avg.toFixed(1)}ms p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${times[times.length - 1].toFixed(1)}ms fails=${failures}`
  );
}

console.log("=== Measured endpoint latencies (seeded volumes) ===");
// Heaviest new list endpoints
await measure("GET /admin/audit-logs (100k rows)", "/admin/audit-logs?page=1&limit=20", adminToken);
await measure("GET /admin/audit-logs?action+date filter", "/admin/audit-logs?page=1&limit=20&action=request.create&date_from=2026-01-01", adminToken);
await measure("GET /admin/audit-logs actor_type+date", "/admin/audit-logs?page=1&limit=20&actor_type=user&date_from=2026-01-01", adminToken);
await measure("GET /admin/login-history (5k rows)", "/admin/login-history?page=1&limit=20&search=seed", adminToken);
await measure("GET /org/employees (3k rows)", "/org/employees?page=1&limit=20", userToken);
await measure("GET /org/leaves (6k rows)", "/org/leaves?page=1&limit=20", userToken);
await measure("GET /org/attendance (15k rows)", "/org/attendance?page=1&limit=20", userToken);
await measure("GET /org/salary-records (9k rows)", "/org/salary-records?page=1&limit=20", userToken);
await measure("GET /admin/verification-requests/sla", "/admin/verification-requests/sla?page=1&limit=20", adminToken);
