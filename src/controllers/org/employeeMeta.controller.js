import fs from "fs";
import path from "path";
import crypto from "crypto";
import ApiError from "../../utils/ApiError.js";
import { pool } from "../../config/db.js";
import { ok, created } from "../../utils/response.js";
import { assertUuid } from "../../utils/publicResponse.js";
import { DOCS_DIR } from "../../config/uploadPaths.js";
import { getActorFromReq, logAudit } from "../../utils/auditLog.js";
import { assertDocumentValid } from "../../utils/documentValidate.js";

function requireOrgId(req) {
  const orgId = req.scopeOrgId;
  if (!orgId) throw new ApiError(403, "Organization scope required");
  return orgId;
}

/* ─────────── DEPARTMENTS ─────────── */
export async function listDepartments(req, res) {
  const orgId = requireOrgId(req);
  const [rows] = await pool.query(
    "SELECT uuid, name FROM departments WHERE organization_id=? ORDER BY name",
    [orgId]
  );
  return ok(res, { items: rows }, "Departments");
}

export async function createDepartment(req, res) {
  const orgId = requireOrgId(req);
  const name = String(req.body?.name ?? "").trim();
  if (!name) throw new ApiError(400, "name is required");
  const [dup] = await pool.query(
    "SELECT uuid FROM departments WHERE organization_id=? AND name=?",
    [orgId, name]
  );
  if (dup.length) throw new ApiError(409, "Department already exists");
  const [r] = await pool.query(
    "INSERT INTO departments (uuid, organization_id, name) VALUES (UUID(), ?, ?)",
    [orgId, name]
  );
  const [[row]] = await pool.query("SELECT uuid, name FROM departments WHERE id=?", [r.insertId]);
  logAudit({ ...getActorFromReq(req), action: "department.create", entityType: "department", entityId: row.uuid, details: { name }, req });
  return created(res, row, "Department created");
}

export async function deleteDepartment(req, res) {
  const orgId = requireOrgId(req);
  const { uuid } = req.params;
  assertUuid(uuid, "Department UUID");
  const [rows] = await pool.query(
    "SELECT id FROM departments WHERE uuid=? AND organization_id=?",
    [uuid, orgId]
  );
  if (!rows.length) throw new ApiError(404, "Department not found");
  await pool.query("DELETE FROM departments WHERE id=?", [rows[0].id]);
  logAudit({ ...getActorFromReq(req), action: "department.delete", entityType: "department", entityId: uuid, req });
  return ok(res, {}, "Department deleted");
}

/* ─────────── DESIGNATIONS ─────────── */
export async function listDesignations(req, res) {
  const orgId = requireOrgId(req);
  const [rows] = await pool.query(
    "SELECT uuid, name FROM designations WHERE organization_id=? ORDER BY name",
    [orgId]
  );
  return ok(res, { items: rows }, "Designations");
}

export async function createDesignation(req, res) {
  const orgId = requireOrgId(req);
  const name = String(req.body?.name ?? "").trim();
  if (!name) throw new ApiError(400, "name is required");
  const [dup] = await pool.query(
    "SELECT uuid FROM designations WHERE organization_id=? AND name=?",
    [orgId, name]
  );
  if (dup.length) throw new ApiError(409, "Designation already exists");
  const [r] = await pool.query(
    "INSERT INTO designations (uuid, organization_id, name) VALUES (UUID(), ?, ?)",
    [orgId, name]
  );
  const [[row]] = await pool.query("SELECT uuid, name FROM designations WHERE id=?", [r.insertId]);
  logAudit({ ...getActorFromReq(req), action: "designation.create", entityType: "designation", entityId: row.uuid, details: { name }, req });
  return created(res, row, "Designation created");
}

export async function deleteDesignation(req, res) {
  const orgId = requireOrgId(req);
  const { uuid } = req.params;
  assertUuid(uuid, "Designation UUID");
  const [rows] = await pool.query(
    "SELECT id FROM designations WHERE uuid=? AND organization_id=?",
    [uuid, orgId]
  );
  if (!rows.length) throw new ApiError(404, "Designation not found");
  await pool.query("DELETE FROM designations WHERE id=?", [rows[0].id]);
  logAudit({ ...getActorFromReq(req), action: "designation.delete", entityType: "designation", entityId: uuid, req });
  return ok(res, {}, "Designation deleted");
}

