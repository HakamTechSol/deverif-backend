-- Payroll calendar and per-request leave treatment.
ALTER TABLE leave_requests
  ADD COLUMN requested_treatment ENUM('paid','unpaid') NOT NULL DEFAULT 'unpaid',
  ADD COLUMN approved_treatment ENUM('paid','unpaid') NULL;

-- Preserve the treatment of existing requests before leave types become name-only.
UPDATE leave_requests lr
JOIN leave_types lt ON lt.id = lr.leave_type_id
SET lr.requested_treatment = CASE WHEN lt.is_paid='no' THEN 'unpaid' ELSE 'paid' END;
UPDATE leave_requests lr
JOIN leave_types lt ON lt.id = lr.leave_type_id
SET lr.approved_treatment = CASE WHEN lt.is_paid='no' THEN 'unpaid' ELSE 'paid' END
WHERE lr.status='approved';

CREATE TABLE IF NOT EXISTS organization_payroll_settings (
  organization_id INT NOT NULL,
  salary_calculation_method ENUM('hours','days') NOT NULL DEFAULT 'days',
  calculate_overtime TINYINT(1) NOT NULL DEFAULT 0,
  shift_start_time TIME NOT NULL DEFAULT '09:00:00',
  shift_end_time TIME NOT NULL DEFAULT '17:00:00',
  overtime_multiplier DECIMAL(5,2) NOT NULL DEFAULT 1.50,
  updated_by_uuid CHAR(36) NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (organization_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS organization_monthly_work_schedules (
  id BIGINT NOT NULL AUTO_INCREMENT,
  organization_id INT NOT NULL,
  schedule_date DATE NOT NULL,
  day_type ENUM('working','off') NOT NULL,
  updated_by_uuid CHAR(36) NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_org_schedule_date (organization_id, schedule_date),
  KEY idx_org_schedule_month (organization_id, schedule_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- These legacy tables are replaced by organization_payroll_settings and the
-- per-date organization_monthly_work_schedules calendar.
DROP TABLE IF EXISTS organization_payroll_policies;
DROP TABLE IF EXISTS work_week_config;
