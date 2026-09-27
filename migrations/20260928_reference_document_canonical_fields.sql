-- Employee reference documents: canonical-field cache produced AT UPLOAD TIME.
--
-- The auto-verification match compares a freshly submitted document against an
-- organization's stored reference. Until now that comparison re-sent the
-- reference file to the document service and re-OCR'd it on every single match,
-- which meant a non-image reference (a DOCX, for instance) could silently yield
-- no text and every same-document submission fell back to manual review.
--
-- Extracting once, at upload, and caching the canonical field map means:
--   * the comparison data is already on the row by the time a request arrives,
--   * a DOCX reference is read through the python-docx text path (not OCR), and
--   * a reference file that later goes missing on disk can still be matched.
--
-- extracted_data holds the document service's canonical payload verbatim:
--   {"document_type": <canonical schema key>,
--    "document_type_label": <the type string that was requested>,
--    "fields": {"name": {"value": "...", "confidence": "high"}, ...}}
--
-- extraction_status records WHY that payload is or is not there, so "we tried
-- and failed" is never confused with "this file type has no extractable text"
-- or with "this row predates the column and was never processed at all":
--   not_attempted    - row predates this migration (safe DEFAULT, no backfill)
--   succeeded        - fields extracted and cached
--   failed           - extraction was attempted and produced nothing usable
--                      (document service down, unreadable file, no text found)
--   not_applicable   - the file type carries no extractable identity text
--                      (legacy .doc / .txt), so extraction was skipped by design
--
-- All changes are additive: every new column is nullable or carries a safe
-- DEFAULT, so existing rows are untouched and a row with 'not_attempted'
-- simply falls back to the previous live-comparison path.

ALTER TABLE `employee_documents`
    ADD COLUMN `extracted_data` JSON NULL;
ALTER TABLE `employee_documents`
    ADD COLUMN `extraction_status`
        ENUM('not_attempted','succeeded','failed','not_applicable')
        NOT NULL DEFAULT 'not_attempted';
ALTER TABLE `employee_documents`
    ADD COLUMN `extraction_error` varchar(255) NULL;
ALTER TABLE `employee_documents`
    ADD COLUMN `extracted_at` DATETIME NULL;

-- The match engine only ever consults the cache for a row in a clean state.
ALTER TABLE `employee_documents`
    ADD INDEX `idx_emp_docs_extraction` (`extraction_status`);
