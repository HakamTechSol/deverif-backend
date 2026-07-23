-- Adds uuid column to verification_requests table with auto-generation trigger.
-- Safe to re-run: checks IF NOT EXISTS before adding column/keys.

ALTER TABLE `verification_requests`
  ADD COLUMN IF NOT EXISTS `uuid` char(36) DEFAULT NULL AFTER `id`;

-- Backfill existing rows with generated UUIDs
UPDATE `verification_requests` SET `uuid` = UUID() WHERE `uuid` IS NULL OR `uuid` = '';

ALTER TABLE `verification_requests`
  MODIFY COLUMN `uuid` char(36) NOT NULL;

SET @exists = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'verification_requests' AND CONSTRAINT_NAME = 'uk_verification_requests_uuid');
SET @sql = IF(@exists = 0,
  'ALTER TABLE `verification_requests` ADD UNIQUE KEY `uk_verification_requests_uuid` (`uuid`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @exists2 = (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'verification_requests' AND INDEX_NAME = 'idx_verification_requests_uuid');
SET @sql2 = IF(@exists2 = 0,
  'ALTER TABLE `verification_requests` ADD INDEX `idx_verification_requests_uuid` (`uuid`)',
  'SELECT 1');
PREPARE stmt2 FROM @sql2; EXECUTE stmt2; DEALLOCATE PREPARE stmt2;

DROP TRIGGER IF EXISTS `bi_verification_requests_uuid`;
DELIMITER $$
CREATE TRIGGER `bi_verification_requests_uuid`
BEFORE INSERT ON `verification_requests`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END$$
DELIMITER ;
