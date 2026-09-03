-- employees: organization-internal HR records (cannot login)
-- Platform users trace back to an employee record via linked_user_uuid.
CREATE TABLE IF NOT EXISTS employees (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  uuid             CHAR(36) NOT NULL,
  organization_id  INT NOT NULL,
  full_name        VARCHAR(150) NOT NULL,
  email            VARCHAR(190) DEFAULT NULL,
  phone            VARCHAR(30) DEFAULT NULL,
  cnic             VARCHAR(20) NOT NULL,
  designation      VARCHAR(100) DEFAULT NULL,
  department       VARCHAR(100) DEFAULT NULL,
  status           ENUM('active','inactive') NOT NULL DEFAULT 'active',
  is_platform_user ENUM('yes','no') NOT NULL DEFAULT 'no',
  linked_user_uuid CHAR(36) DEFAULT NULL,
  added_by_uuid    CHAR(36) DEFAULT NULL,
  promoted_by_uuid CHAR(36) DEFAULT NULL,
  promoted_at      DATETIME DEFAULT NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_employees_uuid (uuid),
  INDEX idx_employees_org (organization_id),
  INDEX idx_employees_linked_user (linked_user_uuid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP TRIGGER IF EXISTS `bi_employees_uuid`;
DELIMITER $$
CREATE TRIGGER `bi_employees_uuid`
BEFORE INSERT ON `employees`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END$$
DELIMITER ;