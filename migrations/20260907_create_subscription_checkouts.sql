-- Org-Admin self-service subscription checkouts (Safepay hosted checkout).
-- Tracks each checkout session from creation through webhook-driven completion.
CREATE TABLE IF NOT EXISTS `subscription_checkouts` (
  `id`                  INT AUTO_INCREMENT PRIMARY KEY,
  `uuid`                CHAR(36) NOT NULL,
  `organization_id`     INT NOT NULL,
  `plan_id`             INT NOT NULL,
  `plan_uuid`           CHAR(36) NOT NULL,
  `plan_name`           VARCHAR(255) NOT NULL,
  `gateway`             ENUM('safepay') NOT NULL DEFAULT 'safepay',
  `gateway_tracker_id`  VARCHAR(255) NULL,
  `gateway_event_id`    VARCHAR(255) NULL,
  `amount`              DECIMAL(12,2) NOT NULL,
  `currency`            CHAR(3) NOT NULL DEFAULT 'PKR',
  `status`              ENUM('pending','completed','failed','cancelled','expired') NOT NULL DEFAULT 'pending',
  `metadata`            JSON NULL,
  `created_at`          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `completed_at`        DATETIME NULL,
  `failed_at`           DATETIME NULL,
  UNIQUE KEY `uk_sco_uuid` (`uuid`),
  UNIQUE KEY `uk_sco_gateway_tracker_id` (`gateway_tracker_id`),
  INDEX `idx_sco_org_status` (`organization_id`, `status`),
  INDEX `idx_sco_plan_id` (`plan_id`),
  INDEX `idx_sco_gateway_event_id` (`gateway_event_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP TRIGGER IF EXISTS `bi_subscription_checkouts_uuid`;
DELIMITER $$
CREATE TRIGGER `bi_subscription_checkouts_uuid`
BEFORE INSERT ON `subscription_checkouts`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END$$
DELIMITER ;