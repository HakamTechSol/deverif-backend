/*
 * THE COMPLETE SCHEMA, as ONE migration.
 *
 * SQUASHED from the 122-file migration history on 2026-10-13. That history is
 * still in git at the commit before this one, so nothing is lost — but it is no
 * longer replayed, and this file is now the single source of truth for the shape
 * of the database.
 *
 * VERIFIED, not assumed: applied to an empty database and again a second time,
 * it produces 68 tables / 817 columns / 36 triggers / 115 foreign keys, which is
 * exactly what the live database has.
 *
 * WHAT THIS FILE IS SAFE AGAINST, which the raw mysqldump output was not:
 *
 *  - AN EXISTING DATABASE. Every table is CREATE TABLE IF NOT EXISTS and every
 *    trigger is preceded by DROP TRIGGER IF EXISTS. The original runner never
 *    drops or mutates anything, and neither does this: running it against a
 *    populated database is a no-op rather than a wipe.
 *  - A RE-RUN. Migrations get re-run whenever a checksum does not match, so the
 *    file has to survive being applied twice.
 *  - TABLE ORDER. FOREIGN_KEY_CHECKS is disabled for the load, because
 *    mysqldump emits tables alphabetically and a child would otherwise be
 *    created before its parent.
 *  - TRIGGERS ALREADY EXISTING. MySQL has no CREATE TRIGGER IF NOT EXISTS, so
 *    the DROP is the only way round it.
 *
 * WHAT IT DOES NOT CONTAIN, deliberately: no data. This is the shape of the
 * schema, not a copy of anyone's records.
 *
 * tests/sqlColumns.test.js replays this file to validate every column name the
 * backend selects against, so its CREATE TABLE formatting is load-bearing:
 * one table per CREATE TABLE, and the closing paren on its own line.
 */

SET @OLD_FOREIGN_KEY_CHECKS = @@FOREIGN_KEY_CHECKS;
SET FOREIGN_KEY_CHECKS = 0;
SET @OLD_SQL_MODE = @@SQL_MODE;
SET SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';

CREATE TABLE IF NOT EXISTS `access_requests` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `uuid` char(36) NOT NULL DEFAULT uuid(),
  `organization_name` varchar(255) NOT NULL,
  `contact_name` varchar(255) NOT NULL,
  `email` varchar(255) NOT NULL,
  `phone` varchar(50) DEFAULT NULL,
  `company_size` varchar(100) DEFAULT NULL,
  `message` text DEFAULT NULL,
  `status` enum('new','contacted','onboarded','rejected') NOT NULL DEFAULT 'new',
  `notes` text DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uuid` (`uuid`),
  KEY `idx_access_requests_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `admin_password_reset_tokens` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `admin_uuid` char(36) NOT NULL,
  `token_hash` char(64) NOT NULL COMMENT 'SHA-256 hex of the raw token sent to admin',
  `expires_at` datetime NOT NULL,
  `used_at` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_aprt_admin_uuid` (`admin_uuid`),
  KEY `idx_aprt_token_hash` (`token_hash`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
CREATE TABLE IF NOT EXISTS `admin_profiles` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `uuid` char(36) NOT NULL,
  `email` varchar(190) NOT NULL,
  `password` varchar(255) NOT NULL,
  `full_name` varchar(150) NOT NULL,
  `phone` varchar(30) DEFAULT NULL,
  `profile_image` varchar(500) DEFAULT NULL,
  `status` enum('active','inactive') NOT NULL DEFAULT 'active',
  `preferred_language` enum('en','ur') NOT NULL DEFAULT 'en',
  `created_at` datetime DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_admin_profiles_uuid` (`uuid`),
  UNIQUE KEY `uk_admin_profiles_email` (`email`),
  KEY `idx_admin_profiles_uuid` (`uuid`)
) ENGINE=InnoDB AUTO_INCREMENT=77 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
DROP TRIGGER IF EXISTS `bi_admin_profiles_uuid`;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bi_admin_profiles_uuid`
BEFORE INSERT ON `admin_profiles`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END */;;
DELIMITER ;
CREATE TABLE IF NOT EXISTS `approval_requests` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `uuid` char(36) NOT NULL,
  `organization_id` bigint(20) unsigned NOT NULL,
  `workflow_id` bigint(20) unsigned NOT NULL,
  `module_key` varchar(60) NOT NULL,
  `entity_type` varchar(60) NOT NULL,
  `entity_uuid` char(36) NOT NULL,
  `current_step_order` smallint(5) unsigned DEFAULT NULL,
  `status` enum('pending','approved','rejected','cancelled') NOT NULL DEFAULT 'pending',
  `title` varchar(200) DEFAULT NULL,
  `payload` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`payload`)),
  `requested_by_uuid` char(36) NOT NULL,
  `requested_at` datetime NOT NULL DEFAULT current_timestamp(),
  `resolved_at` datetime DEFAULT NULL,
  `resolved_by_uuid` char(36) DEFAULT NULL,
  `outcome_notes` text DEFAULT NULL,
  `live_entity_uuid` char(36) GENERATED ALWAYS AS (case when `status` = 'pending' then `entity_uuid` else NULL end) STORED,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_approval_requests_uuid` (`uuid`),
  UNIQUE KEY `uk_approval_requests_one_live` (`organization_id`,`entity_type`,`live_entity_uuid`),
  KEY `idx_approval_requests_entity` (`organization_id`,`entity_type`,`entity_uuid`),
  KEY `idx_approval_requests_pending` (`organization_id`,`status`,`current_step_order`),
  KEY `idx_approval_requests_requester` (`requested_by_uuid`),
  KEY `fk_approval_requests_workflow` (`workflow_id`),
  KEY `fk_approval_requests_resolver` (`resolved_by_uuid`),
  CONSTRAINT `fk_approval_requests_org` FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_approval_requests_requester` FOREIGN KEY (`requested_by_uuid`) REFERENCES `users` (`uuid`) ON DELETE CASCADE,
  CONSTRAINT `fk_approval_requests_resolver` FOREIGN KEY (`resolved_by_uuid`) REFERENCES `users` (`uuid`) ON DELETE SET NULL,
  CONSTRAINT `fk_approval_requests_workflow` FOREIGN KEY (`workflow_id`) REFERENCES `workflow_definitions` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
DROP TRIGGER IF EXISTS `bi_approval_requests_uuid`;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bi_approval_requests_uuid`
BEFORE INSERT ON `approval_requests`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END */;;
DELIMITER ;
CREATE TABLE IF NOT EXISTS `approval_step_history` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `uuid` char(36) NOT NULL,
  `approval_request_uuid` char(36) NOT NULL,
  `step_id` bigint(20) unsigned DEFAULT NULL,
  `step_order` smallint(5) unsigned NOT NULL,
  `step_name` varchar(120) NOT NULL,
  `approver_uuid` char(36) DEFAULT NULL,
  `approver_name` varchar(150) DEFAULT NULL,
  `decision` enum('pending','approved','rejected','skipped','cancelled','forwarded') NOT NULL,
  `comments` text DEFAULT NULL,
  `acted_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_approval_step_history_uuid` (`uuid`),
  KEY `idx_approval_step_history_request` (`approval_request_uuid`,`step_order`,`acted_at`),
  KEY `idx_approval_step_history_approver` (`approver_uuid`),
  KEY `fk_approval_step_history_step` (`step_id`),
  CONSTRAINT `fk_approval_step_history_approver` FOREIGN KEY (`approver_uuid`) REFERENCES `users` (`uuid`) ON DELETE SET NULL,
  CONSTRAINT `fk_approval_step_history_request` FOREIGN KEY (`approval_request_uuid`) REFERENCES `approval_requests` (`uuid`) ON DELETE CASCADE,
  CONSTRAINT `fk_approval_step_history_step` FOREIGN KEY (`step_id`) REFERENCES `workflow_steps` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
