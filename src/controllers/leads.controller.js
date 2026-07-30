import ApiError from "../utils/ApiError.js";
import { pool } from "../config/db.js";
import { created, ok } from "../utils/response.js";
import { parsePagination, paginatedResponse } from "../utils/pagination.js";
import { sendLeadNotificationEmail } from "../utils/mailer.js";

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
    whereClause += " AND (name LIKE ? OR email LIKE ? OR phone LIKE ? OR message LIKE ?)";
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM contact_leads ${whereClause}`,
    params
  );
  const [rows] = await pool.query(
    `SELECT * FROM contact_leads ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  return ok(res, paginatedResponse(rows, total, page, limit), "Contact leads");
}

export async function listAccessRequests(req, res) {
  const { page, limit, offset } = parsePagination(req.query);
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";

  let whereClause = "WHERE 1=1";
  const params = [];

  if (search) {
    whereClause += " AND (organization_name LIKE ? OR contact_name LIKE ? OR email LIKE ? OR phone LIKE ?)";
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM access_requests ${whereClause}`,
    params
  );
  const [rows] = await pool.query(
    `SELECT * FROM access_requests ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  return ok(res, paginatedResponse(rows, total, page, limit), "Access requests");
}
