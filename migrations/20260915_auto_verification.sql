-- Auto-verification engine: reference-based document matching.
--
-- All changes are non-destructive ADD COLUMN / ADD INDEX / ADD CONSTRAINT
-- operations. Existing rows are untouched: every new column is either
-- nullable or carries a safe DEFAULT, so nothing is migrated or rewritten.

-- 1. employees: roster vs learned_reference (ex-employees kept as
--    verification references). Roster/headcount queries filter
--    record_type='roster'; everything stays roster by default.
ALTER TABLE `employees` ADD COLUMN `record_type`
    ENUM('roster','learned_reference') NOT NULL DEFAULT 'roster';

-- 2. employee_documents: SHA-256 fingerprints enabling an exact-file fast
--    path before any OCR is attempted during document matching.
ALTER TABLE `employee_documents` ADD COLUMN `document_hash` varchar(64) NULL;
ALTER TABLE `employee_documents` ADD INDEX `idx_emp_docs_hash` (`document_hash`);

-- 3. verification_requests: outcome of the reference-based auto-match.
--    match_status tracks the matching pipeline, match_confidence holds the
--    0-100 score from the document service, matched_employee_document_id
--    points at the reference document the request was compared against.
--    NOTE: matched_employee_document_id is plain int(11) to match
--    employee_documents.id (MySQL/MariaDB requires the FK column type to
--    exactly match the referenced primary key column).
ALTER TABLE `verification_requests` ADD COLUMN `match_status`
    ENUM('not_attempted','auto_matched','manual_review','no_reference_found')
    NOT NULL DEFAULT 'not_attempted';
ALTER TABLE `verification_requests` ADD COLUMN `match_confidence` decimal(5,2) NULL;
ALTER TABLE `verification_requests` ADD COLUMN `matched_employee_document_id` int(11) NULL;
ALTER TABLE `verification_requests`
    ADD CONSTRAINT `fk_vr_matched_emp_doc`
    FOREIGN KEY (`matched_employee_document_id`)
    REFERENCES `employee_documents` (`id`)
    ON DELETE SET NULL;

-- 4. person_documents: cached OCR result + cross-check outcome for the
--    3-way verification (form fields vs document OCR vs NADRA in future).
--    OCR extraction runs once at approve time; the cached fields let a
--    future NADRA bulk script re-verify without re-running OCR.
ALTER TABLE `person_documents` ADD COLUMN `document_extracted_name` varchar(200) NULL;
ALTER TABLE `person_documents` ADD COLUMN `document_extracted_cnic_hash` char(64) NULL;
ALTER TABLE `person_documents` ADD COLUMN `match_status`
    ENUM('not_checked','matched','mismatched') NOT NULL DEFAULT 'not_checked';