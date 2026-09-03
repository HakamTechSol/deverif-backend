-- Daily request quota model.
-- Replaces the flat "active means unlimited access" subscription with a
-- per-day request quota. Every organization always gets 1 FREE verification
-- request per day (independent of any plan quota). Paid plans add an extra
-- daily quota on top of that free request.

-- 1) subscription_plans -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `subscription_plans` (
  `id`                 bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT,
  `uuid`               char(36) NOT NULL,
  `name`               varchar(120) NOT NULL,
  `monthly_price`      decimal(12,2) NOT NULL DEFAULT 0.00,
  `daily_request_quota` int(11) NOT NULL DEFAULT 0,
  `is_custom`          tinyint(1) NOT NULL DEFAULT 0,
  `created_at`         datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at`         datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_subscription_plans_uuid` (`uuid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TRIGGER IF EXISTS `bi_subscription_plans_uuid`;
DELIMITER $$
CREATE TRIGGER `bi_subscription_plans_uuid`
BEFORE INSERT ON `subscription_plans`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END$$
DELIMITER ;

-- Seed the two named plans (idempotent by uuid).
INSERT IGNORE INTO `subscription_plans` (`uuid`, `name`, `monthly_price`, `daily_request_quota`, `is_custom`) VALUES
  ('9a5f5000-0001-4000-8000-10000000000a', 'Plan A', 10000.00, 10, 0),
  ('9a5f5000-0001-4000-8000-10000000000b', 'Plan B', 30000.00, 100, 0);

-- 2) daily_request_usage ------------------------------------------------------
-- Tracks how many PAID (non-free) requests an org has consumed today.
CREATE TABLE IF NOT EXISTS `daily_request_usage` (
  `id`              bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT,
  `organization_id` bigint(20) UNSIGNED NOT NULL,
  `date`            date NOT NULL,
  `requests_used`   int(11) NOT NULL DEFAULT 0,
  `created_at`      datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at`      datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_daily_usage_org_date` (`organization_id`, `date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- 3) custom_plan_requests -------------------------------------------------------
CREATE TABLE IF NOT EXISTS `custom_plan_requests` (
  `id`                bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT,
  `uuid`              char(36) NOT NULL,
  `organization_id`   bigint(20) UNSIGNED NOT NULL,
  `requested_by_uuid` char(36) NOT NULL,
  `message`           text NULL,
  `status`            enum('pending','approved','denied') NOT NULL DEFAULT 'pending',
  `approved_daily_quota` int(11) NULL,
  `approved_price`    decimal(12,2) NULL,
  `decided_by`        char(36) NULL,
  `decided_at`        datetime NULL,
  `created_at`        datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_custom_plan_requests_uuid` (`uuid`),
  KEY `idx_custom_plan_requests_org` (`organization_id`),
  KEY `idx_custom_plan_requests_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TRIGGER IF EXISTS `bi_custom_plan_requests_uuid`;
DELIMITER $$
CREATE TRIGGER `bi_custom_plan_requests_uuid`
BEFORE INSERT ON `custom_plan_requests`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END$$
DELIMITER ;

-- 4) organizations.subscription_plan_id -----------------------------------------
ALTER TABLE `organizations`
  ADD COLUMN IF NOT EXISTS `subscription_plan_id` bigint(20) UNSIGNED NULL AFTER `subscription_plan`;

SET @exists = (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'organizations' AND INDEX_NAME = 'idx_org_subscription_plan_id');
SET @sql = IF(@exists = 0,
  'ALTER TABLE `organizations` ADD INDEX `idx_org_subscription_plan_id` (`subscription_plan_id`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
