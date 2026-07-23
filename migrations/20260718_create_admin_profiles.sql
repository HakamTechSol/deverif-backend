-- Creates the admin_profiles table required by PATCH /admin/auth/profile.
-- Columns are limited to the fields read/written by src/controllers/admin/auth.controller.js,
-- plus uuid for the platform UUID standard.

CREATE TABLE IF NOT EXISTS `admin_profiles` (
  `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT,
  `uuid` char(36) NOT NULL,
  `email` varchar(190) NOT NULL,
  `password` varchar(255) NOT NULL,
  `full_name` varchar(150) NOT NULL,
  `phone` varchar(30) DEFAULT NULL,
  `profile_image` varchar(500) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_admin_profiles_uuid` (`uuid`),
  UNIQUE KEY `uk_admin_profiles_email` (`email`),
  KEY `idx_admin_profiles_uuid` (`uuid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DELIMITER $$
CREATE TRIGGER `bi_admin_profiles_uuid`
BEFORE INSERT ON `admin_profiles`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END$$
DELIMITER ;
