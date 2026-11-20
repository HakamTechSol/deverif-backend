SET @add_org_late_grace_minutes = IF(
  EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'organization_payroll_settings'
       AND COLUMN_NAME = 'late_grace_minutes'
  ),
  'SELECT 1',
  'ALTER TABLE `organization_payroll_settings` ADD COLUMN `late_grace_minutes` INT UNSIGNED NOT NULL DEFAULT 10'
);
PREPARE add_org_late_grace_minutes_stmt FROM @add_org_late_grace_minutes;
EXECUTE add_org_late_grace_minutes_stmt;
DEALLOCATE PREPARE add_org_late_grace_minutes_stmt;

SET @add_monthly_late_grace_minutes = IF(
  EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'organization_monthly_payroll_settings'
       AND COLUMN_NAME = 'late_grace_minutes'
  ),
  'SELECT 1',
  'ALTER TABLE `organization_monthly_payroll_settings` ADD COLUMN `late_grace_minutes` INT UNSIGNED NOT NULL DEFAULT 10'
);
PREPARE add_monthly_late_grace_minutes_stmt FROM @add_monthly_late_grace_minutes;
EXECUTE add_monthly_late_grace_minutes_stmt;
DEALLOCATE PREPARE add_monthly_late_grace_minutes_stmt;