/* ─────────── EMPLOYEE DOCUMENTS ─────────── */
export async function listEmployeeDocuments(req, res) {
  const { uuid } = req.params;
  assertUuid(uuid, "Employee UUID");
  const [rows] = await pool.query(
    `SELECT d.uuid, d.employee_uuid, d.document_type, d.file_name, d.file_path, d.file_size, d.uploaded_at, d.created_at
     FROM employee_documents d
     JOIN employees e ON e.uuid = d.employee_uuid
     WHERE d.employee_uuid = ? AND e.organization_id = ?`,
    [uuid, req.scopeOrgId || 0]
  );
  return ok(res, { items: rows }, "Employee documents");
}

export async function uploadEmployeeDocuments(req, res) {
  const { uuid } = req.params;
  assertUuid(uuid, "Employee UUID");
  const orgId = requireOrgId(req);
  const [empRows] = await pool.query("SELECT uuid FROM employees WHERE uuid=? AND organization_id=?", [uuid, orgId]);
  if (!empRows.length) throw new ApiError(404, "Employee not found");

  const files = req.files;
  if (!files || !files.length) throw new ApiError(400, "No files uploaded");

  const documentType = String(req.body?.document_type ?? "").trim() || null;
  const uploadedBy = req.admin?.uuid || req.user?.uuid || null;

  const inserted = [];
  for (const file of files) {
    const diskPath = path.join(DOCS_DIR, file.filename);

    // Corrupt-file guard per file. Fails open (warn-only) only when the
    // service is unreachable (timeout / connection refused); other service
    // failures — and a definite corruption verdict — throw a 400.
    await assertDocumentValid(diskPath);

    // Exact-file fingerprint for the auto-verification fast path. Only PDF and
    // image files get hashed — office/zip formats are skipped on purpose.
    let documentHash = null;
    const isPdfOrImage = file.mimetype === "application/pdf" || (file.mimetype && file.mimetype.startsWith("image/"));
    if (isPdfOrImage && fs.existsSync(diskPath)) {
      documentHash = crypto.createHash("sha256").update(fs.readFileSync(diskPath)).digest("hex");
    }

    const [r] = await pool.query(
      `INSERT INTO employee_documents
        (uuid, employee_uuid, document_type, file_name, file_path, file_size, uploaded_by_uuid, document_hash)
       VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?)`,
      [uuid, documentType, file.originalname, `documents/${file.filename}`, file.size, uploadedBy, documentHash]
    );
    const [[row]] = await pool.query(
      "SELECT uuid, employee_uuid, document_type, file_name, file_path, file_size, uploaded_at, created_at FROM employee_documents WHERE id=?",
      [r.insertId]
    );
    inserted.push(row);
  }

  logAudit({ ...getActorFromReq(req), action: "employee.document_upload", entityType: "employee", entityId: uuid, details: { count: inserted.length }, req });
  return created(res, { items: inserted }, "Documents uploaded");
}

export async function deleteEmployeeDocument(req, res) {
  const orgId = requireOrgId(req);
  const { docUuid } = req.params;
  assertUuid(docUuid, "Document UUID");
  const [rows] = await pool.query(
    `SELECT d.id, d.file_path FROM employee_documents d
     JOIN employees e ON e.uuid = d.employee_uuid
     WHERE d.uuid = ? AND e.organization_id = ?`,
    [docUuid, orgId]
  );
  if (!rows.length) throw new ApiError(404, "Document not found");
  const doc = rows[0];
  const diskPath = path.join(DOCS_DIR, path.basename(doc.file_path));
  try {
    if (fs.existsSync(diskPath)) fs.unlinkSync(diskPath);
  } catch (e) {
    console.error("Failed to delete document file:", e.message);
  }
  await pool.query("DELETE FROM employee_documents WHERE id=?", [doc.id]);
  logAudit({ ...getActorFromReq(req), action: "employee.document_delete", entityType: "document", entityId: docUuid, req });
  return ok(res, {}, "Document deleted");
}
