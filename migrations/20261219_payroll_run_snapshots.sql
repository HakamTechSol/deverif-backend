-- Store the run-local policy and schedule used by each generated payroll record.
-- Existing records remain valid with NULL snapshots.
SET @add_payroll_policy_snapshot = IF(
  EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'salary_records'
       AND COLUMN_NAME = 'payroll_policy_snapshot'
  ),
  'SELECT 1',
  'ALTER TABLE `salary_records` ADD COLUMN `payroll_policy_snapshot` JSON NULL'
);
PREPARE add_payroll_policy_snapshot_stmt FROM @add_payroll_policy_snapshot;
EXECUTE add_payroll_policy_snapshot_stmt;
DEALLOCATE PREPARE add_payroll_policy_snapshot_stmt;

SET @add_payroll_schedule_snapshot = IF(
  EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'salary_records'
       AND COLUMN_NAME = 'payroll_schedule_snapshot'
  ),
  'SELECT 1',
  'ALTER TABLE `salary_records` ADD COLUMN `payroll_schedule_snapshot` JSON NULL'
);
PREPARE add_payroll_schedule_snapshot_stmt FROM @add_payroll_schedule_snapshot;
EXECUTE add_payroll_schedule_snapshot_stmt;
DEALLOCATE PREPARE add_payroll_schedule_snapshot_stmt;
