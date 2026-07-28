-- Adds unmatched_org_id FK column to verification_requests.
-- ON DELETE SET NULL: if an unmatched org is removed, requests keep their old data.

ALTER TABLE `verification_requests`
  ADD COLUMN IF NOT EXISTS `unmatched_org_id` bigint(20) UNSIGNED NULL AFTER `issuing_organization_id`;

SET @exists = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'verification_requests' AND CONSTRAINT_NAME = 'fk_vr_unmatched_org');
SET @sql = IF(@exists = 0,
  'ALTER TABLE `verification_requests` ADD CONSTRAINT `fk_vr_unmatched_org` FOREIGN KEY (`unmatched_org_id`) REFERENCES `unmatched_organizations` (`id`) ON DELETE SET NULL ON UPDATE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @exists2 = (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'verification_requests' AND INDEX_NAME = 'idx_vr_unmatched_org');
SET @sql2 = IF(@exists2 = 0,
  'ALTER TABLE `verification_requests` ADD INDEX `idx_vr_unmatched_org` (`unmatched_org_id`)',
  'SELECT 1');
PREPARE stmt2 FROM @sql2; EXECUTE stmt2; DEALLOCATE PREPARE stmt2;
