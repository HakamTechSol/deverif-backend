-- Salary record-keeping (manual ledger, NOT automated payroll/tax compliance).
-- Net salary is stored for audit purposes and computed as basic + allowances - deductions.
CREATE TABLE IF NOT EXISTS salary_records (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  uuid            CHAR(36) NOT NULL,
  employee_uuid   CHAR(36) NOT NULL,
  organization_id BIGINT UNSIGNED NOT NULL,
  month           TINYINT UNSIGNED NOT NULL,
  year            SMALLINT UNSIGNED NOT NULL,
  basic_salary    DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  allowances      DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  deductions      DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  net_salary      DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  notes           TEXT NULL,
  -- created_by: loose reference (users.id for org-admin, admin_profiles.id for
  -- platform admin). No FK — intentionally a lightweight audit pointer.
  created_by      BIGINT UNSIGNED NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_salary_employee_month (employee_uuid, year, month),
  INDEX idx_salary_org_month (organization_id, year, month),
  INDEX idx_salary_employee (employee_uuid),
  CONSTRAINT fk_salary_employee
    FOREIGN KEY (employee_uuid) REFERENCES employees (uuid) ON DELETE CASCADE,
  CONSTRAINT fk_salary_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP TRIGGER IF EXISTS `bi_salary_records_uuid`;
DELIMITER $$
CREATE TRIGGER `bi_salary_records_uuid`
BEFORE INSERT ON `salary_records`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END$$
DELIMITER ;