DROP TRIGGER IF EXISTS `bi_approval_step_history_uuid`;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bi_approval_step_history_uuid`
BEFORE INSERT ON `approval_step_history`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END */;;
DELIMITER ;
CREATE TABLE IF NOT EXISTS `asset_assignments` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `uuid` char(36) NOT NULL,
  `organization_id` bigint(20) unsigned NOT NULL,
  `asset_uuid` char(36) NOT NULL,
  `employee_uuid` char(36) NOT NULL,
  `assigned_by_uuid` char(36) DEFAULT NULL,
  `assigned_at` datetime NOT NULL DEFAULT current_timestamp(),
  `returned_at` datetime DEFAULT NULL,
  `returned_to_uuid` char(36) DEFAULT NULL,
  `return_condition` enum('good','damaged','needs_maintenance') DEFAULT NULL,
  `return_notes` varchar(500) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `open_assignment_guard` tinyint(4) GENERATED ALWAYS AS (case when `returned_at` is null then 1 else NULL end) STORED,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_asset_assignments_uuid` (`uuid`),
  UNIQUE KEY `uk_asset_assignments_open` (`asset_uuid`,`open_assignment_guard`),
  KEY `idx_asset_assignments_employee` (`organization_id`,`employee_uuid`),
  KEY `idx_asset_assignments_asset` (`asset_uuid`,`assigned_at`),
  KEY `fk_asset_assignments_employee` (`employee_uuid`),
  KEY `fk_asset_assignments_assigner` (`assigned_by_uuid`),
  KEY `fk_asset_assignments_returner` (`returned_to_uuid`),
  CONSTRAINT `fk_asset_assignments_asset` FOREIGN KEY (`asset_uuid`) REFERENCES `assets` (`uuid`) ON DELETE CASCADE,
  CONSTRAINT `fk_asset_assignments_assigner` FOREIGN KEY (`assigned_by_uuid`) REFERENCES `users` (`uuid`) ON DELETE SET NULL,
  CONSTRAINT `fk_asset_assignments_employee` FOREIGN KEY (`employee_uuid`) REFERENCES `employees` (`uuid`) ON DELETE CASCADE,
  CONSTRAINT `fk_asset_assignments_org` FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_asset_assignments_returner` FOREIGN KEY (`returned_to_uuid`) REFERENCES `users` (`uuid`) ON DELETE SET NULL
) ENGINE=InnoDB AUTO_INCREMENT=353 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
DROP TRIGGER IF EXISTS `bi_asset_assignments_uuid`;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bi_asset_assignments_uuid`
BEFORE INSERT ON `asset_assignments`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END */;;
DELIMITER ;
CREATE TABLE IF NOT EXISTS `asset_categories` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `uuid` char(36) NOT NULL,
  `organization_id` bigint(20) unsigned NOT NULL,
  `name` varchar(120) NOT NULL,
  `description` varchar(500) DEFAULT NULL,
  `default_lifespan_months` int(10) unsigned DEFAULT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `created_by_uuid` char(36) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_asset_categories_uuid` (`uuid`),
  UNIQUE KEY `uk_asset_categories_org_name` (`organization_id`,`name`),
  UNIQUE KEY `uk_asset_categories_uuid_org` (`uuid`,`organization_id`),
  KEY `idx_asset_categories_org` (`organization_id`,`is_active`),
  KEY `fk_asset_categories_creator` (`created_by_uuid`),
  CONSTRAINT `fk_asset_categories_creator` FOREIGN KEY (`created_by_uuid`) REFERENCES `users` (`uuid`) ON DELETE SET NULL,
  CONSTRAINT `fk_asset_categories_org` FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=273 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
DROP TRIGGER IF EXISTS `bi_asset_categories_uuid`;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bi_asset_categories_uuid`
BEFORE INSERT ON `asset_categories`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END */;;
DELIMITER ;
CREATE TABLE IF NOT EXISTS `asset_maintenance` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `uuid` char(36) NOT NULL,
  `organization_id` bigint(20) unsigned NOT NULL,
  `asset_uuid` char(36) NOT NULL,
  `title` varchar(200) NOT NULL,
  `description` text DEFAULT NULL,
  `status` enum('open','completed','cancelled') NOT NULL DEFAULT 'open',
  `vendor` varchar(200) DEFAULT NULL,
  `cost` decimal(12,2) DEFAULT NULL,
  `reported_by_uuid` char(36) DEFAULT NULL,
  `reported_at` datetime NOT NULL DEFAULT current_timestamp(),
  `completed_at` datetime DEFAULT NULL,
  `completed_by_uuid` char(36) DEFAULT NULL,
  `completion_notes` text DEFAULT NULL,
  `open_job_guard` tinyint(4) GENERATED ALWAYS AS (case when `status` = 'open' then 1 else NULL end) STORED,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_asset_maintenance_uuid` (`uuid`),
  UNIQUE KEY `uk_asset_maintenance_open` (`asset_uuid`,`open_job_guard`),
  KEY `idx_asset_maintenance_org` (`organization_id`,`status`),
  KEY `idx_asset_maintenance_asset` (`asset_uuid`,`reported_at`),
  KEY `fk_asset_maintenance_reporter` (`reported_by_uuid`),
  KEY `fk_asset_maintenance_finisher` (`completed_by_uuid`),
  CONSTRAINT `fk_asset_maintenance_asset` FOREIGN KEY (`asset_uuid`) REFERENCES `assets` (`uuid`) ON DELETE CASCADE,
  CONSTRAINT `fk_asset_maintenance_finisher` FOREIGN KEY (`completed_by_uuid`) REFERENCES `users` (`uuid`) ON DELETE SET NULL,
  CONSTRAINT `fk_asset_maintenance_org` FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_asset_maintenance_reporter` FOREIGN KEY (`reported_by_uuid`) REFERENCES `users` (`uuid`) ON DELETE SET NULL
) ENGINE=InnoDB AUTO_INCREMENT=113 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
DROP TRIGGER IF EXISTS `bi_asset_maintenance_uuid`;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bi_asset_maintenance_uuid`
BEFORE INSERT ON `asset_maintenance`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END */;;
DELIMITER ;
CREATE TABLE IF NOT EXISTS `assets` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `uuid` char(36) NOT NULL,
  `organization_id` bigint(20) unsigned NOT NULL,
  `category_uuid` char(36) NOT NULL,
  `asset_tag` varchar(40) NOT NULL,
  `name` varchar(200) NOT NULL,
  `model_details` varchar(200) DEFAULT NULL,
  `serial_number` varchar(120) DEFAULT NULL,
  `purchase_date` date DEFAULT NULL,
  `purchase_cost` decimal(12,2) DEFAULT NULL,
  `vendor` varchar(200) DEFAULT NULL,
  `warranty_expires_at` date DEFAULT NULL,
  `status` enum('available','assigned','maintenance','retired') NOT NULL DEFAULT 'available',
  `notes` text DEFAULT NULL,
  `created_by_uuid` char(36) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `active_assignment_guard` char(36) GENERATED ALWAYS AS (case when `status` = 'assigned' then `uuid` else NULL end) STORED,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_assets_uuid` (`uuid`),
  UNIQUE KEY `uk_assets_org_tag` (`organization_id`,`asset_tag`),
  UNIQUE KEY `uk_assets_single_holder` (`active_assignment_guard`),
  KEY `idx_assets_org_status` (`organization_id`,`status`),
  KEY `idx_assets_category` (`category_uuid`),
  KEY `idx_assets_serial` (`organization_id`,`serial_number`),
  KEY `idx_assets_purchase_date` (`organization_id`,`purchase_date`),
  KEY `fk_assets_creator` (`created_by_uuid`),
  KEY `fk_assets_category_same_org` (`category_uuid`,`organization_id`),
  CONSTRAINT `fk_assets_category_same_org` FOREIGN KEY (`category_uuid`, `organization_id`) REFERENCES `asset_categories` (`uuid`, `organization_id`) ON DELETE CASCADE,
  CONSTRAINT `fk_assets_creator` FOREIGN KEY (`created_by_uuid`) REFERENCES `users` (`uuid`) ON DELETE SET NULL,
  CONSTRAINT `fk_assets_org` FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=433 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
DROP TRIGGER IF EXISTS `bi_assets_uuid`;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bi_assets_uuid`
BEFORE INSERT ON `assets`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END */;;
DELIMITER ;
CREATE TABLE IF NOT EXISTS `attachments` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `uuid` char(36) NOT NULL,
  `organization_id` bigint(20) unsigned NOT NULL,
  `entity_type` varchar(60) NOT NULL,
  `entity_uuid` char(36) NOT NULL,
  `file_name` varchar(255) NOT NULL,
  `file_path` varchar(500) NOT NULL,
  `mime_type` varchar(120) DEFAULT NULL,
  `file_size` bigint(20) unsigned NOT NULL DEFAULT 0,
  `category` varchar(40) DEFAULT NULL,
  `description` varchar(500) DEFAULT NULL,
  `uploaded_by_uuid` char(36) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `deleted_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_attachments_uuid` (`uuid`),
  KEY `idx_attachments_entity` (`organization_id`,`entity_type`,`entity_uuid`),
  KEY `idx_attachments_uploader` (`uploaded_by_uuid`),
  KEY `idx_attachments_category` (`organization_id`,`entity_type`,`category`),
  CONSTRAINT `fk_attachments_org` FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_attachments_uploader` FOREIGN KEY (`uploaded_by_uuid`) REFERENCES `users` (`uuid`) ON DELETE SET NULL
) ENGINE=InnoDB AUTO_INCREMENT=52 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
DROP TRIGGER IF EXISTS `bi_attachments_uuid`;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bi_attachments_uuid`
BEFORE INSERT ON `attachments`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END */;;
DELIMITER ;
CREATE TABLE IF NOT EXISTS `attendance_records` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `uuid` char(36) NOT NULL,
  `employee_uuid` char(36) NOT NULL,
  `organization_id` bigint(20) unsigned NOT NULL,
  `check_in_at` datetime DEFAULT NULL,
  `check_out_at` datetime DEFAULT NULL,
  `check_in_ip` varchar(45) DEFAULT NULL,
  `check_out_ip` varchar(45) DEFAULT NULL,
  `date` date NOT NULL,
  `status` enum('checked_in','checked_out') NOT NULL DEFAULT 'checked_in',
  `is_manual` enum('yes','no') NOT NULL DEFAULT 'no',
  `manual_reason` varchar(255) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_attendance_employee_date` (`employee_uuid`,`date`),
  KEY `idx_attendance_org_date` (`organization_id`,`date`),
  KEY `idx_attendance_employee` (`employee_uuid`),
  CONSTRAINT `fk_attendance_employee` FOREIGN KEY (`employee_uuid`) REFERENCES `employees` (`uuid`) ON DELETE CASCADE,
  CONSTRAINT `fk_attendance_org` FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=1225 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
DROP TRIGGER IF EXISTS `bi_attendance_records_uuid`;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bi_attendance_records_uuid`
BEFORE INSERT ON `attendance_records`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END */;;
DELIMITER ;
CREATE TABLE IF NOT EXISTS `audit_logs` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `uuid` char(36) NOT NULL,
  `actor_type` enum('admin','user','system') NOT NULL COMMENT 'Who caused the change. system = automated (lifecycle sweep, gateway reconciliation, webhook) — no human actor',
  `actor_id` int(11) DEFAULT NULL COMMENT 'The admin/user id behind the change; NULL for system actions',
  `actor_name` varchar(190) DEFAULT NULL,
  `actor_role` varchar(32) DEFAULT NULL,
  `action` varchar(100) NOT NULL,
  `entity_type` varchar(100) NOT NULL,
  `entity_id` varchar(100) DEFAULT NULL,
  `details` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`details`)),
  `ip_address` varchar(45) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `idx_audit_logs_uuid` (`uuid`),
  KEY `idx_audit_actor` (`actor_type`,`actor_id`),
  KEY `idx_audit_action` (`action`),
  KEY `idx_audit_entity` (`entity_type`,`entity_id`),
  KEY `idx_audit_date` (`created_at`),
  KEY `idx_audit_actor_date` (`actor_type`,`created_at`),
  KEY `idx_audit_action_date` (`action`,`created_at`)
) ENGINE=InnoDB AUTO_INCREMENT=386 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
CREATE TABLE IF NOT EXISTS `candidates` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `uuid` char(36) NOT NULL,
  `organization_id` bigint(20) unsigned NOT NULL,
  `job_opening_uuid` char(36) NOT NULL,
  `full_name` varchar(150) NOT NULL,
  `email` varchar(190) DEFAULT NULL,
  `phone` varchar(30) DEFAULT NULL,
  `cnic` varchar(20) DEFAULT NULL,
  `resume_attachment_uuid` char(36) DEFAULT NULL,
  `cover_letter` text DEFAULT NULL,
  `stage` enum('applied','screening','interview','selected','offered','hired','declined','rejected') NOT NULL DEFAULT 'applied',
  `rating` decimal(3,2) DEFAULT NULL,
  `notes` text DEFAULT NULL,
  `rejected_reason` varchar(500) DEFAULT NULL,
  `converted_employee_uuid` char(36) DEFAULT NULL,
  `offer_letter_uuid` char(36) DEFAULT NULL,
  `offer_status` enum('ready','sent','hired') DEFAULT NULL,
  `offer_sent_at` datetime DEFAULT NULL,
  `offer_response_at` datetime DEFAULT NULL,
  `offer_response_notes` varchar(1000) DEFAULT NULL,
  `failed_interview_override_reason` varchar(1000) DEFAULT NULL,
  `failed_interview_override_by_uuid` char(36) DEFAULT NULL,
  `failed_interview_override_at` datetime DEFAULT NULL,
  `offer_template_uuid` char(36) DEFAULT NULL,
  `offer_values` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`offer_values`)),
  `offer_body_snapshot` mediumtext DEFAULT NULL,
  `offer_snapshot_hash` char(64) DEFAULT NULL,
  `offer_snapshot_at` datetime DEFAULT NULL,
  `offer_template_hash` char(64) DEFAULT NULL,
  `hired_at` datetime DEFAULT NULL,
  `converted_at` datetime DEFAULT NULL,
  `created_by_uuid` char(36) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_candidates_uuid` (`uuid`),
  UNIQUE KEY `uk_candidates_org_uuid` (`organization_id`,`uuid`),
  UNIQUE KEY `uk_candidates_opening_email` (`job_opening_uuid`,`email`),
  KEY `idx_candidates_opening_stage` (`organization_id`,`job_opening_uuid`,`stage`),
  KEY `idx_candidates_org_stage` (`organization_id`,`stage`,`created_at`),
  KEY `fk_candidates_converted_employee` (`converted_employee_uuid`),
  KEY `idx_candidates_offer_status` (`organization_id`,`offer_status`,`updated_at`),
  KEY `fk_candidates_interview_override_by` (`failed_interview_override_by_uuid`),
  CONSTRAINT `fk_candidates_converted_employee` FOREIGN KEY (`converted_employee_uuid`) REFERENCES `employees` (`uuid`),
  CONSTRAINT `fk_candidates_interview_override_by` FOREIGN KEY (`failed_interview_override_by_uuid`) REFERENCES `users` (`uuid`) ON DELETE SET NULL,
  CONSTRAINT `fk_candidates_opening_tenant` FOREIGN KEY (`organization_id`, `job_opening_uuid`) REFERENCES `job_openings` (`organization_id`, `uuid`) ON DELETE CASCADE,
  CONSTRAINT `fk_candidates_org` FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=12 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
