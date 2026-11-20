-- Preserve the existing one-record-per-employee-per-shift-date constraint while
-- recording how checkout happened and keeping actual duration inputs available.
SET @add_attendance_checkout_source = IF(
  EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'attendance_records'
       AND COLUMN_NAME = 'checkout_source'
  ),
  'SELECT 1',
  'ALTER TABLE `attendance_records`
     ADD COLUMN `checkout_source` ENUM(''self'',''admin'',''auto'') NULL DEFAULT ''self'' AFTER `check_out_ip`'
);
PREPARE add_attendance_checkout_source_stmt FROM @add_attendance_checkout_source;
EXECUTE add_attendance_checkout_source_stmt;
DEALLOCATE PREPARE add_attendance_checkout_source_stmt;

SET @add_attendance_break_duration = IF(
  EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'attendance_records'
       AND COLUMN_NAME = 'break_duration_minutes'
  ),
  'SELECT 1',
  'ALTER TABLE `attendance_records`
     ADD COLUMN `break_duration_minutes` SMALLINT UNSIGNED NULL AFTER `checkout_source`'
);
PREPARE add_attendance_break_duration_stmt FROM @add_attendance_break_duration;
EXECUTE add_attendance_break_duration_stmt;
DEALLOCATE PREPARE add_attendance_break_duration_stmt;

SET @add_attendance_worked_minutes = IF(
  EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'attendance_records'
       AND COLUMN_NAME = 'worked_minutes'
  ),
  'SELECT 1',
  'ALTER TABLE `attendance_records`
     ADD COLUMN `worked_minutes` INT UNSIGNED NULL AFTER `break_duration_minutes`'
);
PREPARE add_attendance_worked_minutes_stmt FROM @add_attendance_worked_minutes;
EXECUTE add_attendance_worked_minutes_stmt;
DEALLOCATE PREPARE add_attendance_worked_minutes_stmt;

SET @add_attendance_overtime_minutes = IF(
  EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'attendance_records'
       AND COLUMN_NAME = 'overtime_minutes'
  ),
  'SELECT 1',
  'ALTER TABLE `attendance_records`
     ADD COLUMN `overtime_minutes` INT UNSIGNED NULL AFTER `worked_minutes`'
);
PREPARE add_attendance_overtime_minutes_stmt FROM @add_attendance_overtime_minutes;
EXECUTE add_attendance_overtime_minutes_stmt;
DEALLOCATE PREPARE add_attendance_overtime_minutes_stmt;

UPDATE attendance_records
   SET checkout_source = CASE
     WHEN is_manual = 'yes' THEN 'admin'
     WHEN check_out_at = DATE_ADD(`date`, INTERVAL 1 DAY) THEN 'auto'
     ELSE 'self'
   END
 WHERE check_out_at IS NOT NULL
   AND (checkout_source IS NULL OR checkout_source = 'self');

UPDATE attendance_records
   SET checkout_source = NULL
 WHERE check_out_at IS NULL;
