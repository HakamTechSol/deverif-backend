-- Adds uuid column to payment table with auto-generation trigger.
-- Safe to re-run: checks IF NOT EXISTS before adding column/keys.

ALTER TABLE `payment`
  ADD COLUMN IF NOT EXISTS `uuid` char(36) DEFAULT NULL AFTER `id`;

-- Backfill existing rows with generated UUIDs
UPDATE `payment` SET `uuid` = UUID() WHERE `uuid` IS NULL OR `uuid` = '';

ALTER TABLE `payment`
  MODIFY COLUMN `uuid` char(36) NOT NULL;

SET @exists = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payment' AND CONSTRAINT_NAME = 'uk_payment_uuid');
SET @sql = IF(@exists = 0,
  'ALTER TABLE `payment` ADD UNIQUE KEY `uk_payment_uuid` (`uuid`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @exists2 = (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payment' AND INDEX_NAME = 'idx_payment_uuid');
SET @sql2 = IF(@exists2 = 0,
  'ALTER TABLE `payment` ADD INDEX `idx_payment_uuid` (`uuid`)',
  'SELECT 1');
PREPARE stmt2 FROM @sql2; EXECUTE stmt2; DEALLOCATE PREPARE stmt2;

DROP TRIGGER IF EXISTS `bi_payment_uuid`;
DELIMITER $$
CREATE TRIGGER `bi_payment_uuid`
BEFORE INSERT ON `payment`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END$$
DELIMITER ;
