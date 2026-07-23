-- Adds uuid column to organizations table with auto-generation trigger.
-- Safe to re-run: checks IF NOT EXISTS before adding column/keys.

ALTER TABLE `organizations`
  ADD COLUMN IF NOT EXISTS `uuid` char(36) DEFAULT NULL AFTER `id`;

-- Backfill existing rows with generated UUIDs
UPDATE `organizations` SET `uuid` = UUID() WHERE `uuid` IS NULL OR `uuid` = '';

ALTER TABLE `organizations`
  MODIFY COLUMN `uuid` char(36) NOT NULL;

-- Add unique constraint and index (skip if already exists)
SET @exists = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'organizations' AND CONSTRAINT_NAME = 'uk_organizations_uuid');
SET @sql = IF(@exists = 0,
  'ALTER TABLE `organizations` ADD UNIQUE KEY `uk_organizations_uuid` (`uuid`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @exists2 = (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'organizations' AND INDEX_NAME = 'idx_organizations_uuid');
SET @sql2 = IF(@exists2 = 0,
  'ALTER TABLE `organizations` ADD INDEX `idx_organizations_uuid` (`uuid`)',
  'SELECT 1');
PREPARE stmt2 FROM @sql2; EXECUTE stmt2; DEALLOCATE PREPARE stmt2;

-- Auto-generate UUID on insert if not provided
DROP TRIGGER IF EXISTS `bi_organizations_uuid`;
DELIMITER $$
CREATE TRIGGER `bi_organizations_uuid`
BEFORE INSERT ON `organizations`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END$$
DELIMITER ;
