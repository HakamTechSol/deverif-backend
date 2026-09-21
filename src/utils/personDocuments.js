import { pool } from "../config/db.js";

/**
 * Record a verified document against a person.
 *
 * Called whenever a verification_request that has a linked_person_id is
 * marked as verified. Every verification appends a new person_documents row
 * (even if this exact document was verified before) so the table accumulates
 * a complete audit trail of every time the document was verified.
 *
 * The optional crossCheck result carries the OCR-extracted identity fields +
 * internal-consistency flag produced at approval time (see
 * buildDocumentCrossCheck). It is cached on the row so a future NADRA bulk
 * script can re-verify without re-running OCR. When no cross-check was run the
 * match_status column simply keeps its 'not_checked' DEFAULT.
 *
 * @param {object} vr            verification_requests row (must include id, linked_person_id, document_type, document_hash)
 * @param {number|null} organizationId  organizations.id that performed the verification
 * @param {object|null} crossCheck      { extractedName, extractedCnicHash, matchStatus, reason } or null
 */
export async function recordPersonDocument(vr, organizationId = null, crossCheck = null) {
  if (!vr?.linked_person_id) return;
  const cc = crossCheck && typeof crossCheck === "object" ? crossCheck : null;
  await pool.query(
    `INSERT INTO person_documents
       (person_id, document_type, document_hash,
        verified_by_organization_id, verified_by_verification_request_id,
        verified_at, status,
        document_extracted_name, document_extracted_cnic_hash, match_status)
     VALUES (?, ?, ?, ?, ?, NOW(), 'verified', ?, ?, ?)`,
    [
      vr.linked_person_id,
      vr.document_type != null ? String(vr.document_type) : null,
      vr.document_hash || null,
      organizationId || null,
      vr.id,
      cc?.extractedName || null,
      cc?.extractedCnicHash || null,
      cc?.matchStatus ?? "not_checked",
    ]
  );
}