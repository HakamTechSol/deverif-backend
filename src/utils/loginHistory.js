import crypto from "crypto";
import { pool } from "../config/db.js";
import { normalizeIp } from "./ip.js";

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    const first = typeof forwarded === "string" ? forwarded.split(",")[0].trim() : forwarded[0];
    if (first) return normalizeIp(first);
  }

  const realIp = req.headers["x-real-ip"];
  if (realIp) return normalizeIp(realIp);

  return normalizeIp(req.ip || req.connection?.remoteAddress || "unknown");
}

export function logLoginAttempt({ req, identityType, identityId, success }) {
  const ip = getClientIp(req);
  const ua = (req.headers["user-agent"] || "").slice(0, 512);
  const uuid = crypto.randomUUID();

  pool.query(
    "INSERT INTO login_history (uuid, identity_type, identity_id, ip_address, user_agent, login_at, success) VALUES (?, ?, ?, ?, ?, NOW(), ?)",
    [uuid, identityType, identityId, ip, ua, success ? "yes" : "no"]
  ).catch((err) => {
    console.error("Failed to log login attempt:", err.message);
  });
}
