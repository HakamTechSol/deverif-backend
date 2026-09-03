-- Align employee_documents with the employee-file requirements:
-- add stored size + upload timestamp for each employee document.
-- (Existing additive columns document_type / uploaded_by_uuid are kept.)

ALTER TABLE `employee_documents`
  ADD COLUMN `file_size` BIGINT UNSIGNED DEFAULT NULL AFTER `file_path`,
  ADD COLUMN `uploaded_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP AFTER `file_size`;

-- Backfill uploaded_at from created_at so existing rows report correctly.
UPDATE `employee_documents` SET `uploaded_at` = `created_at` WHERE `uploaded_at` IS NULL OR `uploaded_at` = '0000-00-00 00:00:00';
