import crypto from "crypto";
import ApiError from "../utils/ApiError.js";
import { pool } from "../config/db.js";
import { ok, created } from "../utils/response.js";
import { assertUuid } from "../utils/publicResponse.js";
import { parsePagination, paginatedResponse } from "../utils/pagination.js";
import { createNotificationForUsers } from "./notification.controller.js";
import { logAudit, getActorFromReq } from "../utils/auditLog.js";
import { OPEN_TICKET_NEEDS_ADMIN_REPLY } from "../utils/supportTicketPredicates.js";
import { queueNotificationEmail } from "../services/notificationEmail.service.js";

const VALID_PRIORITIES = ["low", "medium", "high"];
const VALID_STATUSES = ["open", "in_progress", "resolved", "closed"];
const VALID_CATEGORIES = ["it", "hr", "admin", "payroll"];

export const SUPPORT_CATEGORIES = VALID_CATEGORIES;
export const TICKET_ROLES = {
  ORG_ADMIN: "org_admin",
  SYSTEM_ADMIN: "system_admin",
};

const TICKET_SELECT = `SELECT t.id, t.uuid, t.subject, t.description, t.category, t.priority, t.status,
        t.assigned_to_role, t.assigned_to_role AS assigned_role, t.assigned_to_uuid,
        DATE_FORMAT(t.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
        DATE_FORMAT(t.updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at,
        t.organization_id,
        o.uuid AS organization_uuid,
        o.name AS organization_name,
        t.raised_by_uuid,
        raiser.full_name AS raised_by_name,
        raiser.email AS raised_by_email,
        raiser.org_role AS raised_by_role,
        COALESCE(ticket_department.name, (SELECT dp.name
           FROM employees requester_employee
           LEFT JOIN departments dp ON dp.id = requester_employee.department_id
          WHERE requester_employee.organization_id = t.organization_id
            AND (requester_employee.linked_user_uuid = raiser.uuid
              OR (requester_employee.email = raiser.email AND raiser.email IS NOT NULL))
          ORDER BY (requester_employee.linked_user_uuid = raiser.uuid) DESC, requester_employee.id DESC
          LIMIT 1)) AS raised_by_department,
        COALESCE(assignee.full_name, assignee_admin.full_name) AS assigned_to_name
 FROM support_tickets t
 LEFT JOIN organizations o ON o.id = t.organization_id
 LEFT JOIN departments ticket_department ON ticket_department.id = t.department_id
 LEFT JOIN users raiser ON raiser.uuid = t.raised_by_uuid
 LEFT JOIN users assignee ON assignee.uuid = t.assigned_to_uuid
 LEFT JOIN admin_profiles assignee_admin ON assignee_admin.uuid = t.assigned_to_uuid`;

const SYSTEM_TIER_PREDICATE =
  "(t.assigned_to_role = 'system_admin' OR (t.assigned_to_role IS NULL AND raiser.org_role = 'org_admin'))";

function orgIdFrom(req) {
  return req.scopeOrgId ?? req.user?.organization ?? null;
}

function isOrgAdmin(req) {
  return req.user?.org_role === TICKET_ROLES.ORG_ADMIN;
}

/** The role that owns the next action for a ticket. */
export function targetRoleFor(ticket) {
  return (
    ticket?.assigned_to_role ||
    ticket?.assigned_role ||
    (ticket?.raised_by_role === TICKET_ROLES.ORG_ADMIN
      ? TICKET_ROLES.SYSTEM_ADMIN
      : TICKET_ROLES.ORG_ADMIN)
  );
}

function normalizeCategory(value, fallback = "it") {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const category = String(value).trim().toLowerCase();
  return VALID_CATEGORIES.includes(category) ? category : null;
}

async function getAdminUuids() {
  const [rows] = await pool.query(
    "SELECT uuid FROM admin_profiles WHERE status='active' OR status IS NULL"
  );
  return rows.map((r) => r.uuid);
}

