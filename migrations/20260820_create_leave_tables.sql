-- Leave management: types per organization, requests, and annual balances.

-- Leave types defined by the org (or platform admin) for a specific organization.
CREATE TABLE IF NOT EXISTS leave_types (
  id                   BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  organization_id      BIGINT UNSIGNED NOT NULL,
  name                 VARCHAR(100) NOT NULL,
  days_allowed_per_year INT NOT NULL DEFAULT 0,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_leave_types_org_name (organization_id, name),
  INDEX idx_leave_types_org (organization_id),
  CONSTRAINT fk_leave_types_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Leave requests submitted by platform users (employees).
CREATE TABLE IF NOT EXISTS leave_requests (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  uuid           CHAR(36) NOT NULL,
  employee_uuid  CHAR(36) NOT NULL,
  leave_type_id  BIGINT UNSIGNED NOT NULL,
  start_date     DATE NOT NULL,
  end_date       DATE NOT NULL,
  reason         VARCHAR(1000) DEFAULT NULL,
  status         ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  approved_by    CHAR(36) DEFAULT NULL,
  approved_at    DATETIME DEFAULT NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_leave_requests_uuid (uuid),
  INDEX idx_leave_requests_employee (employee_uuid),
  INDEX idx_leave_requests_status (status),
  INDEX idx_leave_requests_type (leave_type_id),
  CONSTRAINT fk_leave_requests_employee
    FOREIGN KEY (employee_uuid) REFERENCES employees (uuid) ON DELETE CASCADE,
  CONSTRAINT fk_leave_requests_type
    FOREIGN KEY (leave_type_id) REFERENCES leave_types (id) ON DELETE RESTRICT,
  CONSTRAINT fk_leave_requests_approved_by
    FOREIGN KEY (approved_by) REFERENCES users (uuid) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP TRIGGER IF EXISTS `bi_leave_requests_uuid`;
DELIMITER $$
CREATE TRIGGER `bi_leave_requests_uuid`
BEFORE INSERT ON `leave_requests`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END$$
DELIMITER ;

-- Annual leave balances (allocated = days_allowed_per_year at allocation time).
CREATE TABLE IF NOT EXISTS leave_balances (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  employee_uuid  CHAR(36) NOT NULL,
  leave_type_id  BIGINT UNSIGNED NOT NULL,
  year           INT NOT NULL,
  total_allocated INT NOT NULL DEFAULT 0,
  used           INT NOT NULL DEFAULT 0,
  remaining      INT NOT NULL DEFAULT 0,
  UNIQUE KEY uk_leave_balances (employee_uuid, leave_type_id, year),
  CONSTRAINT fk_leave_balances_employee
    FOREIGN KEY (employee_uuid) REFERENCES employees (uuid) ON DELETE CASCADE,
  CONSTRAINT fk_leave_balances_type
    FOREIGN KEY (leave_type_id) REFERENCES leave_types (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;