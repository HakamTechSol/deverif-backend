-- 2026-09-27 -- verification_requests.document_validation_{status,reason}
--
-- The automated document check has two tiers, and the request row now records
-- which one spoke:
--
--   'passed'  -- the structural checks (parse, truncation, CRC, extension /
--                mimetype agreement) all passed. This is the normal case.
--   'flagged' -- a HEURISTIC quality check fired: crop detection (edge-ink
--                density) or the darkness / low-contrast readability check.
--                These are tuning-sensitive and can misfire on a perfectly
--                legitimate scan — a dark photo of a black-background ID card, a
--                page that fills the frame on purpose, a document shot on a
--                dark desk. So a flagged request is CREATED and delivered to the
--                reviewing organization, which sees a warning and opens the file
--                itself. It is not blocked.
--
-- Structural failures never reach a row at all: they are rejected with a 400
-- before the INSERT, so there is deliberately no 'rejected' value here. If you
-- ever see one, it means a hard-blocked file was created, which is a bug.
--
--   'unvalidated' -- the document service was unreachable and validation was
--                failed OPEN, so the upload was allowed without ever being
--                checked. Existing behaviour, kept explicit rather than being
--                recorded as a clean 'passed': a reviewer (or a support answer
--                to "was this file ever validated?") must be able to tell a
--                checked-clean file from an unchecked one. It is NOT a document
--                problem, so it shows no warning badge in the inbox.
--
-- `document_validation_reason` stores the Python service's own message so the
-- reviewer sees the actual measurement (e.g. "brightest pixel 214/255") rather
-- than a generic string, and so support can diagnose a misfire.
--
-- ENUM rather than VARCHAR so an unexpected status cannot be written by a bug;
-- MariaDB check this maps to an ENUM column.
--
-- Non-destructive: ADD COLUMN only, with a default that backfills every existing
-- row to 'passed'. Rows that predate this feature went through the old
-- all-or-nothing gate, so they were not blocked by any heuristic — 'passed' is
-- the honest value for them. NULL reason is meaningful only for 'passed' and
-- 'unvalidated'.
ALTER TABLE `verification_requests`
  ADD COLUMN IF NOT EXISTS `document_validation_status`
    ENUM('passed', 'flagged', 'unvalidated') NOT NULL DEFAULT 'passed'
    COMMENT 'Automated document check: passed (structural checks clean), flagged (a heuristic quality signal fired) or unvalidated (service unreachable, checked nothing)'
    AFTER `document_hash`;

ALTER TABLE `verification_requests`
  ADD COLUMN IF NOT EXISTS `document_validation_reason`
    VARCHAR(500) DEFAULT NULL
    COMMENT 'Message from the document validation service when status = flagged'
    AFTER `document_validation_status`;
