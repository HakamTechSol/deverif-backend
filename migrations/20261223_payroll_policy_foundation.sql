-- Add a four-way salary policy without rewriting the legacy method column.
-- Existing "hours" / "days" settings map to their working-day equivalents.
SET @add_default_payroll_policy = IF(
  EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'organization_payroll_settings'
       AND COLUMN_NAME = 'salary_calculation_policy'
  ),
  'SELECT 1',
  'ALTER TABLE `organization_payroll_settings`
     ADD COLUMN `salary_calculation_policy`
       ENUM(''working_days_only'',''working_days_and_hours'',''number_of_days_only'',''number_of_days_and_hours'')
       NOT NULL DEFAULT ''working_days_only'' AFTER `salary_calculation_method`'
);
PREPARE add_default_payroll_policy_stmt FROM @add_default_payroll_policy;
EXECUTE add_default_payroll_policy_stmt;
DEALLOCATE PREPARE add_default_payroll_policy_stmt;

SET @add_monthly_payroll_policy = IF(
  EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'organization_monthly_payroll_settings'
       AND COLUMN_NAME = 'salary_calculation_policy'
  ),
  'SELECT 1',
  'ALTER TABLE `organization_monthly_payroll_settings`
     ADD COLUMN `salary_calculation_policy`
       ENUM(''working_days_only'',''working_days_and_hours'',''number_of_days_only'',''number_of_days_and_hours'')
       NOT NULL DEFAULT ''working_days_only'' AFTER `salary_calculation_method`'
);
PREPARE add_monthly_payroll_policy_stmt FROM @add_monthly_payroll_policy;
EXECUTE add_monthly_payroll_policy_stmt;
DEALLOCATE PREPARE add_monthly_payroll_policy_stmt;

UPDATE organization_payroll_settings
   SET salary_calculation_policy = CASE salary_calculation_method
     WHEN 'hours' THEN 'working_days_and_hours'
     ELSE 'working_days_only'
   END
 WHERE salary_calculation_policy = 'working_days_only';

UPDATE organization_monthly_payroll_settings
   SET salary_calculation_policy = CASE salary_calculation_method
     WHEN 'hours' THEN 'working_days_and_hours'
     ELSE 'working_days_only'
   END
 WHERE salary_calculation_policy = 'working_days_only';
