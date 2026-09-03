-- Employee lifecycle, joining date, emergency contact, documents, and
-- managed departments / designations.

-- 1. New columns on employees
ALTER TABLE `employees`
  ADD COLUMN `joining_date` DATE NULL AFTER `department`,
  ADD COLUMN `emergency_contact` VARCHAR(30) NULL AFTER `joining_date`;

-- 2. Extend lifecycle status (keep 'inactive' = invite pending)
ALTER TABLE `employees`
  MODIFY COLUMN `status`
  ENUM('active','inactive','resigned','terminated') NOT NULL DEFAULT 'active';

-- 3. Employee documents
CREATE TABLE IF NOT EXISTS `employee_documents` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `uuid` CHAR(36) NOT NULL,
  `employee_uuid` CHAR(36) NOT NULL,
  `document_type` VARCHAR(100) DEFAULT NULL,
  `file_name` VARCHAR(255) NOT NULL,
  `file_path` VARCHAR(500) NOT NULL,
  `uploaded_by_uuid` CHAR(36) DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_employee_documents_uuid` (`uuid`),
  INDEX `idx_employee_documents_emp` (`employee_uuid`),
  CONSTRAINT `fk_employee_documents_emp`
    FOREIGN KEY (`employee_uuid`) REFERENCES `employees` (`uuid`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 4. Managed departments (org-scoped)
CREATE TABLE IF NOT EXISTS `departments` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `uuid` CHAR(36) NOT NULL,
  `organization_id` BIGINT UNSIGNED NOT NULL,
  `name` VARCHAR(100) NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_departments_uuid` (`uuid`),
  INDEX `idx_departments_org` (`organization_id`),
  CONSTRAINT `fk_departments_org`
    FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 5. Managed designations (org-scoped)
CREATE TABLE IF NOT EXISTS `designations` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `uuid` CHAR(36) NOT NULL,
  `organization_id` BIGINT UNSIGNED NOT NULL,
  `name` VARCHAR(100) NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_designations_uuid` (`uuid`),
  INDEX `idx_designations_org` (`organization_id`),
  CONSTRAINT `fk_designations_org`
    FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 6. UUID triggers
DROP TRIGGER IF EXISTS `bi_employee_documents_uuid`;
DELIMITER $$
CREATE TRIGGER `bi_employee_documents_uuid`
BEFORE INSERT ON `employee_documents`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END$$
DELIMITER ;

DROP TRIGGER IF EXISTS `bi_departments_uuid`;
DELIMITER $$
CREATE TRIGGER `bi_departments_uuid`
BEFORE INSERT ON `departments`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END$$
DELIMITER ;

DROP TRIGGER IF EXISTS `bi_designations_uuid`;
DELIMITER $$
CREATE TRIGGER `bi_designations_uuid`
BEFORE INSERT ON `designations`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END$$
DELIMITER ;
