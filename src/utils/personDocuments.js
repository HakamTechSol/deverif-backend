import { pool } from "../config/db.js";

/**
 * Record a verified document against a person.
 *
 * Called whenever a verification_request that has a linked_person_id is
 * marked as verified. Every verification appends a new person_documents row
 * (even if this exact document was verified before) so the table accumulates
 * a complete audit trail of every time the document was verified.
 *
 * @param {object} vr            verification_requests row (must include id, linked_person_id, document_type, document_hash)
 * @param {number|null} organizationId  organizations.id that performed the verification
 */
export async function recordPersonDocument(vr, organizationId = null) {
  if (!vr?.linked_person_id) return;
  await pool.query(
    `INSERT INTO person_documents
       (person_id, document_type, document_hash,
        verified_by_organization_id, verified_by_verification_request_id,
        verified_at, status)
     VALUES (?, ?, ?, ?, ?, NOW(), 'verified')`,
    [
      vr.linked_person_id,
      vr.document_type != null ? String(vr.document_type) : null,
      vr.document_hash || null,
      organizationId || null,
      vr.id,
    ]
  );
}