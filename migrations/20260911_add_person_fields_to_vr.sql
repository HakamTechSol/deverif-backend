-- Add person-linking columns to verification_requests.
-- document_owner_name is also included here since it does not yet exist
-- in the live schema despite being referenced elsewhere in planning.

ALTER TABLE `verification_requests`
  ADD COLUMN IF NOT EXISTS `document_owner_name`  varchar(200) NULL AFTER `document_format`,
  ADD COLUMN IF NOT EXISTS `document_owner_cnic`  varchar(500) NULL AFTER `document_owner_name`,
  ADD COLUMN IF NOT EXISTS `linked_person_id`     bigint(20) UNSIGNED NULL AFTER `document_owner_cnic`;

-- Foreign key for linked_person_id (only if persons table exists and FK not yet set)
SET @personsExists = (SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'persons');
SET @fkExists = (SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'verification_requests'
    AND REFERENCED_TABLE_NAME = 'persons');
SET @sql = IF(@personsExists > 0 AND @fkExists = 0,
  'ALTER TABLE `verification_requests` ADD CONSTRAINT `fk_vr_linked_person` FOREIGN KEY (`linked_person_id`) REFERENCES `persons` (`id`) ON DELETE SET NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Index on linked_person_id for fast person→verifications lookups
SET @idxExists = (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'verification_requests'
    AND INDEX_NAME = 'idx_vr_linked_person');
SET @sql = IF(@idxExists = 0,
  'ALTER TABLE `verification_requests` ADD INDEX `idx_vr_linked_person` (`linked_person_id`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
