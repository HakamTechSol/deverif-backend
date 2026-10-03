import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { pool } from "../config/db.js";
import ApiError from "../utils/ApiError.js";
import { logAudit } from "../utils/auditLog.js";
import { ATTACHMENTS_DIR } from "../config/uploadPaths.js";

/**
 * Polymorphic entity attachments.
 *
 * One table, pointed at whatever owns the file through (entity_type,
 * entity_uuid). Modules keep their own domain rows and never grow a file column.
 *
 * SECURITY — two things this file exists to get right:
 *
 *   1. TENANT ISOLATION. attachments.entity_uuid cannot carry a foreign key (it
 *      references a different table per entity_type), so the database cannot
 *      stop one organization from reading another organization's file. Every
 *      query here is therefore scoped by organization_id, and the org filter is
 *      never optional or parameterised out.
 *
 *   2. PATH TRAVERSAL. file_path comes from an upload, so a stored value of
 *      "../../../.env/../src/server.js" would otherwise turn the download
 *      endpoint into an arbitrary-file-read. resolveAttachmentPath() re-anchors
 *      every path against ATTACHMENTS_DIR and rejects anything that escapes it,
 *      mirroring the guard in utils/payslipPdf.js.
 *
 * Deletion is SOFT (deleted_at). A row removed outright is unrecoverable, and an
 * audit trail that quietly drops evidence is worse than one keeping a tombstone.
 * The file on disk is left in place so a mistaken delete is reversible; a
 * separate retention job can sweep it later.
 */

const createSchema = z.object({
  orgId: z.number().int().positive(),
  entityType: z.string().min(2).max(60),
  entityUuid: z.string().min(1).max(64),
  uploadedByUuid: z.string().min(1).max(64).nullable().optional(),
  category: z.string().max(40).nullable().optional(),
  description: z.string().max(500).nullable().optional(),
});

const listSchema = z.object({
  orgId: z.number().int().positive(),
  entityType: z.string().min(2).max(60),
  entityUuid: z.string().min(1).max(64),
  category: z.string().max(40).nullable().optional(),
});

function validate(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new ApiError(400, `${first.path.join(".") || "input"}: ${first.message}`);
  }
  return result.data;
}

/**
 * Re-anchor a stored relative path inside ATTACHMENTS_DIR, refusing anything
 * that resolves outside it.
 *
 * Checked on the RESOLVED path rather than on the raw string: "../x" and
 * "a/../../x" look different but resolve identically, and an absolute path
 * would pass a naive startsWith check on the wrong root. `path.sep` is
 * appended to the root so a sibling directory sharing the prefix
 * (attachments-evil) cannot be reached either.
 */
export function resolveAttachmentPath(storedPath) {
  if (typeof storedPath !== "string" || !storedPath.trim()) {
    throw new ApiError(400, "Attachment path is empty");
  }
  const root = path.resolve(ATTACHMENTS_DIR);
  const resolved = path.resolve(root, storedPath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new ApiError(400, "Invalid attachment path");
  }
  return resolved;
}

/**
 * Record uploaded files against an entity.
 *
 * @param {object}   input
 * @param {Array<{filename:string, path:string, mimetype?:string, size?:number}>} input.files
 *        Multer file objects. `path` is the ABSOLUTE path multer wrote to; it
 *        is converted to a root-relative path here so nothing absolute is ever
 *        persisted.
 */
