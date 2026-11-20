SET @add_org_late_arrival_deduction = IF(
  EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'organization_payroll_settings'
       AND COLUMN_NAME = 'deduct_salary_for_late_arrivals'
  ),
  'SELECT 1',
  'ALTER TABLE `organization_payroll_settings` ADD COLUMN `deduct_salary_for_late_arrivals` TINYINT(1) NOT NULL DEFAULT 0'
);
PREPARE add_org_late_arrival_deduction_stmt FROM @add_org_late_arrival_deduction;
EXECUTE add_org_late_arrival_deduction_stmt;
DEALLOCATE PREPARE add_org_late_arrival_deduction_stmt;

SET @add_org_late_arrival_threshold = IF(
  EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'organization_payroll_settings'
       AND COLUMN_NAME = 'late_arrival_threshold'
  ),
  'SELECT 1',
  'ALTER TABLE `organization_payroll_settings` ADD COLUMN `late_arrival_threshold` INT UNSIGNED NOT NULL DEFAULT 1'
);
PREPARE add_org_late_arrival_threshold_stmt FROM @add_org_late_arrival_threshold;
EXECUTE add_org_late_arrival_threshold_stmt;
DEALLOCATE PREPARE add_org_late_arrival_threshold_stmt;

SET @add_monthly_late_arrival_deduction = IF(
  EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'organization_monthly_payroll_settings'
       AND COLUMN_NAME = 'deduct_salary_for_late_arrivals'
  ),
  'SELECT 1',
  'ALTER TABLE `organization_monthly_payroll_settings` ADD COLUMN `deduct_salary_for_late_arrivals` TINYINT(1) NOT NULL DEFAULT 0'
);
PREPARE add_monthly_late_arrival_deduction_stmt FROM @add_monthly_late_arrival_deduction;
EXECUTE add_monthly_late_arrival_deduction_stmt;
DEALLOCATE PREPARE add_monthly_late_arrival_deduction_stmt;

SET @add_monthly_late_arrival_threshold = IF(
  EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'organization_monthly_payroll_settings'
       AND COLUMN_NAME = 'late_arrival_threshold'
  ),
  'SELECT 1',
  'ALTER TABLE `organization_monthly_payroll_settings` ADD COLUMN `late_arrival_threshold` INT UNSIGNED NOT NULL DEFAULT 1'
);
PREPARE add_monthly_late_arrival_threshold_stmt FROM @add_monthly_late_arrival_threshold;
EXECUTE add_monthly_late_arrival_threshold_stmt;
DEALLOCATE PREPARE add_monthly_late_arrival_threshold_stmt;
