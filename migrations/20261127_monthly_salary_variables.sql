-- Monthly, employee-specific variable earnings and deductions.
-- This migration is additive and safe to re-run.
CREATE TABLE IF NOT EXISTS `monthly_salary_variables` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `uuid` char(36) NOT NULL,
  `organization_id` bigint(20) unsigned NOT NULL,
  `employee_uuid` char(36) NOT NULL,
  `label` varchar(150) NOT NULL,
  `type` enum('allowance','deduction') NOT NULL,
  `amount` decimal(14,2) NOT NULL,
  `month` tinyint(3) unsigned NOT NULL,
  `year` smallint(5) unsigned NOT NULL,
  `created_by` bigint(20) unsigned DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_msv_uuid` (`uuid`),
  KEY `idx_msv_period_employee` (`organization_id`,`employee_uuid`,`year`,`month`),
  CONSTRAINT `fk_msv_org` FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_msv_employee` FOREIGN KEY (`employee_uuid`) REFERENCES `employees` (`uuid`) ON DELETE CASCADE,
  CONSTRAINT `fk_msv_created_by` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Existing databases already have salary_record_lines; extend its enum so the
-- new line source is accepted by payroll generation.
ALTER TABLE `salary_record_lines`
  MODIFY COLUMN `source` enum('basic','component','monthly_variable','auto_unpaid_leave','auto_absenteeism','auto_late','auto_overtime','auto_expense','manual') NOT NULL;
