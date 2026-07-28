-- Adds locked_by and locked_at columns to verification_requests.
-- When locked_by is set, the request creator cannot delete it.

ALTER TABLE `verification_requests`
  ADD COLUMN IF NOT EXISTS `locked_by` bigint(20) UNSIGNED NULL AFTER `verification_method`,
  ADD COLUMN IF NOT EXISTS `locked_at` datetime NULL AFTER `locked_by`;

SET @exists = (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'verification_requests' AND INDEX_NAME = 'idx_vr_locked_by');
SET @sql = IF(@exists = 0,
  'ALTER TABLE `verification_requests` ADD INDEX `idx_vr_locked_by` (`locked_by`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
