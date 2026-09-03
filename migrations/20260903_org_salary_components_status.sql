-- Org salary components + employee salary history were recorded in
-- schema_migrations during a hand-built-DB backfill but never actually created
-- in the database. This migration materialises them (IF NOT EXISTS is safe and
-- idempotent), and adds the new is_active status column that lets org-admins
-- deactivate a component so it stops being auto-applied to FUTURE payroll runs
-- while leaving already-generated payroll records untouched.
CREATE TABLE IF NOT EXISTS salary_components (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  uuid            CHAR(36) NOT NULL,
  organization_id BIGINT UNSIGNED NOT NULL,
  name            VARCHAR(150) NOT NULL,
  type            ENUM('allowance','deduction') NOT NULL,
  is_percentage   TINYINT(1) NOT NULL DEFAULT 0,
  default_value   DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  -- created_by: loose reference (users.id). No FK -- lightweight audit pointer.
  created_by      BIGINT UNSIGNED NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_salary_components_uuid (uuid),
  UNIQUE KEY uk_salary_components_org_name_type (organization_id, name, type),
  INDEX idx_salary_components_org (organization_id),
  CONSTRAINT fk_salary_components_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP TRIGGER IF EXISTS `bi_salary_components_uuid`;
DELIMITER $$
CREATE TRIGGER `bi_salary_components_uuid`
BEFORE INSERT ON `salary_components`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END$$
DELIMITER ;

CREATE TABLE IF NOT EXISTS employee_salary_history (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  uuid            CHAR(36) NOT NULL,
  employee_uuid   CHAR(36) NOT NULL,
  year            SMALLINT UNSIGNED NOT NULL,
  basic_salary    DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  effective_from  DATE NOT NULL,
  effective_to    DATE NULL,
  -- created_by: loose reference (users.id). No FK -- lightweight audit pointer.
  created_by      BIGINT UNSIGNED NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_esh_uuid (uuid),
  INDEX idx_esh_employee (employee_uuid),
  INDEX idx_esh_active (employee_uuid, effective_from, effective_to),
  CONSTRAINT fk_esh_employee
    FOREIGN KEY (employee_uuid) REFERENCES employees (uuid) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP TRIGGER IF EXISTS `bi_employee_salary_history_uuid`;
DELIMITER $$
CREATE TRIGGER `bi_employee_salary_history_uuid`
BEFORE INSERT ON `employee_salary_history`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END$$
DELIMITER ;

-- Backfill: seed the first (active) history row for existing employees using
-- their most recent salary_record basic_salary when available, else 0.00.
-- Idempotent -- rows are only created for employees with no history yet.
INSERT IGNORE INTO employee_salary_history
  (uuid, employee_uuid, year, basic_salary, effective_from, effective_to, created_by, created_at)
SELECT UUID(), e.uuid,
       YEAR(COALESCE(e.joining_date, DATE(e.created_at))),
       COALESCE(sr.basic_salary, 0.00),
       COALESCE(e.joining_date, DATE(e.created_at)),
       NULL, NULL, NOW()
FROM employees e
LEFT JOIN (
  SELECT s.employee_uuid, s.basic_salary
  FROM salary_records s
  INNER JOIN (
    SELECT employee_uuid, MAX(year * 100 + month) AS ym
    FROM salary_records
    GROUP BY employee_uuid
  ) m ON m.employee_uuid = s.employee_uuid AND (s.year * 100 + s.month) = m.ym
) sr ON sr.employee_uuid = e.uuid;