async function getOrgAdminUuids(orgId, excludeUuid) {
  let query =
    "SELECT uuid FROM users WHERE organization=? AND org_role='org_admin' AND status='active'";
  const params = [orgId];
  if (excludeUuid) {
    query += " AND uuid<>?";
    params.push(excludeUuid);
  }
  query += " ORDER BY id ASC";
  const [rows] = await pool.query(query, params);
  return rows.map((r) => r.uuid).filter(Boolean);
}

async function resolveTicketAssignment(orgId, raiser) {
  if (raiser?.org_role === TICKET_ROLES.ORG_ADMIN) {
    // Org Admin -> System Admin. The platform admin pool is not a single person,
    // so the tier is recorded and every active System Admin is notified.
    return { role: TICKET_ROLES.SYSTEM_ADMIN, uuid: null };
  }

  // Employee / Sub-Admin -> their Organization Admin. Pick a concrete org admin
  // when one exists so the ticket is visibly assigned, while the role remains the
  // routing source of truth for organizations with several admins.
  const [rows] = await pool.query(
    `SELECT uuid FROM users
      WHERE organization=? AND org_role='org_admin' AND status='active'
      ORDER BY id ASC LIMIT 1`,
    [orgId]
  );
  return { role: TICKET_ROLES.ORG_ADMIN, uuid: rows[0]?.uuid ?? null };
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

async function notifySystemAdmins({ title, message, link, referenceId, type, email }) {
  const adminIds = await getAdminUuids();
  if (!adminIds.length) return;
  await createNotificationForUsers({
    userIds: adminIds,
    type,
    title,
    message,
    link,
    referenceId,
    email,
  });
}

async function notifyOrgAdmins({ orgId, excludeUuid, title, message, link, referenceId, type, email }) {
  const adminIds = await getOrgAdminUuids(orgId, excludeUuid);
  if (!adminIds.length) return;
  await createNotificationForUsers({
    userIds: adminIds,
    type,
    title,
    message,
    link,
    referenceId,
    email,
  });
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
            COALESCE(u.email, a.email, '') AS replied_by_email,
            u.org_role AS replied_by_org_role
     FROM support_ticket_replies r
     LEFT JOIN users u ON u.uuid = r.replied_by_uuid
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

/**
 * Enforce the 2-tier visibility matrix on a single ticket.
 *
 *  - Employee / Sub-Admin: only tickets they raised themselves.
 *  - Org Admin: their organization's inbound tickets (raised by employees or
 *    sub-admins and routed to the org_admin tier) plus their own outbound
 *    tickets to the System Admin tier.
 *  - System Admin: only tickets routed to the system_admin tier.
 */
function assertTicketVisible(req, ticket) {
  if (req.admin) {
    if (targetRoleFor(ticket) !== TICKET_ROLES.SYSTEM_ADMIN) {
      throw new ApiError(403, "This ticket is not assigned to the System Admin");
    }
    return;
  }

  if (!req.user) throw new ApiError(401, "Unauthorized");
  const orgId = orgIdFrom(req);

  if (isOrgAdmin(req)) {
    const ownTicket = ticket.raised_by_uuid === req.user.uuid;
    const orgInbound =
      Number(ticket.organization_id) === Number(orgId) &&
      targetRoleFor(ticket) === TICKET_ROLES.ORG_ADMIN;
    if (!ownTicket && !orgInbound) {
      throw new ApiError(403, "This ticket is not visible to your organization admin account");
    }
    return;
  }

  if (ticket.raised_by_uuid !== req.user.uuid) {
    throw new ApiError(403, "You can only access support tickets you raised");
  }
}

function replyTypeFor(req, ticket) {
  if (!req.user) return "admin";
  const handlesOrgQueue =
    isOrgAdmin(req) &&
    targetRoleFor(ticket) === TICKET_ROLES.ORG_ADMIN &&
    ticket.raised_by_uuid !== req.user.uuid;
  return handlesOrgQueue ? "admin" : "org_user";
}

function actorLabel(req) {
  if (req.admin) return "system_admin";
  return req.user?.org_role ?? "org_user";
}

// ---------------------------------------------------------------------------
// ORG side — employees/sub-admins raise to their Org Admin; Org Admins raise
// to the System Admin and also work their organization's inbound queue.
// ---------------------------------------------------------------------------

export async function listOrgTickets(req, res) {
  const { page, limit, offset } = parsePagination(req.query);
  const status = typeof req.query.status === "string" ? req.query.status.trim() : "";
  const priority = typeof req.query.priority === "string" ? req.query.priority.trim() : "";
  const category = typeof req.query.category === "string" ? req.query.category.trim().toLowerCase() : "";
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";

  const orgId = orgIdFrom(req);
  const conditions = [];
  const params = [];

  if (isOrgAdmin(req)) {
    // Inbound tickets for this organization (routed to the org_admin tier) plus
    // the org admin's own outbound tickets to the System Admin tier.
    conditions.push(
      "((t.organization_id = ? AND t.assigned_to_role = 'org_admin') OR t.raised_by_uuid = ?)"
    );
    params.push(orgId, req.user.uuid);
  } else {
    // Employees and sub-admins only ever see what they submitted themselves.
    conditions.push("t.organization_id = ?", "t.raised_by_uuid = ?");
    params.push(orgId, req.user.uuid);
  }

  if (status && VALID_STATUSES.includes(status)) {
    conditions.push("t.status = ?");
    params.push(status);
  }
  if (priority && VALID_PRIORITIES.includes(priority)) {
    conditions.push("t.priority = ?");
    params.push(priority);
  }
  if (category && VALID_CATEGORIES.includes(category)) {
    conditions.push("t.category = ?");
    params.push(category);
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
  const { subject, description, priority = "medium", department_uuid: departmentUuid } = req.body ?? {};
  const category = normalizeCategory(req.body?.category);

  if (!subject || !String(subject).trim()) throw new ApiError(400, "subject is required");
  if (!description || !String(description).trim()) throw new ApiError(400, "description is required");
  if (!VALID_PRIORITIES.includes(priority)) throw new ApiError(400, "priority must be low, medium, or high");
  if (!category) throw new ApiError(400, "category must be it, hr, admin, or payroll");

  const orgId = orgIdFrom(req);
  let departmentId = null;
  if (departmentUuid) {
    assertUuid(departmentUuid, "department_uuid");
    const [[department]] = await pool.query(
      "SELECT id FROM departments WHERE uuid = ? AND organization_id = ? LIMIT 1",
      [departmentUuid, orgId]
    );
    if (!department) throw new ApiError(400, "department_uuid is not a department in this organization");
    departmentId = department.id;
  } else {
    const [[employee]] = await pool.query(
      `SELECT department_id FROM employees
        WHERE organization_id = ? AND department_id IS NOT NULL
          AND (linked_user_uuid = ? OR (email = ? AND ? IS NOT NULL))
        ORDER BY (linked_user_uuid = ?) DESC, id DESC LIMIT 1`,
      [orgId, req.user.uuid, req.user.email ?? null, req.user.email ?? null, req.user.uuid]
    );
    departmentId = employee?.department_id ?? null;
  }
  const assignment = await resolveTicketAssignment(orgId, req.user);
  const uuid = crypto.randomUUID();

  await pool.query(
    `INSERT INTO support_tickets
       (uuid, organization_id, department_id, raised_by_uuid, subject, description, category,
        priority, assigned_to_role, assigned_to_uuid)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      uuid,
      orgId,
      departmentId,
      req.user.uuid,
      String(subject).trim(),
      String(description).trim(),
      category,
      priority,
      assignment.role,
      assignment.uuid,
    ]
  );

  const ticket = await loadTicket(uuid);

  // Route the notification to the tier that now owns the ticket.
  try {
    if (assignment.role === TICKET_ROLES.SYSTEM_ADMIN) {
      await notifySystemAdmins({
        type: "support_ticket",
        title: "New support ticket from an organization admin",
        message: `${req.user.full_name} (${ticket.organization_name}) — ${ticket.subject}`,
        link: `/admin/support/${uuid}`,
        referenceId: uuid,
        email: {
          category: "support",
          eventKey: `support:${uuid}:created:system`,
          subject: `New support ticket: ${ticket.subject}`,
          title: "New support ticket from an organization",
          message: `${req.user.full_name} from ${ticket.organization_name} opened a ticket: ${ticket.subject}`,
        },
      });
    } else {
      await notifyOrgAdmins({
        orgId,
        excludeUuid: req.user.uuid,
        type: "support_ticket",
        title: "New support ticket",
        message: `${req.user.full_name} — ${ticket.subject}`,
        link: `/org/support/${uuid}`,
        referenceId: uuid,
        email: {
          category: "support",
          eventKey: `support:${uuid}:created:org`,
          subject: `New support ticket: ${ticket.subject}`,
          title: "New support ticket",
          message: `${req.user.full_name} opened a support ticket: ${ticket.subject}`,
        },
      });
    }
    await queueNotificationEmail({
      userUuid: req.user.uuid,
      category: "support",
      eventKey: `support:${uuid}:receipt:${req.user.uuid}`,
      subject: `Support ticket received: ${ticket.subject}`,
      title: "We received your support ticket",
      message: `Your ticket “${ticket.subject}” was received. Our support team will update you by email when they reply or change its status.`,
      actionUrl: `/org/support/${uuid}`,
    });
  } catch (e) {
    console.error("Support ticket notification failed:", e.message);
  }

  logAudit({
    ...getActorFromReq(req),
    action: "support.ticket_create",
    entityType: "support_ticket",
    entityId: uuid,
    details: {
      subject: ticket.subject,
      priority,
      category,
      assigned_to_role: assignment.role,
      assigned_to_uuid: assignment.uuid,
    },
    req,
  });

  return created(res, { ticket }, "Support ticket created");
}

export async function getOrgTicket(req, res) {
  const { uuid } = req.params;
  const ticket = await loadTicket(uuid);
  assertTicketVisible(req, ticket);
  const replies = await loadReplies(uuid);
  return ok(res, { ticket, replies }, "Support ticket");
}

export async function addOrgReply(req, res) {
  const { uuid } = req.params;
  const { message } = req.body ?? {};

  const ticket = await loadTicket(uuid);
  assertTicketVisible(req, ticket);
  assertOpenForReply(ticket);
  if (!message || !String(message).trim()) throw new ApiError(400, "message is required");

  const repliedByType = replyTypeFor(req, ticket);
  const replyUuid = crypto.randomUUID();
  await pool.query(
    `INSERT INTO support_ticket_replies (uuid, ticket_uuid, replied_by_uuid, replied_by_type, message)
     VALUES (?, ?, ?, ?, ?)`,
    [replyUuid, uuid, req.user.uuid, repliedByType, String(message).trim()]
  );
  await pool.query("UPDATE support_tickets SET updated_at=NOW() WHERE uuid=?", [uuid]);

  try {
    if (targetRoleFor(ticket) === TICKET_ROLES.SYSTEM_ADMIN) {
      // The requester is an org admin and the platform team owns the reply.
      await notifySystemAdmins({
        type: "support_reply",
        title: "New reply on an organization-admin ticket",
        message: `${req.user.full_name} replied: ${ticket.subject}`,
        link: `/admin/support/${uuid}`,
        referenceId: uuid,
        email: {
          category: "support",
          eventKey: `support:${uuid}:reply:${replyUuid}`,
          subject: `New reply on support ticket: ${ticket.subject}`,
          title: "New reply on a support ticket",
          message: `${req.user.full_name} replied to: ${ticket.subject}`,
        },
      });
    } else if (repliedByType === "admin") {
      // An org admin answered an employee/sub-admin ticket: notify the requester
      // and anyone else from the organization participating in the thread.
      const userIds = (await getTicketNotifyOrgUserIds(uuid)).filter(
        (id) => id !== req.user.uuid
      );
      if (userIds.length) {
        await createNotificationForUsers({
          userIds,
          type: "support_reply",
          title: "Support update on your ticket",
          message: `${req.user.full_name} replied: ${ticket.subject}`,
          link: `/org/support/${uuid}`,
          referenceId: uuid,
          email: {
            category: "support",
            eventKey: `support:${uuid}:reply:${replyUuid}`,
            subject: `Support team replied: ${ticket.subject}`,
            title: "Support team replied to your ticket",
            message: `There is a new reply on “${ticket.subject}”. Sign in to read it securely.`,
          },
        });
      }
    } else {
      await notifyOrgAdmins({
        orgId: ticket.organization_id,
        excludeUuid: req.user.uuid,
        type: "support_reply",
        title: "New reply on support ticket",
        message: `${req.user.full_name} replied: ${ticket.subject}`,
        link: `/org/support/${uuid}`,
        referenceId: uuid,
        email: {
          category: "support",
          eventKey: `support:${uuid}:reply:${replyUuid}`,
          subject: `New reply on support ticket: ${ticket.subject}`,
          title: "New reply on a support ticket",
          message: `${req.user.full_name} replied to: ${ticket.subject}`,
        },
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
    details: { by: repliedByType, role: actorLabel(req) },
    req,
  });

  const replies = await loadReplies(uuid);
  const updated = await loadTicket(uuid);
  return created(res, { ticket: updated, replies }, "Reply added");
}

// ---------------------------------------------------------------------------
// ADMIN side — System Admins own the org-admin -> system-admin tier.
// ---------------------------------------------------------------------------

export async function listAdminTickets(req, res) {
  const { page, limit, offset } = parsePagination(req.query);
  const status = typeof req.query.status === "string" ? req.query.status.trim() : "";
  const priority = typeof req.query.priority === "string" ? req.query.priority.trim() : "";
  const category = typeof req.query.category === "string" ? req.query.category.trim().toLowerCase() : "";
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";

  const conditions = [SYSTEM_TIER_PREDICATE];
  const params = [];

  if (status && VALID_STATUSES.includes(status)) {
    if (status === "open") conditions.push(OPEN_TICKET_NEEDS_ADMIN_REPLY);
    conditions.push("t.status = ?");
    params.push(status);
  }
  if (priority && VALID_PRIORITIES.includes(priority)) {
    conditions.push("t.priority = ?");
    params.push(priority);
  }
  if (category && VALID_CATEGORIES.includes(category)) {
    conditions.push("t.category = ?");
    params.push(category);
  }
  if (search) {
    conditions.push(
      "(t.subject LIKE ? OR t.description LIKE ? OR o.name LIKE ? OR raiser.email LIKE ? OR raiser.full_name LIKE ?)"
    );
    const like = `%${search}%`;
    params.push(like, like, like, like, like);
  }

  const whereClause = `WHERE ${conditions.join(" AND ")}`;

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
  assertTicketVisible(req, ticket);
  const replies = await loadReplies(uuid);
  return ok(res, { ticket, replies }, "Support ticket");
}

export async function addAdminReply(req, res) {
  const { uuid } = req.params;
  const { message } = req.body ?? {};

  const ticket = await loadTicket(uuid);
  assertTicketVisible(req, ticket);
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
        email: {
          category: "support",
          eventKey: `support:${uuid}:reply:${replyUuid}`,
          subject: `Support team replied: ${ticket.subject}`,
          title: "Support team replied to your ticket",
          message: `There is a new reply on “${ticket.subject}”. Sign in to read it securely.`,
        },
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
    details: { by: "admin", role: "system_admin" },
    req,
  });

  const replies = await loadReplies(uuid);
  const updated = await loadTicket(uuid);
  return created(res, { ticket: updated, replies }, "Reply added");
}

/**
 * Unified status transition.
 *
 * System Admins may resolve/close only tickets routed to them. Org Admins may
 * resolve/close tickets in their own organization's inbound queue, and may close
 * their own outbound tickets to the System Admin.
 */
export async function updateTicketStatus(req, res) {
  const { uuid } = req.params;
  const { status } = req.body ?? {};

  if (!VALID_STATUSES.includes(status)) {
    throw new ApiError(400, "status must be open, in_progress, resolved, or closed");
  }

  const ticket = await loadTicket(uuid);
  assertTicketVisible(req, ticket);

  if (!req.admin && !isOrgAdmin(req)) {
    throw new ApiError(403, "Only an Organization Admin or System Admin can update ticket status");
  }

  await pool.query("UPDATE support_tickets SET status=?, updated_at=NOW() WHERE uuid=?", [
    status,
    uuid,
  ]);

  const statusChanged = ticket.status !== status;
  if (statusChanged) try {
    const orgUserIds = await getTicketNotifyOrgUserIds(uuid);
    const statusEmail = {
      category: "support",
      eventKey: `support:${uuid}:status:${ticket.status}:${status}:${new Date(ticket.updated_at).getTime()}`,
      subject: `Support ticket ${status.replace("_", " ")}: ${ticket.subject}`,
      title: "Support ticket status updated",
      message: `Ticket “${ticket.subject}” is now ${status.replace("_", " ")}.`,
    };
    if (req.admin) {
      // System Admin -> notify the org side of the conversation.
      if (orgUserIds.length) {
        await createNotificationForUsers({
          userIds: orgUserIds,
          type: "support_status",
          title: "Support ticket status updated",
          message: `${ticket.subject} → ${status}`,
          link: `/org/support/${uuid}`,
          referenceId: uuid,
          email: statusEmail,
        });
      }
    } else if (targetRoleFor(ticket) === TICKET_ROLES.SYSTEM_ADMIN) {
      // Org Admin acting on their own outgoing ticket -> inform the platform team.
      await notifySystemAdmins({
        type: "support_status",
        title: "Organization admin updated a support ticket",
        message: `${ticket.subject} → ${status}`,
        link: `/admin/support/${uuid}`,
        referenceId: uuid,
        email: statusEmail,
      });
    } else {
      const recipients = orgUserIds.filter((id) => id !== req.user.uuid);
      if (recipients.length) {
        await createNotificationForUsers({
          userIds: recipients,
          type: "support_status",
          title: "Support ticket status updated",
          message: `${ticket.subject} → ${status}`,
          link: `/org/support/${uuid}`,
          referenceId: uuid,
          email: statusEmail,
        });
      }
    }
  } catch (e) {
    console.error("Support status notification failed:", e.message);
  }

  logAudit({
    ...getActorFromReq(req),
    action: "support.status_update",
    entityType: "support_ticket",
    entityId: uuid,
    details: { from: ticket.status, to: status, role: actorLabel(req) },
    req,
  });

  const updated = await loadTicket(uuid);
  return ok(res, { ticket: updated }, "Ticket status updated");
}

// ---------------------------------------------------------------------------
// Unified entry points used by /api/v1/support/tickets. They dispatch to the
// tier-specific implementation above based on the authenticated principal.
// ---------------------------------------------------------------------------

export async function listTickets(req, res) {
  if (req.admin) return listAdminTickets(req, res);
  if (req.user) return listOrgTickets(req, res);
  throw new ApiError(401, "Unauthorized");
}

export async function getTicket(req, res) {
  if (req.admin) return getAdminTicket(req, res);
  if (req.user) return getOrgTicket(req, res);
  throw new ApiError(401, "Unauthorized");
}

export async function addReply(req, res) {
  if (req.admin) return addAdminReply(req, res);
  if (req.user) return addOrgReply(req, res);
  throw new ApiError(401, "Unauthorized");
}
