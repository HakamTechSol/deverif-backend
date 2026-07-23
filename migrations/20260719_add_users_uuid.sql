-- Adds uuid column to users table with auto-generation trigger.
-- Safe to re-run: checks IF NOT EXISTS before adding column/keys.

ALTER TABLE `users`
  ADD COLUMN IF NOT EXISTS `uuid` char(36) DEFAULT NULL AFTER `id`;

-- Backfill existing rows with generated UUIDs
UPDATE `users` SET `uuid` = UUID() WHERE `uuid` IS NULL OR `uuid` = '';

ALTER TABLE `users`
  MODIFY COLUMN `uuid` char(36) NOT NULL;

SET @exists = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND CONSTRAINT_NAME = 'uk_users_uuid');
SET @sql = IF(@exists = 0,
  'ALTER TABLE `users` ADD UNIQUE KEY `uk_users_uuid` (`uuid`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @exists2 = (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND INDEX_NAME = 'idx_users_uuid');
SET @sql2 = IF(@exists2 = 0,
  'ALTER TABLE `users` ADD INDEX `idx_users_uuid` (`uuid`)',
  'SELECT 1');
PREPARE stmt2 FROM @sql2; EXECUTE stmt2; DEALLOCATE PREPARE stmt2;

DROP TRIGGER IF EXISTS `bi_users_uuid`;
DELIMITER $$
CREATE TRIGGER `bi_users_uuid`
BEFORE INSERT ON `users`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END$$
DELIMITER ;