export async function createAttachments(input) {
  const data = validate(createSchema, input);
  const files = Array.isArray(input.files) ? input.files : [];
  if (!files.length) throw new ApiError(400, "No files were uploaded");

  const root = path.resolve(ATTACHMENTS_DIR);
  const uuids = files.map(() => randomUUID());
  const values = files.map((file, index) => {
    // multer gives an absolute path; store it relative to ATTACHMENTS_DIR.
    const absolute = path.resolve(file.path);
    const relative = path.relative(root, absolute);
    // Rejects a file whose path was already outside the upload root.
    const safeRelative = path.isAbsolute(relative) || relative.startsWith("..") ? path.basename(absolute) : relative;
    return [
      uuids[index],
      data.orgId,
      data.entityType,
      data.entityUuid,
      // Store the ORIGINAL name for display, but never trust it on read-back.
      String(file.originalname ?? file.filename ?? "file").slice(0, 255),
      safeRelative,
      file.mimetype ? String(file.mimetype).slice(0, 120) : null,
      Number.isFinite(file.size) ? file.size : 0,
      data.category ?? null,
      data.description ?? null,
      data.uploadedByUuid ?? null,
    ];
  });

  await pool.query(
    `INSERT INTO attachments
       (uuid, organization_id, entity_type, entity_uuid, file_name, file_path,
        mime_type, file_size, category, description, uploaded_by_uuid)
     VALUES ?`,
    [values]
  );

  logAudit({
    actorType: "user",
    actorId: data.uploadedByUuid ?? null,
    action: "attachment.create",
    entityType: data.entityType,
    entityId: data.entityUuid,
    details: { count: files.length, category: data.category ?? null },
  });

  // Re-read through the normal list path rather than assembling rows by hand,
  // so the caller always sees exactly what a later GET would return.
  return listAttachments({ ...data, category: null });
}

/** Every live attachment for one entity, oldest first. */
export async function listAttachments(input) {
  const data = validate(listSchema, input);
  const params = [data.orgId, data.entityType, data.entityUuid];
  let sql = `SELECT uuid, entity_type, entity_uuid, file_name, file_path, mime_type,
                    file_size, category, description, uploaded_by_uuid, created_at
               FROM attachments
              WHERE organization_id=? AND entity_type=? AND entity_uuid=? AND deleted_at IS NULL`;
  if (data.category) {
    sql += " AND category=?";
    params.push(data.category);
  }
  sql += " ORDER BY created_at ASC";

  const [rows] = await pool.query(sql, params);
  return rows;
}

/**
 * Soft-delete one attachment. Scoped by org AND by the owning entity, so a
 * caller cannot delete another organization's file even with a valid uuid.
 */
export async function removeAttachment({ orgId, attachmentUuid, actorUuid = null }) {
  const [rows] = await pool.query(
    `SELECT uuid, entity_type, entity_uuid, file_path
       FROM attachments
      WHERE uuid=? AND organization_id=? AND deleted_at IS NULL`,
    [attachmentUuid, orgId]
  );
  if (!rows.length) throw new ApiError(404, "Attachment not found");
  const row = rows[0];

  await pool.query(
    "UPDATE attachments SET deleted_at=NOW() WHERE uuid=? AND organization_id=? AND deleted_at IS NULL",
    [attachmentUuid, orgId]
  );

  logAudit({
    actorType: "user",
    actorId: actorUuid,
    action: "attachment.delete",
    entityType: row.entity_type,
    entityId: row.entity_uuid,
    details: { file: row.file_path },
  });

  return { uuid: attachmentUuid, deleted: true };
}

/**
 * Resolve a stored attachment to an absolute on-disk path, for streaming.
 * 404s for another org's attachment rather than leaking existence.
 */
export async function resolveForDownload({ orgId, attachmentUuid }) {
  const [rows] = await pool.query(
    `SELECT uuid, file_name, file_path, mime_type, file_size
       FROM attachments
      WHERE uuid=? AND organization_id=? AND deleted_at IS NULL`,
    [attachmentUuid, orgId]
  );
  if (!rows.length) throw new ApiError(404, "Attachment not found");

  const row = rows[0];
  const absolute = resolveAttachmentPath(row.file_path);

  try {
    await fs.access(absolute);
  } catch {
    // The row survives a manual file deletion, so this is reachable in
    // practice. Say the file is gone rather than returning a stream error.
    throw new ApiError(404, "Attachment file is no longer available");
  }

  return { ...row, absolutePath: absolute };
}