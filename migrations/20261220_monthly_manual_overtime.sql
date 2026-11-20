CREATE TABLE IF NOT EXISTS `payroll_employee_overtime` (
  `organization_id` bigint(20) unsigned NOT NULL,
  `employee_uuid` char(36) NOT NULL,
  `month` tinyint(3) unsigned NOT NULL,
  `year` smallint(5) unsigned NOT NULL,
  `overtime_amount` decimal(14,2) NOT NULL DEFAULT 0.00,
  `updated_by_uuid` char(36) DEFAULT NULL,
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`organization_id`,`employee_uuid`,`year`,`month`),
  KEY `idx_payroll_employee_overtime_period` (`organization_id`,`year`,`month`),
  CONSTRAINT `fk_payroll_employee_overtime_org` FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_payroll_employee_overtime_employee` FOREIGN KEY (`employee_uuid`) REFERENCES `employees` (`uuid`) ON DELETE CASCADE,
  CONSTRAINT `chk_payroll_employee_overtime_month` CHECK (`month` BETWEEN 1 AND 12),
  CONSTRAINT `chk_payroll_employee_overtime_year` CHECK (`year` BETWEEN 2000 AND 2100)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

SET @add_manual_overtime_source = IF(
  (SELECT COLUMN_TYPE
     FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'salary_record_lines'
      AND COLUMN_NAME = 'source') NOT LIKE '%manual_overtime%',
  'ALTER TABLE `salary_record_lines` MODIFY COLUMN `source` enum(''basic'',''component'',''monthly_variable'',''auto_unpaid_leave'',''auto_absenteeism'',''auto_late'',''auto_overtime'',''auto_short_hours'',''auto_expense'',''manual_overtime'',''manual'') NOT NULL',
  'SELECT 1'
);
PREPARE add_manual_overtime_source_stmt FROM @add_manual_overtime_source;
EXECUTE add_manual_overtime_source_stmt;
DEALLOCATE PREPARE add_manual_overtime_source_stmt;
