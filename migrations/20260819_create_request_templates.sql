-- Reusable verification request templates, defined per organization.
CREATE TABLE IF NOT EXISTS request_templates (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  uuid            CHAR(36) NOT NULL,
  organization_id BIGINT UNSIGNED NOT NULL,
  template_name   VARCHAR(150) NOT NULL,
  document_type   VARCHAR(200) NOT NULL,
  fields          JSON NOT NULL,
  created_by      CHAR(36) DEFAULT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_request_templates_uuid (uuid),
  INDEX idx_request_templates_org (organization_id),
  CONSTRAINT fk_request_templates_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP TRIGGER IF EXISTS `bi_request_templates_uuid`;
DELIMITER $$
CREATE TRIGGER `bi_request_templates_uuid`
BEFORE INSERT ON `request_templates`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END$$
DELIMITER ;

-- Store submitted template field values on verification requests.
ALTER TABLE verification_requests
  ADD COLUMN template_data JSON NULL AFTER submission_remarks;