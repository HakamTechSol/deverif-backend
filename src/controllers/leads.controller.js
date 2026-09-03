import ApiError from "../utils/ApiError.js";
import { pool } from "../config/db.js";
import { created, ok } from "../utils/response.js";
import { parsePagination, paginatedResponse } from "../utils/pagination.js";
import { sendLeadNotificationEmail } from "../utils/mailer.js";
import { logAudit, getActorFromReq } from "../utils/auditLog.js";

const CONTACT_STATUSES = ["new", "contacted", "closed"];
const ACCESS_STATUSES = ["new", "contacted", "onboarded", "rejected"];

export async function submitContact(req, res) {
  const { name, email, phone, message } = req.body;

  if (!name || !String(name).trim()) throw new ApiError(400, "name is required");
  if (!email || !String(email).trim()) throw new ApiError(400, "email is required");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) throw new ApiError(400, "Invalid email format");
  if (message && String(message).length > 2000) throw new ApiError(400, "message must be 2000 characters or fewer");

  const [result] = await pool.query(
    `INSERT INTO contact_leads (name, email, phone, message, created_at) VALUES (?, ?, ?, ?, NOW())`,
    [String(name).trim(), String(email).trim(), phone ? String(phone).trim() : null, message ? String(message).trim() : null]
  );

  const [rows] = await pool.query("SELECT * FROM contact_leads WHERE id=?", [result.insertId]);

  sendLeadNotificationEmail({
    type: "contact",
    data: { name: rows[0].name, email: rows[0].email, phone: rows[0].phone, message: rows[0].message },
  }).catch((e) => console.error("Failed to send contact lead email:", e.message));

  return created(res, { lead: rows[0] }, "Thank you, we'll be in touch soon.");
}

export async function submitAccessRequest(req, res) {
  const { organization_name, contact_name, email, phone, company_size, message } = req.body;

  if (!organization_name || !String(organization_name).trim()) throw new ApiError(400, "organization_name is required");
  if (!contact_name || !String(contact_name).trim()) throw new ApiError(400, "contact_name is required");
  if (!email || !String(email).trim()) throw new ApiError(400, "email is required");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) throw new ApiError(400, "Invalid email format");

  const [result] = await pool.query(
    `INSERT INTO access_requests (organization_name, contact_name, email, phone, company_size, message, created_at) VALUES (?, ?, ?, ?, ?, ?, NOW())`,
    [
      String(organization_name).trim(),
      String(contact_name).trim(),
      String(email).trim(),
      phone ? String(phone).trim() : null,
      company_size ? String(company_size).trim() : null,
      message ? String(message).trim() : null,
    ]
  );

  const [rows] = await pool.query("SELECT * FROM access_requests WHERE id=?", [result.insertId]);

  sendLeadNotificationEmail({
    type: "access_request",
    data: {
      organization_name: rows[0].organization_name,
      contact_name: rows[0].contact_name,
      email: rows[0].email,
      phone: rows[0].phone,
      company_size: rows[0].company_size,
      message: rows[0].message,
    },
  }).catch((e) => console.error("Failed to send access request email:", e.message));

  return created(res, { request: rows[0] }, "Thanks! Our team will reach out shortly.");
}