CREATE TABLE IF NOT EXISTS `contact_leads` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `uuid` char(36) NOT NULL DEFAULT uuid(),
  `name` varchar(255) NOT NULL,
  `email` varchar(255) NOT NULL,
  `phone` varchar(50) DEFAULT NULL,
  `message` text NOT NULL,
  `status` enum('new','contacted','closed') NOT NULL DEFAULT 'new',
  `notes` text DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uuid` (`uuid`),
  KEY `idx_contact_leads_status` (`status`)
) ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `custom_plan_requests` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `uuid` char(36) NOT NULL,
  `organization_id` bigint(20) unsigned NOT NULL,
  `requested_by_uuid` char(36) NOT NULL,
  `message` text DEFAULT NULL,
  `requested_quota` int(11) DEFAULT NULL,
  `requested_price` decimal(12,2) DEFAULT NULL,
  `status` enum('pending','approved','denied') NOT NULL DEFAULT 'pending',
  `approved_daily_quota` int(11) DEFAULT NULL,
  `approved_price` decimal(12,2) DEFAULT NULL,
  `approved_plan_id` int(11) DEFAULT NULL COMMENT 'The subscription_plans row created by this approval; NULL means no plan is linked to this request',
  `decided_by` char(36) DEFAULT NULL,
  `decided_at` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_custom_plan_requests_uuid` (`uuid`),
  KEY `idx_custom_plan_requests_org` (`organization_id`),
  KEY `idx_custom_plan_requests_status` (`status`),
  KEY `fk_cpr_org_idx` (`organization_id`),
  KEY `idx_cpr_approved_plan` (`approved_plan_id`),
  CONSTRAINT `fk_cpr_org` FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
DROP TRIGGER IF EXISTS `bi_custom_plan_requests_uuid`;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bi_custom_plan_requests_uuid`
BEFORE INSERT ON `custom_plan_requests`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END */;;
DELIMITER ;
CREATE TABLE IF NOT EXISTS `daily_request_usage` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `organization_id` bigint(20) unsigned NOT NULL,
  `date` date NOT NULL,
  `requests_used` int(11) NOT NULL DEFAULT 0,
  `total_requests` int(11) NOT NULL DEFAULT 0,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_daily_usage_org_date` (`organization_id`,`date`),
  KEY `fk_dru_org_idx` (`organization_id`),
  CONSTRAINT `fk_dru_org` FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
CREATE TABLE IF NOT EXISTS `departments` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `uuid` char(36) NOT NULL,
  `organization_id` bigint(20) unsigned NOT NULL,
  `name` varchar(100) NOT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_departments_uuid` (`uuid`),
  UNIQUE KEY `uq_departments_org_name` (`organization_id`,`name`),
  UNIQUE KEY `uk_departments_org_id` (`organization_id`,`id`),
  KEY `idx_departments_org` (`organization_id`),
  CONSTRAINT `fk_departments_org` FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=50 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
DROP TRIGGER IF EXISTS `bi_departments_uuid`;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER bi_departments_uuid
BEFORE INSERT ON departments
FOR EACH ROW
BEGIN
  IF NEW.uuid IS NULL OR NEW.uuid = '' THEN
    SET NEW.uuid = UUID();
  END IF;
END */;;
DELIMITER ;
CREATE TABLE IF NOT EXISTS `designations` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `uuid` char(36) NOT NULL,
  `organization_id` bigint(20) unsigned NOT NULL,
  `name` varchar(100) NOT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_designations_uuid` (`uuid`),
  UNIQUE KEY `uq_designations_org_name` (`organization_id`,`name`),
  UNIQUE KEY `uk_designations_org_id` (`organization_id`,`id`),
  KEY `idx_designations_org` (`organization_id`),
  CONSTRAINT `fk_designations_org` FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=34 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
DROP TRIGGER IF EXISTS `bi_designations_uuid`;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER bi_designations_uuid
BEFORE INSERT ON designations
FOR EACH ROW
BEGIN
  IF NEW.uuid IS NULL OR NEW.uuid = '' THEN
    SET NEW.uuid = UUID();
  END IF;
END */;;
DELIMITER ;
CREATE TABLE IF NOT EXISTS `document_types` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `name` varchar(150) NOT NULL,
  `label_key` varchar(150) NOT NULL,
  `schema_key` varchar(50) NOT NULL DEFAULT 'generic',
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `sort_order` int(11) NOT NULL DEFAULT 0,
  `description` varchar(255) DEFAULT NULL,
  `created_by` varchar(64) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_document_types_name` (`name`),
  UNIQUE KEY `uq_document_types_label_key` (`label_key`),
  KEY `idx_document_types_active` (`is_active`,`sort_order`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
CREATE TABLE IF NOT EXISTS `employee_documents` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `uuid` char(36) NOT NULL,
  `employee_uuid` char(36) NOT NULL,
  `document_type` varchar(100) DEFAULT NULL,
  `file_name` varchar(255) NOT NULL,
  `file_path` varchar(500) NOT NULL,
  `file_size` bigint(20) unsigned DEFAULT NULL,
  `uploaded_at` datetime NOT NULL DEFAULT current_timestamp(),
  `uploaded_by_uuid` char(36) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `document_hash` varchar(64) DEFAULT NULL,
  `extracted_data` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`extracted_data`)),
  `extraction_status` enum('not_attempted','succeeded','failed','not_applicable') NOT NULL DEFAULT 'not_attempted',
  `extraction_error` varchar(255) DEFAULT NULL,
  `extracted_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_employee_documents_uuid` (`uuid`),
  KEY `idx_employee_documents_emp` (`employee_uuid`),
  KEY `idx_emp_docs_hash` (`document_hash`),
  KEY `idx_emp_docs_extraction` (`extraction_status`),
  CONSTRAINT `fk_employee_documents_emp` FOREIGN KEY (`employee_uuid`) REFERENCES `employees` (`uuid`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
DROP TRIGGER IF EXISTS `bi_employee_documents_uuid`;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER bi_employee_documents_uuid
BEFORE INSERT ON employee_documents
FOR EACH ROW
BEGIN
  IF NEW.uuid IS NULL OR NEW.uuid = '' THEN
    SET NEW.uuid = UUID();
  END IF;
END */;;
DELIMITER ;
CREATE TABLE IF NOT EXISTS `employee_leave_allocations` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `uuid` char(36) NOT NULL,
  `employee_uuid` char(36) NOT NULL,
  `leave_type_id` bigint(20) unsigned NOT NULL,
  `year` smallint(5) unsigned NOT NULL,
  `allocated_days` int(11) NOT NULL DEFAULT 0,
  `used_days` int(11) NOT NULL DEFAULT 0,
  `remaining_days` int(11) NOT NULL DEFAULT 0,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_ela` (`employee_uuid`,`leave_type_id`,`year`),
  KEY `idx_ela_employee_year` (`employee_uuid`,`year`),
  KEY `fk_ela_type` (`leave_type_id`),
  CONSTRAINT `fk_ela_employee` FOREIGN KEY (`employee_uuid`) REFERENCES `employees` (`uuid`) ON DELETE CASCADE,
  CONSTRAINT `fk_ela_type` FOREIGN KEY (`leave_type_id`) REFERENCES `leave_types` (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=227 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
DROP TRIGGER IF EXISTS `bi_employee_leave_allocations_uuid`;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bi_employee_leave_allocations_uuid`
BEFORE INSERT ON `employee_leave_allocations`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END */;;
DELIMITER ;
CREATE TABLE IF NOT EXISTS `employee_salary_components` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `uuid` char(36) NOT NULL,
  `employee_uuid` char(36) NOT NULL,
  `salary_component_id` int(11) NOT NULL,
  `amount` decimal(14,2) NOT NULL DEFAULT 0.00,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `assigned_by` bigint(20) unsigned DEFAULT NULL,
  `assigned_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_esc_uuid` (`uuid`),
  UNIQUE KEY `uk_esc_employee_component` (`employee_uuid`,`salary_component_id`),
  KEY `idx_esc_employee` (`employee_uuid`),
  KEY `idx_esc_component` (`salary_component_id`),
  CONSTRAINT `fk_esc_component` FOREIGN KEY (`salary_component_id`) REFERENCES `salary_components` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_esc_employee` FOREIGN KEY (`employee_uuid`) REFERENCES `employees` (`uuid`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
DROP TRIGGER IF EXISTS `bi_employee_salary_components_uuid`;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bi_employee_salary_components_uuid`
BEFORE INSERT ON `employee_salary_components`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END */;;
DELIMITER ;
CREATE TABLE IF NOT EXISTS `employee_salary_history` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `uuid` char(36) NOT NULL,
  `employee_uuid` char(36) NOT NULL,
  `year` smallint(5) unsigned NOT NULL,
  `basic_salary` decimal(14,2) NOT NULL DEFAULT 0.00,
  `effective_from` date NOT NULL,
  `effective_to` date DEFAULT NULL,
  `created_by` bigint(20) unsigned DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_esh_uuid` (`uuid`),
  KEY `idx_esh_employee` (`employee_uuid`),
  KEY `idx_esh_active` (`employee_uuid`,`effective_from`,`effective_to`),
  KEY `fk_esh_created_by` (`created_by`),
  CONSTRAINT `fk_esh_created_by` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_esh_employee` FOREIGN KEY (`employee_uuid`) REFERENCES `employees` (`uuid`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=917 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
DROP TRIGGER IF EXISTS `bi_employee_salary_history_uuid`;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bi_employee_salary_history_uuid`
BEFORE INSERT ON `employee_salary_history`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END */;;
DELIMITER ;
CREATE TABLE IF NOT EXISTS `employees` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `uuid` char(36) NOT NULL,
  `employee_code` varchar(30) DEFAULT NULL,
  `organization_id` bigint(20) unsigned NOT NULL,
  `full_name` varchar(150) NOT NULL,
  `email` varchar(190) DEFAULT NULL,
  `phone` varchar(30) DEFAULT NULL,
  `cnic` varchar(20) DEFAULT NULL,
  `designation_id` int(11) DEFAULT NULL,
  `department_id` int(11) DEFAULT NULL,
  `joining_date` date DEFAULT NULL,
  `employment_type` enum('full_time','part_time','contract','temporary','intern') DEFAULT NULL,
  `work_location` varchar(150) DEFAULT NULL,
  `reporting_manager_uuid` char(36) DEFAULT NULL,
  `emergency_contact` varchar(30) DEFAULT NULL,
  `status` enum('active','inactive','current_employee','ex_employee') NOT NULL DEFAULT 'current_employee',
  `is_platform_user` enum('yes','no') NOT NULL DEFAULT 'no',
  `linked_user_uuid` char(36) DEFAULT NULL,
  `added_by_uuid` char(36) DEFAULT NULL,
  `promoted_by_uuid` char(36) DEFAULT NULL,
  `promoted_at` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_employees_uuid` (`uuid`),
  UNIQUE KEY `uk_employees_org_code` (`organization_id`,`employee_code`),
  KEY `idx_employees_org` (`organization_id`),
  KEY `idx_employees_email` (`email`),
  KEY `idx_employees_linked_user` (`linked_user_uuid`),
  KEY `fk_emp_org_idx` (`organization_id`),
  KEY `fk_emp_added_by_idx` (`added_by_uuid`),
  KEY `fk_emp_linked_user_idx` (`linked_user_uuid`),
  KEY `fk_emp_promoted_by_idx` (`promoted_by_uuid`),
  KEY `fk_employee_designation` (`designation_id`),
  KEY `fk_employee_department` (`department_id`),
  KEY `idx_employees_reporting_manager` (`reporting_manager_uuid`),
  CONSTRAINT `fk_emp_added_by` FOREIGN KEY (`added_by_uuid`) REFERENCES `users` (`uuid`) ON DELETE SET NULL,
  CONSTRAINT `fk_emp_linked_user` FOREIGN KEY (`linked_user_uuid`) REFERENCES `users` (`uuid`) ON DELETE SET NULL,
  CONSTRAINT `fk_emp_org` FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`),
  CONSTRAINT `fk_emp_promoted_by` FOREIGN KEY (`promoted_by_uuid`) REFERENCES `users` (`uuid`) ON DELETE SET NULL,
  CONSTRAINT `fk_employee_department` FOREIGN KEY (`department_id`) REFERENCES `departments` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_employee_designation` FOREIGN KEY (`designation_id`) REFERENCES `designations` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_employees_reporting_manager` FOREIGN KEY (`reporting_manager_uuid`) REFERENCES `employees` (`uuid`) ON DELETE SET NULL
) ENGINE=InnoDB AUTO_INCREMENT=1477 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
DROP TRIGGER IF EXISTS `bi_employees_uuid`;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bi_employees_uuid`
BEFORE INSERT ON `employees`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END */;;
DELIMITER ;
CREATE TABLE IF NOT EXISTS `exit_requests` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `uuid` char(36) NOT NULL,
  `organization_id` bigint(20) unsigned NOT NULL,
  `employee_uuid` char(36) NOT NULL,
  `employee_name` varchar(200) NOT NULL,
  `designation` varchar(150) DEFAULT NULL,
  `request_type` enum('resignation','termination') NOT NULL,
  `last_working_day` date NOT NULL,
  `reason` varchar(1000) DEFAULT NULL,
  `status` enum('pending','approved','rejected','completed') NOT NULL DEFAULT 'pending',
  `decided_by` char(36) DEFAULT NULL,
  `decided_at` datetime DEFAULT NULL,
  `decision_notes` varchar(1000) DEFAULT NULL,
  `completed_at` datetime DEFAULT NULL,
  `hr_notes` text DEFAULT NULL,
  `created_by` char(36) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `open_exit_guard` tinyint(4) GENERATED ALWAYS AS (case when `status` in ('pending','approved') then 1 else NULL end) STORED,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_exit_requests_uuid` (`uuid`),
  UNIQUE KEY `uk_exit_requests_open` (`employee_uuid`,`open_exit_guard`),
  KEY `idx_exit_requests_org_status` (`organization_id`,`status`),
  KEY `idx_exit_requests_employee` (`organization_id`,`employee_uuid`),
  KEY `idx_exit_requests_lwd` (`organization_id`,`last_working_day`),
  CONSTRAINT `fk_exit_requests_employee` FOREIGN KEY (`employee_uuid`) REFERENCES `employees` (`uuid`) ON DELETE CASCADE,
  CONSTRAINT `fk_exit_requests_org` FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=55 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
