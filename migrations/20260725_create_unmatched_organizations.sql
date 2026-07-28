-- Creates unmatched_organizations table for deduplicating unregistered org references.
-- Same conventions as the organizations table (uuid trigger, etc.).

CREATE TABLE IF NOT EXISTS `unmatched_organizations` (
  `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT,
  `uuid` char(36) NOT NULL,
  `name` varchar(200) NOT NULL,
  `email` varchar(200) DEFAULT NULL,
  `phone` varchar(50) DEFAULT NULL,
  `website` varchar(500) DEFAULT NULL,
  `status` enum('pending','contacted','converted','ignored') NOT NULL DEFAULT 'pending',
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_unmatched_orgs_uuid` (`uuid`),
  UNIQUE KEY `uk_unmatched_orgs_name` (`name`),
  INDEX `idx_unmatched_orgs_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Auto-generate UUID on insert if not provided
DROP TRIGGER IF EXISTS `bi_unmatched_orgs_uuid`;
DELIMITER $$
CREATE TRIGGER `bi_unmatched_orgs_uuid`
BEFORE INSERT ON `unmatched_organizations`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END$$
DELIMITER ;
