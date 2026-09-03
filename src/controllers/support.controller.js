import crypto from "crypto";
import ApiError from "../utils/ApiError.js";
import { pool } from "../config/db.js";
import { ok, created } from "../utils/response.js";
import { assertUuid } from "../utils/publicResponse.js";
import { parsePagination, paginatedResponse } from "../utils/pagination.js";
import { createNotificationForUsers } from "./notification.controller.js";
import { logAudit, getActorFromReq } from "../utils/auditLog.js";

const VALID_PRIORITIES = ["low", "medium", "high"];
const VALID_STATUSES = ["open", "in_progress", "resolved", "closed"];

const TICKET_SELECT = `SELECT t.id, t.uuid, t.subject, t.description, t.priority, t.status,
        DATE_FORMAT(t.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
        DATE_FORMAT(t.updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at,
        t.organization_id,
        o.uuid AS organization_uuid,
        o.name AS organization_name,
        t.raised_by_uuid,
        raiser.full_name AS raised_by_name,
        raiser.email AS raised_by_email
 FROM support_tickets t
 LEFT JOIN organizations o ON o.id = t.organization_id
 LEFT JOIN users raiser ON raiser.uuid = t.raised_by_uuid`;

async function getAdminUuids() {
  const [rows] = await pool.query(
    "SELECT uuid FROM admin_profiles WHERE status='active' OR status IS NULL"
  );
  return rows.map((r) => r.uuid);
}

/** Org users who are part of a ticket's conversation (the raiser + every org_user replier). */
async function getTicketNotifyOrgUserIds(ticketUuid) {
  const [rows] = await pool.query(
    `SELECT DISTINCT t.raised_by_uuid AS uuid FROM support_tickets t WHERE t.uuid=?
     UNION
     SELECT DISTINCT r.replied_by_uuid AS uuid FROM support_ticket_replies r
       WHERE r.ticket_uuid=? AND r.replied_by_type='org_user'`,
    [ticketUuid, ticketUuid]
  );
  return rows.map((r) => r.uuid).filter(Boolean);
}

async function loadTicket(uuid) {
  assertUuid(uuid, "Ticket UUID");
  const [rows] = await pool.query(`${TICKET_SELECT} WHERE t.uuid=?`, [uuid]);
  if (!rows.length) throw new ApiError(404, "Ticket not found");
  return rows[0];
}

async function loadReplies(ticketUuid) {
  const [rows] = await pool.query(
    `SELECT r.uuid, r.message, r.replied_by_type, r.replied_by_uuid,
            DATE_FORMAT(r.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
            COALESCE(u.full_name, a.full_name, 'Support') AS replied_by_name,
            COALESCE(u.email, a.email, '') AS replied_by_email
     FROM support_ticket_replies r
     LEFT JOIN users u ON u.uuid = r.replied_by_uuid AND r.replied_by_type='org_user'
     LEFT JOIN admin_profiles a ON a.uuid = r.replied_by_uuid AND r.replied_by_type='admin'
     WHERE r.ticket_uuid=?
     ORDER BY r.created_at ASC, r.id ASC`,
    [ticketUuid]
  );
  return rows;
}

function assertOpenForReply(ticket) {
  if (ticket.status === "closed") {
    throw new ApiError(409, "This ticket is closed and can no longer receive replies");
  }
}

// ---------------------------------------------------------------------------
// ORG side — the organization user raises, views and replies to their tickets.
// ---------------------------------------------------------------------------

export async function listOrgTickets(req, res) {
  const { page, limit, offset } = parsePagination(req.query);
  const status = typeof req.query.status === "string" ? req.query.status.trim() : "";
  const priority = typeof req.query.priority === "string" ? req.query.priority.trim() : "";
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";

  const conditions = ["t.organization_id = ?"];
  const params = [req.scopeOrgId];

  if (status && VALID_STATUSES.includes(status)) {
    conditions.push("t.status = ?");
    params.push(status);
  }
  if (priority && VALID_PRIORITIES.includes(priority)) {
    conditions.push("t.priority = ?");
    params.push(priority);
  }
  if (search) {
    conditions.push("(t.subject LIKE ? OR t.description LIKE ?)");
    const like = `%${search}%`;
    params.push(like, like);
  }

  const whereClause = `WHERE ${conditions.join(" AND ")}`;

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM support_tickets t ${whereClause}`,
    params
  );
  const [rows] = await pool.query(
    `${TICKET_SELECT} ${whereClause} ORDER BY t.updated_at DESC, t.id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  return ok(res, paginatedResponse(rows, total, page, limit), "Support tickets");
}