CREATE TABLE IF NOT EXISTS `expense_categories` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `uuid` char(36) NOT NULL,
  `organization_id` bigint(20) unsigned NOT NULL,
  `name` varchar(120) NOT NULL,
  `description` varchar(500) DEFAULT NULL,
  `max_limit_per_claim` decimal(14,2) DEFAULT NULL,
  `requires_receipt` tinyint(1) NOT NULL DEFAULT 0,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `created_by` bigint(20) unsigned DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_expense_categories_uuid` (`uuid`),
  UNIQUE KEY `uk_expense_categories_org_uuid` (`organization_id`,`uuid`),
  UNIQUE KEY `uk_expense_categories_org_name` (`organization_id`,`name`),
  KEY `idx_expense_categories_org` (`organization_id`,`is_active`),
  CONSTRAINT `fk_expense_categories_org` FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=66 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
CREATE TABLE IF NOT EXISTS `expense_claims` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `uuid` char(36) NOT NULL,
  `organization_id` bigint(20) unsigned NOT NULL,
  `employee_uuid` char(36) NOT NULL,
  `employee_name` varchar(200) NOT NULL,
  `category_uuid` char(36) NOT NULL,
  `amount` decimal(14,2) NOT NULL,
  `expense_date` date NOT NULL,
  `description` varchar(500) DEFAULT NULL,
  `status` enum('pending','approved','rejected','paid') NOT NULL DEFAULT 'pending',
  `payment_mode` enum('payroll','direct') NOT NULL DEFAULT 'payroll',
  `reviewed_by_uuid` char(36) DEFAULT NULL,
  `reviewed_at` datetime DEFAULT NULL,
  `rejection_reason` varchar(500) DEFAULT NULL,
  `paid_at` datetime DEFAULT NULL,
  `paid_via_salary_record_uuid` char(36) DEFAULT NULL,
  `payment_reference` varchar(120) DEFAULT NULL,
  `created_by` char(36) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `expense_year` smallint(5) unsigned GENERATED ALWAYS AS (year(`expense_date`)) STORED,
  `expense_month` tinyint(3) unsigned GENERATED ALWAYS AS (month(`expense_date`)) STORED,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_expense_claims_uuid` (`uuid`),
  KEY `idx_expense_claims_org_status` (`organization_id`,`status`),
  KEY `idx_expense_claims_employee` (`organization_id`,`employee_uuid`,`expense_date`),
  KEY `idx_expense_claims_period` (`organization_id`,`expense_year`,`expense_month`),
  KEY `idx_expense_claims_paid_via` (`paid_via_salary_record_uuid`),
  KEY `fk_expense_claims_category` (`category_uuid`),
  KEY `fk_expense_claims_category_tenant` (`organization_id`,`category_uuid`),
  KEY `idx_expense_claims_employee_uuid` (`employee_uuid`),
  CONSTRAINT `fk_expense_claims_category` FOREIGN KEY (`category_uuid`) REFERENCES `expense_categories` (`uuid`),
  CONSTRAINT `fk_expense_claims_category_tenant` FOREIGN KEY (`organization_id`, `category_uuid`) REFERENCES `expense_categories` (`organization_id`, `uuid`),
  CONSTRAINT `fk_expense_claims_employee` FOREIGN KEY (`employee_uuid`) REFERENCES `employees` (`uuid`) ON DELETE CASCADE,
  CONSTRAINT `fk_expense_claims_org` FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=516 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
CREATE TABLE IF NOT EXISTS `final_settlements` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `uuid` char(36) NOT NULL,
  `organization_id` bigint(20) unsigned NOT NULL,
  `exit_request_uuid` char(36) NOT NULL,
  `employee_uuid` char(36) NOT NULL,
  `basic_salary` decimal(14,2) NOT NULL DEFAULT 0.00,
  `working_days_in_month` int(11) NOT NULL DEFAULT 0,
  `per_day_rate` decimal(14,2) NOT NULL DEFAULT 0.00,
  `leave_encashment_days` decimal(8,2) NOT NULL DEFAULT 0.00,
  `leave_encashment_amount` decimal(14,2) NOT NULL DEFAULT 0.00,
  `asset_deductions` decimal(14,2) NOT NULL DEFAULT 0.00,
  `asset_deductions_exposure` decimal(14,2) NOT NULL DEFAULT 0.00,
  `unreturned_asset_count` int(11) NOT NULL DEFAULT 0,
  `net_fnf_amount` decimal(14,2) NOT NULL DEFAULT 0.00,
  `status` enum('draft','processed','paid') NOT NULL DEFAULT 'draft',
  `processed_by` char(36) DEFAULT NULL,
  `processed_at` datetime DEFAULT NULL,
  `paid_at` datetime DEFAULT NULL,
  `payment_reference` varchar(120) DEFAULT NULL,
  `notes` varchar(1000) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_final_settlements_uuid` (`uuid`),
  UNIQUE KEY `uk_final_settlements_exit` (`exit_request_uuid`),
  KEY `idx_settlements_org_status` (`organization_id`,`status`),
  KEY `idx_settlements_employee` (`organization_id`,`employee_uuid`),
  KEY `fk_settlements_employee` (`employee_uuid`),
  CONSTRAINT `fk_settlements_employee` FOREIGN KEY (`employee_uuid`) REFERENCES `employees` (`uuid`) ON DELETE CASCADE,
  CONSTRAINT `fk_settlements_exit` FOREIGN KEY (`exit_request_uuid`) REFERENCES `exit_requests` (`uuid`) ON DELETE CASCADE,
  CONSTRAINT `fk_settlements_org` FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=19 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
CREATE TABLE IF NOT EXISTS `holidays` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `uuid` char(36) NOT NULL,
  `organization_id` bigint(20) unsigned NOT NULL,
  `name` varchar(150) NOT NULL,
  `date` date NOT NULL,
  `created_by` bigint(20) unsigned DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_holidays_uuid` (`uuid`),
  UNIQUE KEY `uk_holidays_org_date` (`organization_id`,`date`),
  KEY `idx_holidays_org_date` (`organization_id`,`date`),
  CONSTRAINT `fk_holidays_org` FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=18 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
