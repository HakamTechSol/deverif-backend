-- salary_components: org-admin defined, reusable allowance/deduction types.
-- Applied automatically to every employee when payroll is generated for a month
-- (fixed amount or percentage of the employee's effective basic salary).
CREATE TABLE IF NOT EXISTS salary_components (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  uuid            CHAR(36) NOT NULL,
  organization_id BIGINT UNSIGNED NOT NULL,
  name            VARCHAR(150) NOT NULL,
  type            ENUM('allowance','deduction') NOT NULL,
  is_percentage   TINYINT(1) NOT NULL DEFAULT 0,
  default_value   DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  -- created_by: loose reference (users.id). No FK — lightweight audit pointer.
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