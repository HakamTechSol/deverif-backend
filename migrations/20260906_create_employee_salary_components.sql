-- employee_salary_components: per-employee, per-component allowance/deduction
-- ASSIGNMENTS. This is where each employee's ACTUAL, individual allowance and
-- deduction assignments live (one row per employee per component they're
-- given, with their own specific amount — which may differ from the
-- salary_components catalog's default_value).
--
-- salary_components remains a REUSABLE CATALOG of types (e.g. "Transport
-- Allowance", "Tax Deduction"); it is no longer "applied automatically to
-- every employee". Payroll generation now pulls only the rows here for each
-- employee's net-salary calculation.
CREATE TABLE IF NOT EXISTS employee_salary_components (
  id                    BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  uuid                  CHAR(36) NOT NULL,
  employee_uuid         CHAR(36) NOT NULL,
  salary_component_id   INT NOT NULL,
  amount                DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  is_active             TINYINT(1) NOT NULL DEFAULT 1,
  -- assigned_by: loose reference (users.id). No FK — lightweight audit pointer.
  assigned_by           BIGINT UNSIGNED NULL,
  assigned_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_esc_uuid (uuid),
  UNIQUE KEY uk_esc_employee_component (employee_uuid, salary_component_id),
  INDEX idx_esc_employee (employee_uuid),
  INDEX idx_esc_component (salary_component_id),
  CONSTRAINT fk_esc_employee
    FOREIGN KEY (employee_uuid) REFERENCES employees (uuid) ON DELETE CASCADE,
  CONSTRAINT fk_esc_component
    FOREIGN KEY (salary_component_id) REFERENCES salary_components (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP TRIGGER IF EXISTS `bi_employee_salary_components_uuid`;
DELIMITER $$
CREATE TRIGGER `bi_employee_salary_components_uuid`
BEFORE INSERT ON `employee_salary_components`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END$$
DELIMITER ;
