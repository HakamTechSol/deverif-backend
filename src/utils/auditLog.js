import crypto from "crypto";
import { pool } from "../config/db.js";
import { normalizeIp } from "./ip.js";

function getClientIp(req) {
  const forwarded = req?.headers?.["x-forwarded-for"];
  if (forwarded) {
    const first = typeof forwarded === "string" ? forwarded.split(",")[0].trim() : forwarded[0];
    if (first) return normalizeIp(first);
  }
  const realIp = req?.headers?.["x-real-ip"];
  if (realIp) return normalizeIp(realIp);
  return normalizeIp(req?.ip || req?.connection?.remoteAddress || "unknown");
}

/**
 * Log an audit entry. Never throws — failures are logged to console only so
 * the main action is never blocked or slowed down by logging.
 */
export function logAudit({ actorType, actorId, actorName, actorRole, action, entityType, entityId = null, details = {}, req = null }) {
  try {
    const uuid = crypto.randomUUID();
    const ip = getClientIp(req);
    pool.query(
      `INSERT INTO audit_logs (uuid, actor_type, actor_id, actor_name, actor_role, action, entity_type, entity_id, details, ip_address, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [uuid, actorType, actorId, actorName || null, actorRole || null, action, entityType, entityId || null,
       details && typeof details === "object" ? JSON.stringify(details) : null, ip]
    ).catch((err) => console.error("Audit log insert failed:", err.message));
  } catch (err) {
    console.error("Audit log failed:", err.message);
  }
}

/** Derive actor fields from the authenticated request (admin or user). */
export function getActorFromReq(req) {
  if (req?.admin) {
    return { actorType: "admin", actorId: req.admin.id, actorName: req.admin.full_name || req.admin.email, actorRole: "system_admin" };
  }
  if (req?.user) {
    return { actorType: "user", actorId: req.user.id, actorName: req.user.full_name || req.user.email, actorRole: req.user.org_role || "member" };
  }
  return { actorType: "user", actorId: null, actorName: "Unknown", actorRole: "unknown" };
}