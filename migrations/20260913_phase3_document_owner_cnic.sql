-- 2026-09-13 Phase 3.4 — drop verification_requests.document_owner_cnic.
--
-- The column stored the ENCRYPTED CNIC of the document owner app-trusting
-- the (unverified) claim for audits. It duplicated persons.cnic_encrypted:
-- the same encryption output is always written to a persons row via
-- linked_person_id. Verified before dropping:
--   * every row with a non-empty value also has linked_person_id (3/3),
--   * every such row's value exactly equals persons.cnic_encrypted (3/3),
--   * no query in backend/src or the frontend reads the column (write-only).
-- All downstream consumers already read through linked_person_id (e.g.
-- utils/personDocuments.js, doc-registry logic in verification.controller.js).

ALTER TABLE `verification_requests` DROP COLUMN `document_owner_cnic`;