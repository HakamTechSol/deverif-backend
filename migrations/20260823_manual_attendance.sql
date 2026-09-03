-- Manual attendance entries added by org-admins on behalf of employees.
ALTER TABLE attendance_records
  ADD COLUMN is_manual ENUM('yes','no') NOT NULL DEFAULT 'no' AFTER status,
  ADD COLUMN manual_reason VARCHAR(255) NULL AFTER is_manual;
