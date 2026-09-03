import fs from "fs";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";

dotenv.config();

export const BASE = "http://localhost:" + (process.env.PORT || 5000) + "/api/v1";
const INBOX = "./dev-smtp-inbox.jsonl";

export function readLastOtp(email) {
  if (!fs.existsSync(INBOX)) return null;
  const lines = fs.readFileSync(INBOX, "utf8").trim().split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const rec = JSON.parse(lines[i]);
    if (rec.to?.some((t) => t.includes(email)) && rec.otp) return rec.otp;
  }
  return null;
}

export async function api(method, path, { token, body, form, raw } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: form ? form : body ? JSON.stringify(body) : undefined,
  });
  if (raw) return res;
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

export function log(label, r, extra) {
  const msg = r.data?.message ?? r.data?.error ?? "";
  console.log(`${label}: HTTP ${r.status}${msg ? " — " + msg : ""}${extra ? " | " + extra : ""}`);
}

// Real OTP login flow exactly as the UI performs it
export async function login({ email, password }) {
  const step1 = await api("POST", "/auth/login", { body: { email, password } });
  if (step1.status !== 200) return { ok: false, step1 };
  const { identity_type, identity_id } = step1.data.data;
  await new Promise((r) => setTimeout(r, 300));
  const otp = readLastOtp(email);
  if (!otp) return { ok: false, step1, error: "no otp captured" };
  const step2 = await api("POST", "/auth/verify-otp", {
    body: { identity_type, identity_id, otp },
  });
  if (step2.status !== 200) return { ok: false, step1, step2 };
  return { ok: true, accessToken: step2.data.data.token, me: step2.data.data };
}

// Cached logins to avoid tripping the login rate-limiter across scripts
const TOKENS_FILE = "./e2e-tokens.json";
export async function getTokens() {
  if (fs.existsSync(TOKENS_FILE)) {
    try { return JSON.parse(fs.readFileSync(TOKENS_FILE, "utf8")); } catch {}
  }
  const admin = await login({ email: "audit-admin@test.local", password: "AuditAdmin#123" });
  const org = await login({ email: "audit-orgadmin@test.local", password: "AuditOrg#123" });
  const plain = await login({ email: "audit-plain@test.local", password: "AuditPlain#123" });
  const member = await login({ email: "audit-member@test.local", password: "AuditMember#123" });
  const tokens = {
    admin: admin.accessToken,
    org: org.accessToken,
    plain: plain.accessToken,
    member: member.accessToken,
  };
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens));
  return tokens;
}