CREATE TABLE IF NOT EXISTS `hr_letters` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `uuid` char(36) NOT NULL,
  `organization_id` bigint(20) unsigned NOT NULL,
  `employee_uuid` char(36) NOT NULL,
  `template_uuid` char(36) DEFAULT NULL,
  `letter_type` enum('offer','increment','experience','employment_confirmation','warning','appreciation','custom') NOT NULL DEFAULT 'custom',
  `reference_no` varchar(40) NOT NULL,
  `title` varchar(200) NOT NULL,
  `payload` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`payload`)),
  `body_snapshot` longtext DEFAULT NULL,
  `file_path` varchar(500) DEFAULT NULL,
  `qr_token` char(64) DEFAULT NULL,
  `qr_signature` char(64) DEFAULT NULL,
  `status` enum('draft','issued','revoked') NOT NULL DEFAULT 'draft',
  `issued_by_uuid` char(36) DEFAULT NULL,
  `issued_at` datetime DEFAULT NULL,
  `revoked_at` datetime DEFAULT NULL,
  `revoked_reason` varchar(500) DEFAULT NULL,
  `notes` text DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_hr_letters_uuid` (`uuid`),
  UNIQUE KEY `uk_hr_letters_reference` (`organization_id`,`reference_no`),
  UNIQUE KEY `uk_hr_letters_qr_token` (`qr_token`),
  KEY `idx_hr_letters_entity` (`organization_id`,`letter_type`,`status`),
  KEY `idx_hr_letters_employee` (`employee_uuid`),
  KEY `idx_hr_letters_qr` (`qr_token`),
  KEY `fk_hr_letters_template` (`template_uuid`),
  KEY `fk_hr_letters_issuer` (`issued_by_uuid`),
  CONSTRAINT `fk_hr_letters_employee` FOREIGN KEY (`employee_uuid`) REFERENCES `employees` (`uuid`) ON DELETE CASCADE,
  CONSTRAINT `fk_hr_letters_issuer` FOREIGN KEY (`issued_by_uuid`) REFERENCES `users` (`uuid`) ON DELETE SET NULL,
  CONSTRAINT `fk_hr_letters_org` FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_hr_letters_template` FOREIGN KEY (`template_uuid`) REFERENCES `letter_templates` (`uuid`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
DROP TRIGGER IF EXISTS `bi_hr_letters_uuid`;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bi_hr_letters_uuid`
BEFORE INSERT ON `hr_letters`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END */;;
DELIMITER ;
CREATE TABLE IF NOT EXISTS `interviews` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `uuid` char(36) NOT NULL,
  `organization_id` bigint(20) unsigned NOT NULL,
  `candidate_uuid` char(36) NOT NULL,
  `interviewer_uuid` char(36) DEFAULT NULL,
  `scheduled_at` datetime NOT NULL,
  `mode` enum('onsite','phone','video','other') DEFAULT NULL,
  `location` varchar(150) DEFAULT NULL,
  `feedback_notes` text DEFAULT NULL,
  `rating` decimal(3,2) DEFAULT NULL,
  `status` enum('scheduled','completed','cancelled') NOT NULL DEFAULT 'scheduled',
  `outcome` enum('pending','passed','failed') NOT NULL DEFAULT 'pending',
  `created_by_uuid` char(36) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_interviews_uuid` (`uuid`),
  UNIQUE KEY `uk_interviews_org_uuid` (`organization_id`,`uuid`),
  UNIQUE KEY `uk_interviews_interviewer_slot` (`organization_id`,`interviewer_uuid`,`scheduled_at`),
  KEY `idx_interviews_candidate` (`organization_id`,`candidate_uuid`,`scheduled_at`),
  KEY `idx_interviews_interviewer` (`organization_id`,`interviewer_uuid`,`scheduled_at`),
  CONSTRAINT `fk_interviews_candidate_tenant` FOREIGN KEY (`organization_id`, `candidate_uuid`) REFERENCES `candidates` (`organization_id`, `uuid`) ON DELETE CASCADE,
  CONSTRAINT `fk_interviews_org` FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=4 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
CREATE TABLE IF NOT EXISTS `invite_tokens` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `user_uuid` char(36) NOT NULL,
  `token_hash` char(64) NOT NULL COMMENT 'SHA-256 hex of the raw token sent to user',
  `expires_at` datetime NOT NULL,
  `used_at` datetime DEFAULT NULL,
  `delivery_status` enum('pending','sent','failed') NOT NULL DEFAULT 'sent',
  `delivery_error` varchar(500) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_invite_user_uuid` (`user_uuid`),
  KEY `idx_invite_token_hash` (`token_hash`),
  KEY `fk_it_user_idx` (`user_uuid`),
  CONSTRAINT `fk_it_user` FOREIGN KEY (`user_uuid`) REFERENCES `users` (`uuid`)
) ENGINE=InnoDB AUTO_INCREMENT=6 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
CREATE TABLE IF NOT EXISTS `job_openings` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `uuid` char(36) NOT NULL,
  `organization_id` bigint(20) unsigned NOT NULL,
  `title` varchar(150) NOT NULL,
  `department_id` int(11) DEFAULT NULL,
  `designation_id` int(11) DEFAULT NULL,
  `location` varchar(120) DEFAULT NULL,
  `employment_type` enum('full_time','part_time','contract','internship','temporary') NOT NULL DEFAULT 'full_time',
  `description` text DEFAULT NULL,
  `status` enum('draft','open','closed') NOT NULL DEFAULT 'draft',
  `vacancies` smallint(5) unsigned NOT NULL DEFAULT 1,
  `interview_required` tinyint(1) NOT NULL DEFAULT 0,
  `created_by_uuid` char(36) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_job_openings_uuid` (`uuid`),
  UNIQUE KEY `uk_job_openings_org_uuid` (`organization_id`,`uuid`),
  KEY `idx_job_openings_org_status` (`organization_id`,`status`),
  KEY `fk_job_openings_department_tenant` (`organization_id`,`department_id`),
  KEY `fk_job_openings_designation_tenant` (`organization_id`,`designation_id`),
  CONSTRAINT `fk_job_openings_department_tenant` FOREIGN KEY (`organization_id`, `department_id`) REFERENCES `departments` (`organization_id`, `id`),
  CONSTRAINT `fk_job_openings_designation_tenant` FOREIGN KEY (`organization_id`, `designation_id`) REFERENCES `designations` (`organization_id`, `id`),
  CONSTRAINT `fk_job_openings_org` FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=10 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
CREATE TABLE IF NOT EXISTS `lead_status_history` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `lead_type` enum('contact','access_request') NOT NULL,
  `lead_uuid` char(36) NOT NULL,
  `old_status` varchar(32) DEFAULT NULL,
  `new_status` varchar(32) NOT NULL,
  `notes` text DEFAULT NULL,
  `changed_by_admin_id` int(11) DEFAULT NULL,
  `changed_by_name` varchar(255) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_lead` (`lead_type`,`lead_uuid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `leave_requests` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `uuid` char(36) NOT NULL,
  `employee_uuid` char(36) NOT NULL,
  `leave_type_id` bigint(20) unsigned NOT NULL,
  `start_date` date NOT NULL,
  `end_date` date NOT NULL,
  `reason` varchar(1000) DEFAULT NULL,
  `status` enum('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  `approved_by` char(36) DEFAULT NULL,
  `approved_at` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_leave_requests_uuid` (`uuid`),
  KEY `idx_leave_requests_employee` (`employee_uuid`),
  KEY `idx_leave_requests_status` (`status`),
  KEY `idx_leave_requests_type` (`leave_type_id`),
  KEY `idx_leave_requests_approved_by` (`approved_by`),
  CONSTRAINT `fk_leave_requests_employee` FOREIGN KEY (`employee_uuid`) REFERENCES `employees` (`uuid`) ON DELETE CASCADE,
  CONSTRAINT `fk_leave_requests_type` FOREIGN KEY (`leave_type_id`) REFERENCES `leave_types` (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=85 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
DROP TRIGGER IF EXISTS `bi_leave_requests_uuid`;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bi_leave_requests_uuid`
BEFORE INSERT ON `leave_requests`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END */;;
DELIMITER ;
CREATE TABLE IF NOT EXISTS `leave_types` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `organization_id` bigint(20) unsigned NOT NULL,
  `name` varchar(100) NOT NULL,
  `days_allowed_per_year` int(11) NOT NULL DEFAULT 0,
  `is_paid` enum('yes','no') NOT NULL DEFAULT 'yes',
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_leave_types_org_name` (`organization_id`,`name`),
  KEY `idx_leave_types_org` (`organization_id`),
  CONSTRAINT `fk_leave_types_org` FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=67 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
CREATE TABLE IF NOT EXISTS `letter_templates` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `uuid` char(36) NOT NULL,
  `organization_id` bigint(20) unsigned NOT NULL,
  `letter_type` enum('offer','increment','experience','employment_confirmation','warning','appreciation','custom') NOT NULL DEFAULT 'custom',
  `name` varchar(120) NOT NULL,
  `body` longtext NOT NULL,
  `merge_fields` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`merge_fields`)),
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `created_by_uuid` char(36) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_letter_templates_uuid` (`uuid`),
  UNIQUE KEY `uk_letter_templates_org_name` (`organization_id`,`name`),
  KEY `idx_letter_templates_org` (`organization_id`,`letter_type`,`is_active`),
  KEY `fk_letter_templates_creator` (`created_by_uuid`),
  CONSTRAINT `fk_letter_templates_creator` FOREIGN KEY (`created_by_uuid`) REFERENCES `users` (`uuid`) ON DELETE SET NULL,
  CONSTRAINT `fk_letter_templates_org` FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=67 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
DROP TRIGGER IF EXISTS `bi_letter_templates_uuid`;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bi_letter_templates_uuid`
BEFORE INSERT ON `letter_templates`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END */;;
DELIMITER ;
CREATE TABLE IF NOT EXISTS `login_history` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `uuid` char(36) NOT NULL,
  `identity_type` enum('admin','user') NOT NULL,
  `identity_id` int(11) NOT NULL,
  `ip_address` varchar(45) DEFAULT NULL,
  `user_agent` varchar(512) DEFAULT NULL,
  `login_at` datetime NOT NULL DEFAULT current_timestamp(),
  `success` enum('yes','no') NOT NULL DEFAULT 'no',
  PRIMARY KEY (`id`),
  UNIQUE KEY `idx_login_history_uuid` (`uuid`),
  KEY `idx_login_history_identity` (`identity_type`,`identity_id`),
  KEY `idx_login_history_date` (`login_at`)
) ENGINE=InnoDB AUTO_INCREMENT=6 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
CREATE TABLE IF NOT EXISTS `login_otps` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `identity_type` enum('admin','user') NOT NULL,
  `identity_id` int(11) NOT NULL,
  `otp_hash` varchar(128) NOT NULL,
  `attempts` tinyint(3) unsigned NOT NULL DEFAULT 0,
  `expires_at` datetime NOT NULL,
  `used_at` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_login_otps_lookup` (`identity_type`,`identity_id`,`used_at`)
) ENGINE=InnoDB AUTO_INCREMENT=5 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
CREATE TABLE IF NOT EXISTS `notifications` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `user_uuid` char(36) NOT NULL,
  `type` varchar(50) NOT NULL DEFAULT 'verification_request',
  `title` varchar(255) NOT NULL,
  `message` text DEFAULT NULL,
  `link` varchar(500) DEFAULT NULL,
  `reference_id` varchar(36) DEFAULT NULL COMMENT 'UUID of related entity (e.g. request uuid)',
  `read_at` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_notif_user_uuid` (`user_uuid`),
  KEY `idx_notif_read` (`user_uuid`,`read_at`),
  KEY `fk_notif_user_idx` (`user_uuid`),
  CONSTRAINT `fk_notif_user` FOREIGN KEY (`user_uuid`) REFERENCES `users` (`uuid`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
CREATE TABLE IF NOT EXISTS `offboarding_checklists` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `uuid` char(36) NOT NULL,
  `organization_id` bigint(20) unsigned NOT NULL,
  `exit_request_uuid` char(36) NOT NULL,
  `department` enum('IT','Finance','Assets','HR') NOT NULL,
  `task_name` varchar(200) NOT NULL,
  `status` enum('pending','cleared') NOT NULL DEFAULT 'pending',
  `cleared_by_uuid` char(36) DEFAULT NULL,
  `cleared_at` datetime DEFAULT NULL,
  `notes` varchar(500) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_offboarding_checklists_uuid` (`uuid`),
  UNIQUE KEY `uk_checklist_exit_task` (`exit_request_uuid`,`task_name`),
  KEY `idx_checklist_org_status` (`organization_id`,`status`),
  CONSTRAINT `fk_checklist_exit` FOREIGN KEY (`exit_request_uuid`) REFERENCES `exit_requests` (`uuid`) ON DELETE CASCADE,
  CONSTRAINT `fk_checklist_org` FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=487 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
CREATE TABLE IF NOT EXISTS `organization_approval_policies` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `organization_id` bigint(20) unsigned NOT NULL,
  `strict_dual_control` tinyint(1) NOT NULL DEFAULT 1,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_org_approval_policies_org` (`organization_id`),
  CONSTRAINT `fk_org_approval_policies_org` FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=49 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `organization_ip_rules` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `organization_id` bigint(20) unsigned NOT NULL,
  `ip_address` varchar(64) NOT NULL,
  `rule_type` enum('allow','deny') NOT NULL DEFAULT 'allow',
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_organization_ip_rules_org_ip` (`organization_id`,`ip_address`),
  KEY `idx_organization_ip_rules_org` (`organization_id`),
  CONSTRAINT `fk_organization_ip_rules_org` FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
CREATE TABLE IF NOT EXISTS `organization_payroll_policies` (
  `organization_id` bigint(20) unsigned NOT NULL,
  `currency` char(3) NOT NULL DEFAULT 'PKR',
  `pay_frequency` enum('weekly','biweekly','semi_monthly','monthly') DEFAULT NULL,
  `daily_rate_basis` enum('actual_working_days','calendar_days','fixed_30') DEFAULT NULL,
  `hours_per_workday` decimal(5,2) DEFAULT NULL,
  `shift_start_time` time DEFAULT NULL,
  `late_grace_minutes` smallint(5) unsigned DEFAULT NULL,
  `late_arrivals_per_penalty` smallint(5) unsigned DEFAULT NULL,
  `late_penalty_days` decimal(5,2) DEFAULT NULL,
  `overtime_multiplier` decimal(5,2) DEFAULT NULL,
  `deduct_unpaid_leave` tinyint(1) DEFAULT NULL,
  `deduct_absences` tinyint(1) DEFAULT NULL,
  `deduct_late_arrivals` tinyint(1) DEFAULT NULL,
  `pay_approved_overtime` tinyint(1) DEFAULT NULL,
  `is_configured` tinyint(1) NOT NULL DEFAULT 0,
  `configured_by_uuid` char(36) DEFAULT NULL,
  `configured_at` datetime DEFAULT NULL,
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`organization_id`),
  KEY `idx_payroll_policy_configured` (`is_configured`),
  CONSTRAINT `fk_payroll_policy_org` FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
CREATE TABLE IF NOT EXISTS `organization_types` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `name` varchar(100) NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_organization_types_name` (`name`)
) ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
CREATE TABLE IF NOT EXISTS `organizations` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `uuid` char(36) NOT NULL,
  `name` varchar(200) NOT NULL,
  `verified` enum('yes','no') NOT NULL DEFAULT 'no',
  `logo` varchar(500) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `organization_type` int(11) DEFAULT NULL,
  `subscription_status` enum('active','expired','none','pending_payment') NOT NULL DEFAULT 'none',
  `subscription_start` datetime DEFAULT NULL,
  `subscription_expiry` datetime DEFAULT NULL,
  `subscription_plan_id` bigint(20) unsigned DEFAULT NULL,
  `pending_plan_id` bigint(20) unsigned DEFAULT NULL,
  `reminder_2d_sent` enum('yes','no') DEFAULT 'no',
  `reminder_2h_sent` enum('yes','no') DEFAULT 'no',
  `business_email` varchar(190) DEFAULT NULL,
  `deleted_at` datetime DEFAULT NULL,
  `last_expiry_reminder_sent` date DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `name` (`name`),
  UNIQUE KEY `uk_organizations_uuid` (`uuid`),
  KEY `idx_organizations_uuid` (`uuid`),
  KEY `idx_organizations_deleted_at` (`deleted_at`),
  KEY `idx_org_subscription_plan_id` (`subscription_plan_id`),
  KEY `idx_org_type` (`organization_type`),
  KEY `fk_org_pending_plan` (`pending_plan_id`),
  CONSTRAINT `fk_org_org_type` FOREIGN KEY (`organization_type`) REFERENCES `organization_types` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_org_pending_plan` FOREIGN KEY (`pending_plan_id`) REFERENCES `subscription_plans` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_org_subscription_plan_id` FOREIGN KEY (`subscription_plan_id`) REFERENCES `subscription_plans` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB AUTO_INCREMENT=420 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
DROP TRIGGER IF EXISTS `bi_organizations_uuid`;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bi_organizations_uuid`
BEFORE INSERT ON `organizations`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END */;;
DELIMITER ;
CREATE TABLE IF NOT EXISTS `overtime_requests` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `uuid` char(36) NOT NULL,
  `employee_uuid` char(36) NOT NULL,
  `organization_id` bigint(20) unsigned NOT NULL,
  `work_date` date NOT NULL,
  `requested_hours` decimal(5,2) NOT NULL DEFAULT 0.00,
  `approved_hours` decimal(5,2) NOT NULL DEFAULT 0.00,
  `reason` varchar(500) DEFAULT NULL,
  `status` enum('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  `decided_by` char(36) DEFAULT NULL,
  `decided_at` datetime DEFAULT NULL,
  `decision_notes` varchar(500) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_overtime_requests_uuid` (`uuid`),
  UNIQUE KEY `uk_overtime_employee_date` (`employee_uuid`,`work_date`),
  KEY `idx_overtime_org_status` (`organization_id`,`status`),
  KEY `idx_overtime_org_date` (`organization_id`,`work_date`),
  CONSTRAINT `fk_overtime_employee` FOREIGN KEY (`employee_uuid`) REFERENCES `employees` (`uuid`) ON DELETE CASCADE,
  CONSTRAINT `fk_overtime_org` FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=86 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
CREATE TABLE IF NOT EXISTS `password_reset_tokens` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `user_uuid` char(36) NOT NULL,
  `token_hash` char(64) NOT NULL COMMENT 'SHA-256 hex of the raw token sent to user',
  `expires_at` datetime NOT NULL,
  `used_at` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_prt_user_uuid` (`user_uuid`),
  KEY `idx_prt_token_hash` (`token_hash`),
  KEY `fk_prt_user_idx` (`user_uuid`),
  CONSTRAINT `fk_prt_user` FOREIGN KEY (`user_uuid`) REFERENCES `users` (`uuid`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
CREATE TABLE IF NOT EXISTS `payment` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `uuid` char(36) NOT NULL,
  `user_id` bigint(20) unsigned DEFAULT NULL,
  `organization_id` bigint(20) unsigned DEFAULT NULL,
  `amount` decimal(10,2) NOT NULL,
  `payment_method` varchar(50) NOT NULL DEFAULT 'manual',
  `transaction_reference` varchar(120) DEFAULT NULL,
  `refund_transaction_reference` varchar(255) DEFAULT NULL COMMENT 'Gateway reference for the refund, mirrored from the linked checkout for billing-history reconciliation',
  `refunded_at` datetime DEFAULT NULL COMMENT 'When the gateway confirmed the refund settled',
  `paid_at` datetime NOT NULL DEFAULT current_timestamp(),
  `purpose` varchar(200) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_payment_uuid` (`uuid`),
  UNIQUE KEY `uq_payment_txn_ref` (`transaction_reference`),
  KEY `idx_pay_user` (`user_id`),
  KEY `idx_payment_uuid` (`uuid`),
  KEY `idx_payment_org` (`organization_id`),
  CONSTRAINT `fk_pay_org` FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_pay_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
DROP TRIGGER IF EXISTS `bi_payment_uuid`;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bi_payment_uuid`
BEFORE INSERT ON `payment`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END */;;
DELIMITER ;
CREATE TABLE IF NOT EXISTS `person_documents` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `uuid` char(36) NOT NULL,
  `person_id` bigint(20) unsigned NOT NULL,
  `document_type` varchar(100) DEFAULT NULL,
  `document_hash` varchar(64) DEFAULT NULL,
  `verified_by_organization_id` bigint(20) unsigned DEFAULT NULL,
  `verified_by_verification_request_id` bigint(20) unsigned DEFAULT NULL,
  `verified_at` datetime DEFAULT NULL,
  `status` enum('verified','unverified') NOT NULL DEFAULT 'verified',
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `document_extracted_name` varchar(200) DEFAULT NULL,
  `document_extracted_cnic_hash` char(64) DEFAULT NULL,
  `match_status` enum('not_checked','matched','mismatched') NOT NULL DEFAULT 'not_checked',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_person_documents_uuid` (`uuid`),
  KEY `idx_person_documents_person` (`person_id`),
  KEY `idx_person_documents_doc_hash` (`document_hash`),
  KEY `verified_by_organization_id` (`verified_by_organization_id`),
  KEY `verified_by_verification_request_id` (`verified_by_verification_request_id`),
  CONSTRAINT `person_documents_ibfk_1` FOREIGN KEY (`person_id`) REFERENCES `persons` (`id`) ON DELETE CASCADE,
  CONSTRAINT `person_documents_ibfk_2` FOREIGN KEY (`verified_by_organization_id`) REFERENCES `organizations` (`id`) ON DELETE SET NULL,
  CONSTRAINT `person_documents_ibfk_3` FOREIGN KEY (`verified_by_verification_request_id`) REFERENCES `verification_requests` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
DROP TRIGGER IF EXISTS `bi_person_documents_uuid`;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bi_person_documents_uuid`
BEFORE INSERT ON `person_documents`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END */;;
DELIMITER ;
CREATE TABLE IF NOT EXISTS `persons` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `uuid` char(36) NOT NULL,
  `cnic_encrypted` varchar(500) NOT NULL,
  `cnic_hash` char(64) NOT NULL,
  `full_name` varchar(200) DEFAULT NULL,
  `is_nadra_verified` enum('yes','no') NOT NULL DEFAULT 'no',
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_persons_uuid` (`uuid`),
  UNIQUE KEY `uq_persons_cnic_hash` (`cnic_hash`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
DROP TRIGGER IF EXISTS `bi_persons_uuid`;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bi_persons_uuid`
BEFORE INSERT ON `persons`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END */;;
DELIMITER ;
CREATE TABLE IF NOT EXISTS `refresh_tokens` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `token_hash` char(64) NOT NULL COMMENT 'SHA-256 hex of the raw refresh JWT',
  `type` enum('user','admin') NOT NULL,
  `identifier` varchar(255) NOT NULL COMMENT 'user uuid or admin email',
  `expires_at` datetime NOT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_refresh_token_hash` (`token_hash`),
  KEY `idx_refresh_token_lookup` (`type`,`identifier`),
  KEY `idx_refresh_token_expires` (`expires_at`)
) ENGINE=InnoDB AUTO_INCREMENT=122 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
CREATE TABLE IF NOT EXISTS `salary_components` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `uuid` char(36) NOT NULL,
  `organization_id` bigint(20) unsigned NOT NULL,
  `name` varchar(150) NOT NULL,
  `type` enum('allowance','deduction') NOT NULL,
  `is_percentage` tinyint(1) NOT NULL DEFAULT 0,
  `default_value` decimal(14,2) NOT NULL DEFAULT 0.00,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `created_by` bigint(20) unsigned DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_salary_components_uuid` (`uuid`),
  UNIQUE KEY `uk_salary_components_org_name_type` (`organization_id`,`name`,`type`),
  KEY `idx_salary_components_org` (`organization_id`),
  KEY `fk_sc_created_by` (`created_by`),
  CONSTRAINT `fk_salary_components_org` FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_sc_created_by` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
DROP TRIGGER IF EXISTS `bi_salary_components_uuid`;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bi_salary_components_uuid`
BEFORE INSERT ON `salary_components`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END */;;
DELIMITER ;
CREATE TABLE IF NOT EXISTS `salary_record_lines` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `uuid` char(36) NOT NULL,
  `salary_record_uuid` char(36) NOT NULL,
  `organization_id` bigint(20) unsigned NOT NULL,
  `employee_uuid` char(36) NOT NULL,
  `month` tinyint(3) unsigned NOT NULL,
  `year` smallint(5) unsigned NOT NULL,
  `label` varchar(150) NOT NULL,
  `type` enum('earning','deduction') NOT NULL,
  `source` enum('basic','component','auto_unpaid_leave','auto_absenteeism','auto_late','auto_overtime','auto_expense','manual') NOT NULL,
  `amount` decimal(14,2) NOT NULL DEFAULT 0.00,
  `basis_value` decimal(10,2) DEFAULT NULL,
  `basis_unit` enum('days','hours','late_arrivals','claims') DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_salary_record_lines_uuid` (`uuid`),
  KEY `idx_srl_record` (`salary_record_uuid`),
  KEY `idx_srl_employee_period` (`employee_uuid`,`year`,`month`),
  KEY `idx_srl_org` (`organization_id`),
  CONSTRAINT `fk_srl_record` FOREIGN KEY (`salary_record_uuid`) REFERENCES `salary_records` (`uuid`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=289 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
CREATE TABLE IF NOT EXISTS `salary_records` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `uuid` char(36) NOT NULL,
  `employee_uuid` char(36) NOT NULL,
  `organization_id` bigint(20) unsigned NOT NULL,
  `month` tinyint(3) unsigned NOT NULL,
  `year` smallint(5) unsigned NOT NULL,
  `basic_salary` decimal(14,2) NOT NULL DEFAULT 0.00,
  `allowances` decimal(14,2) NOT NULL DEFAULT 0.00,
  `deductions` decimal(14,2) NOT NULL DEFAULT 0.00,
  `expense_reimbursement` decimal(14,2) NOT NULL DEFAULT 0.00,
  `net_salary` decimal(14,2) NOT NULL DEFAULT 0.00,
  `notes` text DEFAULT NULL,
  `created_by` bigint(20) unsigned DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_salary_employee_month` (`employee_uuid`,`year`,`month`),
  UNIQUE KEY `uk_salary_records_uuid` (`uuid`),
  KEY `idx_salary_org_month` (`organization_id`,`year`,`month`),
  KEY `idx_salary_employee` (`employee_uuid`),
  KEY `fk_sr_created_by` (`created_by`),
  CONSTRAINT `fk_salary_employee` FOREIGN KEY (`employee_uuid`) REFERENCES `employees` (`uuid`) ON DELETE CASCADE,
  CONSTRAINT `fk_salary_org` FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_sr_created_by` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB AUTO_INCREMENT=113 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
DROP TRIGGER IF EXISTS `bi_salary_records_uuid`;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bi_salary_records_uuid`
BEFORE INSERT ON `salary_records`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END */;;
DELIMITER ;
CREATE TABLE IF NOT EXISTS `schema_migrations` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `filename` varchar(255) NOT NULL,
  `checksum` char(32) NOT NULL,
  `applied_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_schema_migrations_filename` (`filename`)
) ENGINE=InnoDB AUTO_INCREMENT=118 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
CREATE TABLE IF NOT EXISTS `self_subscription_requests` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `uuid` char(36) NOT NULL,
  `organization_id` bigint(20) unsigned NOT NULL,
  `plan_uuid` char(36) NOT NULL,
  `requested_by_uuid` char(36) NOT NULL,
  `amount` decimal(12,2) DEFAULT NULL,
  `status` enum('pending','confirmed','cancelled') NOT NULL DEFAULT 'pending',
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `decided_at` datetime DEFAULT NULL,
  `decided_by` char(36) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_ssr_uuid` (`uuid`),
  KEY `idx_ssr_org` (`organization_id`),
  KEY `idx_ssr_status` (`status`),
  KEY `fk_ssr_org_idx` (`organization_id`),
  CONSTRAINT `fk_ssr_org` FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
DROP TRIGGER IF EXISTS `bi_self_subscription_requests_uuid`;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bi_self_subscription_requests_uuid`
BEFORE INSERT ON `self_subscription_requests`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END */;;
DELIMITER ;
CREATE TABLE IF NOT EXISTS `subscription_checkouts` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `uuid` char(36) NOT NULL,
  `organization_id` bigint(20) unsigned NOT NULL,
  `plan_id` int(11) NOT NULL,
  `resulted_in_pending_plan_id` bigint(20) unsigned DEFAULT NULL COMMENT 'Plan this checkout scheduled via organizations.pending_plan_id; NULL when it applied immediately',
  `refund_status` enum('none','pending','refunded','failed') NOT NULL DEFAULT 'none' COMMENT 'none = never refunded; pending = submitted, settlement not yet confirmed; refunded = gateway-confirmed',
  `refund_transaction_reference` varchar(255) DEFAULT NULL COMMENT 'Gateway reference for the refund (e.g. Safepay refund_...); the traceable link back to the original charge',
  `refund_requested_at` datetime DEFAULT NULL COMMENT 'When the refund was submitted to the gateway',
  `refunded_at` datetime DEFAULT NULL COMMENT 'When the gateway confirmed the refund settled',
  `plan_uuid` char(36) NOT NULL,
  `plan_name` varchar(255) NOT NULL,
  `gateway` enum('safepay') NOT NULL DEFAULT 'safepay',
  `gateway_tracker_id` varchar(255) DEFAULT NULL,
  `gateway_event_id` varchar(255) DEFAULT NULL,
  `amount` decimal(12,2) NOT NULL,
  `currency` char(3) NOT NULL DEFAULT 'PKR',
  `status` enum('pending','completed','failed','cancelled','refund_pending','refunded','expired') NOT NULL DEFAULT 'pending',
  `metadata` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`metadata`)),
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `completed_at` datetime DEFAULT NULL,
  `failed_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_sco_uuid` (`uuid`),
  UNIQUE KEY `uk_sco_gateway_tracker_id` (`gateway_tracker_id`),
  KEY `idx_sco_org_status` (`organization_id`,`status`),
  KEY `idx_sco_plan_id` (`plan_id`),
  KEY `idx_sco_gateway_event_id` (`gateway_event_id`),
  KEY `fk_sco_org_idx` (`organization_id`),
  KEY `idx_sco_pending_result` (`organization_id`,`resulted_in_pending_plan_id`,`status`),
  KEY `idx_sco_refund_status` (`organization_id`,`refund_status`),
  CONSTRAINT `fk_sco_org` FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