export async function listContactLeads(req, res) {
  const { page, limit, offset } = parsePagination(req.query);
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";

  let whereClause = "WHERE 1=1";
  const params = [];

  if (search) {
    whereClause += " AND (cl.name LIKE ? OR cl.email LIKE ? OR cl.phone LIKE ? OR cl.message LIKE ?)";
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM contact_leads cl ${whereClause}`,
    params
  );
  const [rows] = await pool.query(
    `SELECT cl.*,
            lh.new_status AS latest_status,
            lh.notes AS latest_note,
            lh.changed_by_name AS latest_changed_by,
            lh.created_at AS latest_note_at
     FROM contact_leads cl
     LEFT JOIN lead_status_history lh
       ON lh.lead_type = 'contact' AND lh.lead_uuid = cl.uuid
       AND lh.id = (
         SELECT MAX(id) FROM lead_status_history
         WHERE lead_type = 'contact' AND lead_uuid = cl.uuid
       )
     ${whereClause}
     ORDER BY cl.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  return ok(res, paginatedResponse(rows, total, page, limit), "Contact leads");
}

export async function getContactLead(req, res) {
  const { uuid } = req.params;

  const [[lead]] = await pool.query("SELECT * FROM contact_leads WHERE uuid=?", [uuid]);
  if (!lead) throw new ApiError(404, "Contact lead not found");

  const [history] = await pool.query(
    `SELECT * FROM lead_status_history
     WHERE lead_type = 'contact' AND lead_uuid = ?
     ORDER BY created_at DESC`,
    [uuid]
  );

  return ok(res, { lead, history }, "Contact lead");
}

export async function updateContactLeadStatus(req, res) {
  const { uuid } = req.params;
  const { status, notes } = req.body;

  if (!status || !String(status).trim()) throw new ApiError(400, "status is required");
  const normalized = String(status).trim().toLowerCase();
  if (!CONTACT_STATUSES.includes(normalized)) {
    throw new ApiError(400, `Invalid status. Must be one of: ${CONTACT_STATUSES.join(", ")}`);
  }

  const [[lead]] = await pool.query("SELECT * FROM contact_leads WHERE uuid=?", [uuid]);
  if (!lead) throw new ApiError(404, "Contact lead not found");

  const oldStatus = lead.status;
  const notesText = notes ? String(notes).trim() : null;

  await pool.query("UPDATE contact_leads SET status=?, notes=? WHERE uuid=?", [normalized, notesText, uuid]);
  await pool.query(
    `INSERT INTO lead_status_history (lead_type, lead_uuid, old_status, new_status, notes, changed_by_admin_id, changed_by_name, created_at)
     VALUES ('contact', ?, ?, ?, ?, ?, ?, NOW())`,
    [uuid, oldStatus, normalized, notesText, req.admin?.id || null, req.admin?.full_name || "Admin"]
  );

  logAudit({
    ...getActorFromReq(req),
    action: "lead.contact.status_update",
    entityType: "contact_lead",
    entityId: uuid,
    details: { old_status: oldStatus, new_status: normalized, notes: notesText },
    req,
  });

  const [[updated]] = await pool.query("SELECT * FROM contact_leads WHERE uuid=?", [uuid]);
  return ok(res, { lead: updated }, "Status updated");
}

export async function listAccessRequests(req, res) {
  const { page, limit, offset } = parsePagination(req.query);
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";

  let whereClause = "WHERE 1=1";
  const params = [];

  if (search) {
    whereClause += " AND (ar.organization_name LIKE ? OR ar.contact_name LIKE ? OR ar.email LIKE ? OR ar.phone LIKE ?)";
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM access_requests ar ${whereClause}`,
    params
  );
  const [rows] = await pool.query(
    `SELECT ar.*,
            lh.new_status AS latest_status,
            lh.notes AS latest_note,
            lh.changed_by_name AS latest_changed_by,
            lh.created_at AS latest_note_at
     FROM access_requests ar
     LEFT JOIN lead_status_history lh
       ON lh.lead_type = 'access_request' AND lh.lead_uuid = ar.uuid
       AND lh.id = (
         SELECT MAX(id) FROM lead_status_history
         WHERE lead_type = 'access_request' AND lead_uuid = ar.uuid
       )
     ${whereClause}
     ORDER BY ar.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  return ok(res, paginatedResponse(rows, total, page, limit), "Access requests");
}

export async function getAccessRequest(req, res) {
  const { uuid } = req.params;

  const [[request]] = await pool.query("SELECT * FROM access_requests WHERE uuid=?", [uuid]);
  if (!request) throw new ApiError(404, "Access request not found");

  const [history] = await pool.query(
    `SELECT * FROM lead_status_history
     WHERE lead_type = 'access_request' AND lead_uuid = ?
     ORDER BY created_at DESC`,
    [uuid]
  );

  return ok(res, { request, history }, "Access request");
}

export async function updateAccessRequestStatus(req, res) {
  const { uuid } = req.params;
  const { status, notes } = req.body;

  if (!status || !String(status).trim()) throw new ApiError(400, "status is required");
  const normalized = String(status).trim().toLowerCase();
  if (!ACCESS_STATUSES.includes(normalized)) {
    throw new ApiError(400, `Invalid status. Must be one of: ${ACCESS_STATUSES.join(", ")}`);
  }

  const [[request]] = await pool.query("SELECT * FROM access_requests WHERE uuid=?", [uuid]);
  if (!request) throw new ApiError(404, "Access request not found");

  const oldStatus = request.status;
  const notesText = notes ? String(notes).trim() : null;

  await pool.query("UPDATE access_requests SET status=?, notes=? WHERE uuid=?", [normalized, notesText, uuid]);
  await pool.query(
    `INSERT INTO lead_status_history (lead_type, lead_uuid, old_status, new_status, notes, changed_by_admin_id, changed_by_name, created_at)
     VALUES ('access_request', ?, ?, ?, ?, ?, ?, NOW())`,
    [uuid, oldStatus, normalized, notesText, req.admin?.id || null, req.admin?.full_name || "Admin"]
  );

  logAudit({
    ...getActorFromReq(req),
    action: "lead.access_request.status_update",
    entityType: "access_request",
    entityId: uuid,
    details: { old_status: oldStatus, new_status: normalized, organization_name: request.organization_name, notes: notesText },
    req,
  });

  const [[updated]] = await pool.query("SELECT * FROM access_requests WHERE uuid=?", [uuid]);
  return ok(res, { request: updated }, "Status updated");
}
