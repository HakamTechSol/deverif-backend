import fs from "fs";
import path from "path";
import ApiError from "../utils/ApiError.js";
import { pool } from "../config/db.js";
import { DOCS_DIR } from "../config/uploadPaths.js";
import {
  qrSigningConfigured,
  verifyQrSignature,
} from "../utils/qrCertificate.js";

const QR_TOKEN_PATTERN = /^[0-9a-f]{64}$/i;
const DOC_FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REQUEST_DOC_PATH_PREFIX = "/uploads/documents/";
const EMPLOYEE_DOC_PATH_PREFIX = "documents/";

/** Validate a raw filename param; returns it unchanged or null (→ 404). */
function safeDocumentFilename(raw) {
  if (typeof raw !== "string" || !raw) return null;
  const name = raw.trim();
  if (!DOC_FILENAME_PATTERN.test(name)) return null;
  return name;
}

/** Serve a verified document filename from DOCS_DIR with an attachment disposition. */
function streamDocument(res, filename) {
  const filePath = path.join(DOCS_DIR, filename);
  if (!filePath.startsWith(DOCS_DIR + path.sep)) {
    throw new ApiError(404, "Document not found");
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new ApiError(404, "Document not found");
  }
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(filePath);
}

/**
 * Authenticated download of uploaded documents.
 * Route: GET /api/v1/documents/:type/:filename  (authAny)
 *
 * Ownership:
 *  - type "requests" — platform admin (req.admin), the requester who created the
 *    request (vr.user_id), or the issuing organization (vr.issuing_organization_id).
 *  - type "employees" — only users of the employee's organization
 *    (e.organization_id === req.user.organization). Platform admins are excluded,
 *    matching the org-scoped module rule.
 * All "not found" and "not allowed" cases return the same 404 so existence is never
 * leaked.
 */
export async function getAuthenticatedDocument(req, res) {
  const { type, filename: rawFilename } = req.params;
  const filename = safeDocumentFilename(rawFilename);

  if ((type !== "requests" && type !== "employees") || !filename) {
    throw new ApiError(404, "Document not found");
  }

  if (type === "requests") {
    const [rows] = await pool.query(
      `SELECT id, user_id, issuing_organization_id
       FROM verification_requests
       WHERE document_path=?
       LIMIT 1`,
      [REQUEST_DOC_PATH_PREFIX + filename]
    );

    if (!rows.length) throw new ApiError(404, "Document not found");

    const vr = rows[0];
    const isPlatformAdmin = Boolean(req.admin);
    const isRequester = req.user && vr.user_id === req.user.id;
    const isIssuingOrgAdmin =
      req.user &&
      req.user.organization &&
      vr.issuing_organization_id === req.user.organization;

    if (!(isPlatformAdmin || isRequester || isIssuingOrgAdmin)) {
      throw new ApiError(404, "Document not found");
    }

    return streamDocument(res, filename);
  }

  const [rows] = await pool.query(
    `SELECT ed.id, e.organization_id
     FROM employee_documents ed
     JOIN employees e ON e.uuid = ed.employee_uuid
     WHERE ed.file_path=?
     LIMIT 1`,
    [EMPLOYEE_DOC_PATH_PREFIX + filename]
  );

  if (!rows.length) throw new ApiError(404, "Document not found");

  const doc = rows[0];
  const isOrgAdmin =
    req.user && req.user.organization && doc.organization_id === req.user.organization;

  if (!isOrgAdmin) throw new ApiError(404, "Document not found");

  return streamDocument(res, filename);
}

/**
 * Public (no auth) access to the document of a VERIFIED verification request,
 * gated by the same QR token + HMAC signature checks as the public verify
 * endpoint. Only reachable by someone in possession of the QR token. Fails
 * closed with 404 on any invalid / forged / unverifiable input.
 * Route: GET /api/v1/verify/document/:filename?qr_token=...
 */
export async function streamPublicQrDocument(req, res) {
  const filename = safeDocumentFilename(req.params.filename);
  const qrToken = typeof req.query.qr_token === "string" ? req.query.qr_token : "";

  if (!filename || !QR_TOKEN_PATTERN.test(qrToken) || !qrSigningConfigured()) {
    return res.status(404).json({ success: false, message: "Not found" });
  }

  const [rows] = await pool.query(
    `SELECT vr.uuid, vr.status, vr.qr_token, vr.qr_signature, vr.document_path,
            vr.issuing_organization_id, vr.verified_at
     FROM verification_requests vr
     WHERE vr.qr_token=?`,
    [qrToken]
  );

  if (!rows.length) {
    return res.status(404).json({ success: false, message: "Not found" });
  }

  const vr = rows[0];

  if (vr.status !== "verified" || !vr.qr_signature) {
    return res.status(404).json({ success: false, message: "Not found" });
  }

  const signatureValid = verifyQrSignature({
    qrToken: vr.qr_token,
    requestUuid: vr.uuid,
    orgId: vr.issuing_organization_id,
    verifiedAtMillis: vr.verified_at ? new Date(vr.verified_at).getTime() : 0,
    signature: vr.qr_signature,
  });

  if (!signatureValid) {
    return res.status(404).json({ success: false, message: "Not found" });
  }

  if (!vr.document_path || path.basename(vr.document_path) !== filename) {
    return res.status(404).json({ success: false, message: "Not found" });
  }

  return streamDocument(res, filename);
}