DROP TRIGGER IF EXISTS `bi_subscription_checkouts_uuid`;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bi_subscription_checkouts_uuid`
BEFORE INSERT ON `subscription_checkouts`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END */;;
DELIMITER ;
CREATE TABLE IF NOT EXISTS `subscription_plans` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `uuid` char(36) NOT NULL,
  `name` varchar(120) NOT NULL,
  `monthly_price` decimal(12,2) NOT NULL DEFAULT 0.00,
  `daily_request_quota` int(11) NOT NULL DEFAULT 0,
  `description` text DEFAULT NULL,
  `features` longtext DEFAULT NULL,
  `billing_period` enum('monthly','yearly') NOT NULL DEFAULT 'monthly',
  `is_public` tinyint(1) NOT NULL DEFAULT 0,
  `is_custom` tinyint(1) NOT NULL DEFAULT 0,
  `is_free` tinyint(1) NOT NULL DEFAULT 0,
  `is_recommended` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `module_flags` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL DEFAULT '{"employee_management":true,"attendance_management":true,"user_management":true,"leave_management":true,"payroll_management":true,"manpower_management":true,"recruitment_management":true,"onboarding_management":true,"separation_management":true,"training_management":true,"performance_management":true,"piece_work_management":true,"expense_management":true,"travel_management":true,"asset_management":true,"helpdesk_management":true,"scheduled_reports":true,"hr_letters_management":true}' CHECK (json_valid(`module_flags`)),
  `free_plan_guard` tinyint(3) unsigned GENERATED ALWAYS AS (if(`is_free` = 1,1,NULL)) VIRTUAL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_subscription_plans_uuid` (`uuid`),
  UNIQUE KEY `uq_subscription_plans_single_free` (`free_plan_guard`)
) ENGINE=InnoDB AUTO_INCREMENT=13 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
DROP TRIGGER IF EXISTS `bi_subscription_plans_uuid`;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bi_subscription_plans_uuid`
BEFORE INSERT ON `subscription_plans`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END */;;
DELIMITER ;
CREATE TABLE IF NOT EXISTS `support_ticket_replies` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `uuid` char(36) NOT NULL,
  `ticket_uuid` char(36) NOT NULL,
  `replied_by_uuid` char(36) NOT NULL,
  `replied_by_type` enum('admin','org_user') NOT NULL,
  `message` text NOT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_support_ticket_replies_uuid` (`uuid`),
  KEY `idx_support_replies_ticket` (`ticket_uuid`),
  KEY `fk_str_replied_by_idx` (`replied_by_uuid`),
  KEY `fk_str_ticket_idx` (`ticket_uuid`),
  CONSTRAINT `fk_str_replied_by` FOREIGN KEY (`replied_by_uuid`) REFERENCES `users` (`uuid`) ON DELETE CASCADE,
  CONSTRAINT `fk_str_ticket` FOREIGN KEY (`ticket_uuid`) REFERENCES `support_tickets` (`uuid`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
CREATE TABLE IF NOT EXISTS `support_tickets` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `uuid` char(36) NOT NULL,
  `organization_id` bigint(20) unsigned NOT NULL,
  `raised_by_uuid` char(36) NOT NULL,
  `subject` varchar(255) NOT NULL,
  `description` text NOT NULL,
  `category` enum('it','hr','admin','payroll') NOT NULL DEFAULT 'it',
  `priority` enum('low','medium','high') NOT NULL DEFAULT 'medium',
  `assigned_to_role` enum('org_admin','system_admin') NOT NULL DEFAULT 'org_admin',
  `assigned_to_uuid` char(36) DEFAULT NULL,
  `status` enum('open','in_progress','resolved','closed') NOT NULL DEFAULT 'open',
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_support_tickets_uuid` (`uuid`),
  KEY `idx_support_tickets_org` (`organization_id`),
  KEY `idx_support_tickets_status` (`status`),
  KEY `idx_support_tickets_priority` (`priority`),
  KEY `idx_support_tickets_category` (`category`),
  KEY `idx_support_tickets_assigned_role` (`assigned_to_role`),
  KEY `fk_st_org_idx` (`organization_id`),
  KEY `fk_st_raised_by_idx` (`raised_by_uuid`),
  CONSTRAINT `fk_st_org` FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`),
  CONSTRAINT `fk_st_raised_by` FOREIGN KEY (`raised_by_uuid`) REFERENCES `users` (`uuid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
CREATE TABLE IF NOT EXISTS `token_blacklist` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `token_hash` char(64) NOT NULL COMMENT 'SHA-256 hex of the raw JWT',
  `expires_at` datetime NOT NULL COMMENT 'Expiry of the blacklisted token',
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_token_blacklist_hash` (`token_hash`),
  KEY `idx_token_blacklist_expires` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
CREATE TABLE IF NOT EXISTS `unmatched_organizations` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `uuid` char(36) NOT NULL,
  `name` varchar(200) NOT NULL,
  `email` varchar(200) DEFAULT NULL,
  `phone` varchar(50) DEFAULT NULL,
  `website` varchar(500) DEFAULT NULL,
  `status` enum('pending','contacted','converted','ignored') NOT NULL DEFAULT 'pending',
  `assigned_organization_id` bigint(20) unsigned DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_unmatched_orgs_uuid` (`uuid`),
  UNIQUE KEY `uk_unmatched_orgs_name` (`name`),
  KEY `idx_unmatched_orgs_status` (`status`),
  KEY `idx_unmatched_orgs_assigned_org` (`assigned_organization_id`),
  CONSTRAINT `fk_unmatched_orgs_assigned_org` FOREIGN KEY (`assigned_organization_id`) REFERENCES `organizations` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
DROP TRIGGER IF EXISTS `bi_unmatched_orgs_uuid`;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bi_unmatched_orgs_uuid`
BEFORE INSERT ON `unmatched_organizations`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END */;;
DELIMITER ;
CREATE TABLE IF NOT EXISTS `users` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `uuid` char(36) NOT NULL,
  `full_name` varchar(150) NOT NULL,
  `email` varchar(190) NOT NULL,
  `phone` varchar(30) DEFAULT NULL,
  `phone_normalized` varchar(20) DEFAULT NULL COMMENT 'Canonical national form of `phone`, derived by trigger. UNIQUE across live rows; NULL for soft-deleted or blank.',
  `password` varchar(255) NOT NULL,
  `cnic` varchar(30) DEFAULT NULL,
  `status` enum('active','inactive') NOT NULL DEFAULT 'active',
  `org_role` enum('org_admin','sub_admin','employee') NOT NULL DEFAULT 'employee',
  `preferred_language` enum('en','ur') NOT NULL DEFAULT 'en',
  `organization` bigint(20) unsigned DEFAULT NULL,
  `profile_image` varchar(500) DEFAULT NULL,
  `is_verified` enum('yes','no') NOT NULL DEFAULT 'no',
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `feature_access` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`feature_access`)),
  `deleted_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `email` (`email`),
  UNIQUE KEY `uk_users_uuid` (`uuid`),
  UNIQUE KEY `cnic` (`cnic`),
  UNIQUE KEY `uq_users_phone_normalized` (`phone_normalized`),
  KEY `idx_users_org` (`organization`),
  KEY `idx_users_uuid` (`uuid`),
  KEY `idx_users_deleted_at` (`deleted_at`),
  KEY `idx_users_cnic` (`cnic`),
  CONSTRAINT `fk_users_org` FOREIGN KEY (`organization`) REFERENCES `organizations` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=454 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
DROP TRIGGER IF EXISTS `bi_users_uuid`;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bi_users_uuid`
BEFORE INSERT ON `users`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END */;;
DELIMITER ;
DROP TRIGGER IF EXISTS `bi_users_phone_normalize`;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bi_users_phone_normalize` BEFORE INSERT ON `users`
FOR EACH ROW
BEGIN
  SET NEW.phone_normalized = dverif_normalize_phone(NEW.phone, NEW.deleted_at);
END */;;
DELIMITER ;
DROP TRIGGER IF EXISTS `bu_users_phone_normalize`;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bu_users_phone_normalize` BEFORE UPDATE ON `users`
FOR EACH ROW
BEGIN
  SET NEW.phone_normalized = dverif_normalize_phone(NEW.phone, NEW.deleted_at);
