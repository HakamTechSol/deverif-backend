CREATE TABLE IF NOT EXISTS organization_monthly_payroll_settings (
  organization_id INT NOT NULL,
  month TINYINT UNSIGNED NOT NULL,
  year SMALLINT UNSIGNED NOT NULL,
  salary_calculation_method ENUM('hours','days') NOT NULL DEFAULT 'days',
  calculate_overtime TINYINT(1) NOT NULL DEFAULT 0,
  shift_start_time TIME NOT NULL DEFAULT '09:00:00',
  shift_end_time TIME NOT NULL DEFAULT '17:00:00',
  overtime_multiplier DECIMAL(5,2) NOT NULL DEFAULT 1.50,
  updated_by_uuid CHAR(36) NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (organization_id, year, month),
  CONSTRAINT chk_monthly_payroll_settings_month CHECK (month BETWEEN 1 AND 12),
  CONSTRAINT chk_monthly_payroll_settings_year CHECK (year BETWEEN 2000 AND 2100)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
