-- IP-restricted attendance marking.
-- allowed_ip_addresses: JSON array of exact IPs, CIDR ranges (e.g. 192.168.1.0/24),
-- or IPv4 wildcards (e.g. 192.168.1.*) that may mark attendance from the office network.
ALTER TABLE organizations
  ADD COLUMN allowed_ip_addresses JSON NULL;

CREATE TABLE IF NOT EXISTS attendance_records (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  uuid             CHAR(36) NOT NULL,
  employee_uuid    CHAR(36) NOT NULL,
  organization_id  BIGINT UNSIGNED NOT NULL,
  check_in_at      DATETIME DEFAULT NULL,
  check_out_at     DATETIME DEFAULT NULL,
  check_in_ip      VARCHAR(45) DEFAULT NULL,
  check_out_ip     VARCHAR(45) DEFAULT NULL,
  date             DATE NOT NULL,
  status           ENUM('checked_in','checked_out') NOT NULL DEFAULT 'checked_in',
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_attendance_employee_date (employee_uuid, date),
  INDEX idx_attendance_org_date (organization_id, date),
  INDEX idx_attendance_employee (employee_uuid),
  CONSTRAINT fk_attendance_employee
    FOREIGN KEY (employee_uuid) REFERENCES employees (uuid) ON DELETE CASCADE,
  CONSTRAINT fk_attendance_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP TRIGGER IF EXISTS `bi_attendance_records_uuid`;
DELIMITER $$
CREATE TRIGGER `bi_attendance_records_uuid`
BEFORE INSERT ON `attendance_records`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END$$
DELIMITER ;