END */;;
DELIMITER ;
CREATE TABLE IF NOT EXISTS `verification_requests` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `uuid` char(36) NOT NULL,
  `user_id` bigint(20) unsigned NOT NULL,
  `document_type` varchar(100) NOT NULL,
  `issuing_organization_id` bigint(20) unsigned DEFAULT NULL,
  `unmatched_org_id` bigint(20) unsigned DEFAULT NULL,
  `status` enum('under_review','verified','auto_verified','unverified') NOT NULL DEFAULT 'under_review',
  `submitted_at` datetime NOT NULL DEFAULT current_timestamp(),
  `verified_at` datetime DEFAULT NULL,
  `document_path` varchar(500) NOT NULL,
  `document_format` enum('pdf','jpeg') NOT NULL,
  `document_owner_name` varchar(200) DEFAULT NULL,
  `linked_person_id` bigint(20) unsigned DEFAULT NULL,
  `organization_conserned_for_future` enum('yes','no') NOT NULL DEFAULT 'no',
  `submission_remarks` varchar(500) DEFAULT NULL,
  `verification_remarks` varchar(500) DEFAULT NULL,
  `verified_by` bigint(20) unsigned DEFAULT NULL,
  `verification_method` enum('manual','portal','auto','admin','automatic_match') NOT NULL DEFAULT 'manual',
  `locked_by` bigint(20) unsigned DEFAULT NULL,
  `locked_at` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL,
  `document_hash` varchar(64) DEFAULT NULL,
  `document_validation_status` enum('passed','flagged','unvalidated') NOT NULL DEFAULT 'passed' COMMENT 'Automated document check: passed (structural checks clean), flagged (a heuristic quality signal fired) or unvalidated (service unreachable, checked nothing)',
  `document_validation_reason` varchar(500) DEFAULT NULL COMMENT 'Message from the document validation service when status = flagged',
  `qr_token` varchar(64) DEFAULT NULL,
  `qr_signature` varchar(128) DEFAULT NULL,
  `sla_reminder_sent_at` datetime DEFAULT NULL,
  `sla_flagged_at` datetime DEFAULT NULL,
  `match_status` enum('not_attempted','auto_matched','manual_review','no_reference_found') NOT NULL DEFAULT 'not_attempted',
  `match_confidence` decimal(5,2) DEFAULT NULL,
  `matched_employee_document_id` int(11) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_verification_requests_uuid` (`uuid`),
  UNIQUE KEY `uq_verification_requests_qr_token` (`qr_token`),
  KEY `fk_vr_user` (`user_id`),
  KEY `idx_vr_org` (`issuing_organization_id`),
  KEY `idx_vr_status` (`status`),
  KEY `idx_document_hash` (`document_hash`),
  KEY `idx_verification_requests_uuid` (`uuid`),
  KEY `idx_vr_unmatched_org` (`unmatched_org_id`),
  KEY `idx_vr_locked_by` (`locked_by`),
  KEY `idx_vr_sla` (`status`,`issuing_organization_id`,`created_at`),
  KEY `idx_vr_verified_by` (`verified_by`),
  KEY `idx_vr_linked_person` (`linked_person_id`),
  KEY `fk_vr_matched_emp_doc` (`matched_employee_document_id`),
  CONSTRAINT `fk_vr_linked_person` FOREIGN KEY (`linked_person_id`) REFERENCES `persons` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_vr_locked_by_admin` FOREIGN KEY (`locked_by`) REFERENCES `admin_profiles` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_vr_matched_emp_doc` FOREIGN KEY (`matched_employee_document_id`) REFERENCES `employee_documents` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_vr_org` FOREIGN KEY (`issuing_organization_id`) REFERENCES `organizations` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_vr_unmatched_org` FOREIGN KEY (`unmatched_org_id`) REFERENCES `unmatched_organizations` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_vr_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
DROP TRIGGER IF EXISTS `bi_verification_requests_uuid`;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bi_verification_requests_uuid`
BEFORE INSERT ON `verification_requests`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END */;;
DELIMITER ;
CREATE TABLE IF NOT EXISTS `work_week_config` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `organization_id` bigint(20) unsigned NOT NULL,
  `mon` tinyint(1) NOT NULL DEFAULT 1,
  `tue` tinyint(1) NOT NULL DEFAULT 1,
  `wed` tinyint(1) NOT NULL DEFAULT 1,
  `thu` tinyint(1) NOT NULL DEFAULT 1,
  `fri` tinyint(1) NOT NULL DEFAULT 1,
  `sat` tinyint(1) NOT NULL DEFAULT 0,
  `sun` tinyint(1) NOT NULL DEFAULT 0,
  `updated_by` bigint(20) unsigned DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_work_week_org` (`organization_id`),
  CONSTRAINT `fk_work_week_org` FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=52 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
CREATE TABLE IF NOT EXISTS `workflow_definitions` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `uuid` char(36) NOT NULL,
  `organization_id` bigint(20) unsigned NOT NULL,
  `module_key` varchar(60) NOT NULL,
  `entity_type` varchar(60) NOT NULL,
  `name` varchar(120) NOT NULL,
  `description` text DEFAULT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `is_default` tinyint(1) NOT NULL DEFAULT 0,
  `created_by_uuid` char(36) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_workflow_definitions_uuid` (`uuid`),
  UNIQUE KEY `uk_workflow_definitions_org` (`organization_id`,`module_key`,`entity_type`),
  KEY `idx_workflow_definitions_org` (`organization_id`),
  KEY `fk_workflow_definitions_creator` (`created_by_uuid`),
  CONSTRAINT `fk_workflow_definitions_creator` FOREIGN KEY (`created_by_uuid`) REFERENCES `users` (`uuid`) ON DELETE SET NULL,
  CONSTRAINT `fk_workflow_definitions_org` FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
