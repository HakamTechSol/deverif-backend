import path from "path";
import fs from "fs";
import { pool } from "../config/db.js";
import { UPLOAD_ROOT, DOCS_DIR } from "../config/uploadPaths.js";
import { qrSigningConfigured, verifyQrSignature } from "./qrCertificate.js";

/**
 * The single fail-closed gate in front of BOTH public QR endpoints:
 *   GET /verify/:qr_token              (metadata)
 *   GET /verify/:qr_token/document     (the file itself)
 *
 * They used to carry near-identical copies of the same four checks, which is
 * how a metadata endpoint and a file endpoint end up disagreeing about what is
 * verifiable. Both call this instead, so a change to what counts as valid cannot
 * apply to one and not the other.
 *
 * Every rejection path returns null and the caller answers 404. Nothing here
 * distinguishes "no such token" from "forged signature" from "not verified": a
 * visitor must not be able to probe which of the three a given token failed.
 */

const QR_TOKEN_PATTERN = /^[0-9a-f]{64}$/i;

/** Env kill-switch for the document endpoint. Default: enabled. */
export function publicVerifyDocumentEnabled() {
  const raw = process.env.PUBLIC_VERIFY_SHOW_DOCUMENT;
  if (raw === undefined || raw === null || String(raw).trim() === "") return true;
  return !["false", "0", "no", "off"].includes(String(raw).trim().toLowerCase());
}

/**
 * Resolve a token to the request it authenticates, or null if it is not
 * verifiable. The caller MUST 404 on null.
 *
 * Checks, in order (each failing closed):
 *   1. the token is 64 hex characters,
 *   2. QR signing is configured (an unsigned deployment can prove nothing),
 *   3. a request row exists for it,
 *   4. that request is `verified` and carries a signature,
 *   5. the HMAC over (token, uuid, org id, verified_at) matches, compared with
 *      crypto.timingSafeEqual inside verifyQrSignature.
 */
export async function loadVerifiedRequestForPublicToken(qrToken) {
  if (typeof qrToken !== "string" || !QR_TOKEN_PATTERN.test(qrToken)) return null;
  if (!qrSigningConfigured()) return null;

  const [rows] = await pool.query(
    `SELECT vr.uuid, vr.document_type, vr.status, vr.verified_at,
            vr.qr_token, vr.qr_signature, vr.document_path, vr.document_format,
            vr.document_hash, vr.document_owner_name, vr.linked_person_id,
            vr.issuing_organization_id, vr.unmatched_org_id,
            o.name AS org_name, uo.name AS unmatched_org_name,
            p.full_name AS person_name, p.cnic_encrypted
     FROM verification_requests vr
     LEFT JOIN organizations o ON o.id = vr.issuing_organization_id
     LEFT JOIN unmatched_organizations uo ON uo.id = vr.unmatched_org_id
     LEFT JOIN persons p ON p.id = vr.linked_person_id
     WHERE vr.qr_token=?`,
    [qrToken]
  );

  if (!rows.length) return null;

  const vr = rows[0];
  if (vr.status !== "verified" || !vr.qr_signature) return null;

  const signatureValid = verifyQrSignature({
    qrToken: vr.qr_token,
    requestUuid: vr.uuid,
    orgId: vr.issuing_organization_id,
    verifiedAtMillis: vr.verified_at ? new Date(vr.verified_at).getTime() : 0,
    signature: vr.qr_signature,
  });
  if (!signatureValid) return null;

  return vr;
}

/**
 * Classify a stored document by its extension, from a SERVER-SIDE allowlist.
 *
 * Never derived from anything the request or the stored file says about itself,
 * and never from a client-supplied header — only the file's own extension after
 * it has been resolved to a real path inside the uploads root. Anything not on
 * the list is "other": not previewable, and not given a Content-Type here.
 */
const PDF_EXTENSIONS = new Set(["pdf"]);
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif", "bmp"]);
const DOCX_EXTENSIONS = new Set(["docx"]);

export const PUBLIC_PREVIEW_MIME = {
  pdf: "application/pdf",
  image: "image/jpeg",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

export function classifyPublicDocument(documentPath) {
  const ext = path.extname(String(documentPath || "")).toLowerCase().replace(/^\./, "");
  if (PDF_EXTENSIONS.has(ext)) return "pdf";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (DOCX_EXTENSIONS.has(ext)) return "docx";
  return "other";
}

/**
 * Resolve a request's stored document to an absolute path, refusing anything
 * that does not land inside the uploads root.
 *
 * The value comes from the database rather than the request, but a database
 * value is still input as far as the filesystem is concerned: `../`,
 * an absolute path, or a symlink would all let a poisoned row read a file
 * outside the uploads root. Hence three independent checks — basename only,
 * path containment, and a realpath containment that also defeats symlinks.
 *
 * Returns null when the file is missing or escapes.
 */
export function resolvePublicDocumentPath(documentPath) {
  if (typeof documentPath !== "string" || !documentPath.trim()) return null;

  // 1. Only ever a bare filename. Anything with a separator or a parent
  //    reference is refused before the filesystem is involved.
  const base = path.basename(documentPath.trim());
  if (!base || base !== documentPath.trim().split(/[\\/]/).pop()) return null;
  if (base === "." || base === ".." || base.includes("/") || base.includes("\\")) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(base)) return null;

  const absolute = path.resolve(DOCS_DIR, base);

  // 2. Lexical containment, checked against the documents directory (which is
  //    itself inside UPLOAD_ROOT) so a sibling directory cannot be reached.
  const insideDir =
    absolute === DOCS_DIR || absolute.startsWith(DOCS_DIR + path.sep);
  const insideRoot =
    absolute === UPLOAD_ROOT || absolute.startsWith(UPLOAD_ROOT + path.sep);
  if (!insideDir || !insideRoot) return null;

  // 3. Real containment, which also rules out a symlink pointing outside.
  let realRoot;
  let realFile;
  try {
    realRoot = fs.realpathSync(DOCS_DIR);
    realFile = fs.realpathSync(absolute);
  } catch {
    return null;
  }
  if (realFile !== realRoot && !realFile.startsWith(realRoot + path.sep)) return null;

  let stat;
  try {
    stat = fs.statSync(realFile);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  return realFile;
}