export async function createTicket(req, res) {
  const { subject, description, priority = "medium" } = req.body ?? {};

  if (!subject || !String(subject).trim()) throw new ApiError(400, "subject is required");
  if (!description || !String(description).trim()) throw new ApiError(400, "description is required");
  if (!VALID_PRIORITIES.includes(priority)) throw new ApiError(400, "priority must be low, medium, or high");

  const uuid = crypto.randomUUID();
  const [result] = await pool.query(
    `INSERT INTO support_tickets (uuid, organization_id, raised_by_uuid, subject, description, priority)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [uuid, req.scopeOrgId, req.user.uuid, String(subject).trim(), String(description).trim(), priority]
  );

  const ticket = await loadTicket(uuid);

  // Notify system admins so the ticket gets assigned/reviewed.
  try {
    const adminIds = await getAdminUuids();
    if (adminIds.length) {
      await createNotificationForUsers({
        userIds: adminIds,
        type: "support_ticket",
        title: "New support ticket",
        message: `${req.user.full_name} (${ticket.organization_name}) — ${ticket.subject}`,
        link: `/admin/support/${uuid}`,
        referenceId: uuid,
      });
    }
  } catch (e) {
    console.error("Support ticket notification failed:", e.message);
  }

  logAudit({
    ...getActorFromReq(req),
    action: "support.ticket_create",
    entityType: "support_ticket",
    entityId: uuid,
    details: { subject: ticket.subject, priority },
    req,
  });

  return created(res, { ticket }, "Support ticket created");
}

export async function getOrgTicket(req, res) {
  const { uuid } = req.params;
  const ticket = await loadTicket(uuid);
  if (ticket.organization_id !== req.scopeOrgId) {
    throw new ApiError(403, "This ticket does not belong to your organization");
  }
  const replies = await loadReplies(uuid);
  return ok(res, { ticket, replies }, "Support ticket");
}

export async function addOrgReply(req, res) {
  const { uuid } = req.params;
  const { message } = req.body ?? {};

  const ticket = await loadTicket(uuid);
  if (ticket.organization_id !== req.scopeOrgId) {
    throw new ApiError(403, "This ticket does not belong to your organization");
  }
  assertOpenForReply(ticket);
  if (!message || !String(message).trim()) throw new ApiError(400, "message is required");

  const replyUuid = crypto.randomUUID();
  await pool.query(
    `INSERT INTO support_ticket_replies (uuid, ticket_uuid, replied_by_uuid, replied_by_type, message)
     VALUES (?, ?, ?, 'org_user', ?)`,
    [replyUuid, uuid, req.user.uuid, String(message).trim()]
  );
  await pool.query("UPDATE support_tickets SET updated_at=NOW() WHERE uuid=?", [uuid]);

  // Notify system admins of the new activity.
  try {
    const adminIds = await getAdminUuids();
    if (adminIds.length) {
      await createNotificationForUsers({
        userIds: adminIds,
        type: "support_reply",
        title: "New reply on support ticket",
        message: `${req.user.full_name} replied: ${ticket.subject}`,
        link: `/admin/support/${uuid}`,
        referenceId: uuid,
      });
    }
  } catch (e) {
    console.error("Support reply notification failed:", e.message);
  }

  logAudit({
    ...getActorFromReq(req),
    action: "support.reply",
    entityType: "support_ticket",
    entityId: uuid,
    details: { by: "org_user" },
    req,
  });

  const replies = await loadReplies(uuid);
  const updated = await loadTicket(uuid);
  return created(res, { ticket: updated, replies }, "Reply added");
}

// ---------------------------------------------------------------------------
// ADMIN side — the System Admin sees every org's tickets, replies and updates.
// ---------------------------------------------------------------------------

export async function listAdminTickets(req, res) {
  const { page, limit, offset } = parsePagination(req.query);
  const status = typeof req.query.status === "string" ? req.query.status.trim() : "";
  const priority = typeof req.query.priority === "string" ? req.query.priority.trim() : "";
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";

  const conditions = [];
  const params = [];

  if (status && VALID_STATUSES.includes(status)) {
    conditions.push("t.status = ?");
    params.push(status);
  }
  if (priority && VALID_PRIORITIES.includes(priority)) {
    conditions.push("t.priority = ?");
    params.push(priority);
  }
  if (search) {
    conditions.push("(t.subject LIKE ? OR t.description LIKE ? OR o.name LIKE ? OR raiser.email LIKE ?)");
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM support_tickets t
     LEFT JOIN organizations o ON o.id = t.organization_id
     LEFT JOIN users raiser ON raiser.uuid = t.raised_by_uuid ${whereClause}`,
    params
  );
  const [rows] = await pool.query(
    `${TICKET_SELECT} ${whereClause} ORDER BY t.updated_at DESC, t.id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  return ok(res, paginatedResponse(rows, total, page, limit), "Support tickets");
}

export async function getAdminTicket(req, res) {
  const { uuid } = req.params;
  const ticket = await loadTicket(uuid);
  const replies = await loadReplies(uuid);
  return ok(res, { ticket, replies }, "Support ticket");
}

export async function addAdminReply(req, res) {
  const { uuid } = req.params;
  const { message } = req.body ?? {};

  const ticket = await loadTicket(uuid);
  assertOpenForReply(ticket);
  if (!message || !String(message).trim()) throw new ApiError(400, "message is required");

  const replyUuid = crypto.randomUUID();
  await pool.query(
    `INSERT INTO support_ticket_replies (uuid, ticket_uuid, replied_by_uuid, replied_by_type, message)
     VALUES (?, ?, ?, 'admin', ?)`,
    [replyUuid, uuid, req.admin.uuid, String(message).trim()]
  );
  await pool.query("UPDATE support_tickets SET updated_at=NOW() WHERE uuid=?", [uuid]);

  // Notify the org users involved in the conversation.
  try {
    const userIds = await getTicketNotifyOrgUserIds(uuid);
    if (userIds.length) {
      await createNotificationForUsers({
        userIds,
        type: "support_reply",
        title: "Support update on your ticket",
        message: `${req.admin.full_name} replied: ${ticket.subject}`,
        link: `/org/support/${uuid}`,
        referenceId: uuid,
      });
    }
  } catch (e) {
    console.error("Support reply notification failed:", e.message);
  }

  logAudit({
    ...getActorFromReq(req),
    action: "support.reply",
    entityType: "support_ticket",
    entityId: uuid,
    details: { by: "admin" },
    req,
  });

  const replies = await loadReplies(uuid);
  const updated = await loadTicket(uuid);
  return created(res, { ticket: updated, replies }, "Reply added");
}

export async function updateTicketStatus(req, res) {
  const { uuid } = req.params;
  const { status } = req.body ?? {};

  if (!VALID_STATUSES.includes(status)) {
    throw new ApiError(400, "status must be open, in_progress, resolved, or closed");
  }

  const ticket = await loadTicket(uuid);
  await pool.query("UPDATE support_tickets SET status=?, updated_at=NOW() WHERE uuid=?", [status, uuid]);

  // Notify the org users involved.
  try {
    const userIds = await getTicketNotifyOrgUserIds(uuid);
    if (userIds.length) {
      await createNotificationForUsers({
        userIds,
        type: "support_status",
        title: "Support ticket status updated",
        message: `${ticket.subject} → ${status}`,
        link: `/org/support/${uuid}`,
        referenceId: uuid,
      });
    }
  } catch (e) {
    console.error("Support status notification failed:", e.message);
  }

  logAudit({
    ...getActorFromReq(req),
    action: "support.status_update",
    entityType: "support_ticket",
    entityId: uuid,
    details: { from: ticket.status, to: status },
    req,
  });

  const updated = await loadTicket(uuid);
  return ok(res, { ticket: updated }, "Ticket status updated");
}
