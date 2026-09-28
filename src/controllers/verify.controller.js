import { pool } from "../config/db.js";
import { ok } from "../utils/response.js";
import { decryptCnic } from "../utils/personCrypto.js";
import { certificateCodeFor, maskCnic } from "../utils/certificateCode.js";
import {
  loadVerifiedRequestForPublicToken,
  classifyPublicDocument,
  publicVerifyDocumentEnabled,
} from "../utils/publicVerifyGuard.js";

/**
 * Public (no auth) endpoint — validates a QR verification token and returns the
 * fields a verifier needs to identify WHICH document was verified: the person,
 * a masked CNIC, the document type and format, the issuing organization, the
 * date, and a short certificate code.
 *
 * What is deliberately absent: the full CNIC, the document's path on disk, its
 * hash unless the format supports byte-identical comparison, the requester, and
 * any organization-internal identifier. Fails closed (404) on any invalid /
 * forged / unverifiable token, via the shared guard.
 */

/** Decrypt the document owner's CNIC, or null if it cannot be read. */
function readMaskedCnic(row) {
  if (!row.cnic_encrypted) return null;
  try {
    return maskCnic(decryptCnic(row.cnic_encrypted));
  } catch (e) {
    // A rotated/missing encryption key, or a payload that fails its GCM tag.
    // Never surface the raw value and never fail the whole request over a
    // field that is a convenience for the reader.
    console.warn(`Could not read a CNIC for public verification (person ${row.linked_person_id}): ${e.message}`);
    return null;
  }
}

export async function verifyPublicQr(req, res) {
  const vr = await loadVerifiedRequestForPublicToken(req.params.qr_token);
  if (!vr) {
    return res.status(404).json({ success: false, message: "Not found" });
  }

  const organizationName = vr.org_name || vr.unmatched_org_name || null;
  const fileType = classifyPublicDocument(vr.document_path);
  const documentAvailable = fileType !== "other" && publicVerifyDocumentEnabled();

  return ok(
    res,
    {
      valid: true,
      status: vr.status,
      document_type: vr.document_type,
      // The name captured on the request; the linked person keeps the name it
      // was first created with, so it is the fallback rather than the source.
      person_name: vr.document_owner_name || vr.person_name || null,
      cnic_masked: readMaskedCnic(vr),
      organization_name: organizationName,
      verification_date: vr.verified_at ? new Date(vr.verified_at).toISOString() : null,
      certificate_code: certificateCodeFor(vr.qr_token),
      request_reference: vr.uuid,
      // Drives the preview card. `file_type` is what the file actually is;
      // `document_available` is whether this deployment is serving it.
      file_type: fileType === "other" ? null : fileType,
      document_available: documentAvailable,
      // Only for formats a visitor can meaningfully byte-compare against their
      // own copy -- a DOCX is re-zipped by most editors, so an equality check
      // there would report false negatives on an unaltered file. Withheld when
      // previews are off, because the hash exists only to support the preview:
      // it would otherwise let a visitor confirm they hold the right bytes
      // without ever being able to see the document.
      document_hash:
        documentAvailable && (fileType === "pdf" || fileType === "image")
          ? vr.document_hash ?? null
          : null,
    },
    "Verification confirmed"
  );
}