DROP TRIGGER IF EXISTS `bi_workflow_definitions_uuid`;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bi_workflow_definitions_uuid`
BEFORE INSERT ON `workflow_definitions`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END */;;
DELIMITER ;
CREATE TABLE IF NOT EXISTS `workflow_steps` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `uuid` char(36) NOT NULL,
  `workflow_id` bigint(20) unsigned NOT NULL,
  `step_order` smallint(5) unsigned NOT NULL,
  `name` varchar(120) NOT NULL,
  `approver_type` enum('org_admin','sub_admin','specific_user','reporting_manager') NOT NULL,
  `approver_uuid` char(36) DEFAULT NULL,
  `required_approvals` smallint(5) unsigned NOT NULL DEFAULT 1,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_workflow_steps_uuid` (`uuid`),
  UNIQUE KEY `uk_workflow_steps_order` (`workflow_id`,`step_order`),
  KEY `fk_workflow_steps_approver` (`approver_uuid`),
  CONSTRAINT `fk_workflow_steps_approver` FOREIGN KEY (`approver_uuid`) REFERENCES `users` (`uuid`) ON DELETE SET NULL,
  CONSTRAINT `fk_workflow_steps_workflow` FOREIGN KEY (`workflow_id`) REFERENCES `workflow_definitions` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
DROP TRIGGER IF EXISTS `bi_workflow_steps_uuid`;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bi_workflow_steps_uuid`
BEFORE INSERT ON `workflow_steps`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END */;;
DELIMITER ;
/*!50003 DROP FUNCTION IF EXISTS `dverif_normalize_phone` */;
DROP FUNCTION IF EXISTS `dverif_normalize_phone`;
DELIMITER ;;
CREATE DEFINER=`root`@`localhost` FUNCTION `dverif_normalize_phone`(p_phone VARCHAR(30), p_deleted_at DATETIME) RETURNS varchar(20) CHARSET utf8mb4 COLLATE utf8mb4_general_ci
    DETERMINISTIC
BEGIN
  DECLARE v_digits VARCHAR(30);

  IF p_phone IS NULL OR p_deleted_at IS NOT NULL THEN
    RETURN NULL;
  END IF;

  SET v_digits = REGEXP_REPLACE(p_phone, '[^0-9]', '');

  IF v_digits = '' THEN
    RETURN NULL;
  END IF;

  IF CHAR_LENGTH(v_digits) = 14 AND v_digits LIKE '0092%' THEN
    SET v_digits = SUBSTRING(v_digits, 5);
  ELSEIF CHAR_LENGTH(v_digits) = 12 AND v_digits LIKE '92%' THEN
    SET v_digits = SUBSTRING(v_digits, 3);
  ELSEIF CHAR_LENGTH(v_digits) = 11 AND v_digits LIKE '0%' THEN
    SET v_digits = SUBSTRING(v_digits, 2);
  END IF;

  RETURN v_digits;
END ;;
DELIMITER ;
SET FOREIGN_KEY_CHECKS = @OLD_FOREIGN_KEY_CHECKS;
SET SQL_MODE = @OLD_SQL_MODE;
