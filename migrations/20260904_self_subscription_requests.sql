-- Org-Admin self-subscription flow (manual payment, no gateway yet).
-- 1. Extend the organization subscription lifecycle to support a pending
--    "awaiting payment confirmation" state.
ALTER TABLE `organizations`
  MODIFY COLUMN `subscription_status`
  ENUM('active','expired','none','pending_payment') NOT NULL DEFAULT 'none';

-- 2. Track each org-admin's stated intent to subscribe to a Public plan.
--    The System Admin confirms (or cancels) this request after receiving the
--    payment outside the platform; confirmation activates the subscription.
CREATE TABLE IF NOT EXISTS `self_subscription_requests` (
  `id`                INT AUTO_INCREMENT PRIMARY KEY,
  `uuid`              CHAR(36) NOT NULL,
  `organization_id`   INT NOT NULL,
  `plan_uuid`         CHAR(36) NOT NULL,
  `requested_by_uuid` CHAR(36) NOT NULL,
  `amount`            DECIMAL(12,2) NULL,
  `status`            ENUM('pending','confirmed','cancelled') NOT NULL DEFAULT 'pending',
  `created_at`        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `decided_at`        DATETIME NULL,
  `decided_by`        CHAR(36) NULL,
  UNIQUE KEY `uk_ssr_uuid` (`uuid`),
  INDEX `idx_ssr_org` (`organization_id`),
  INDEX `idx_ssr_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP TRIGGER IF EXISTS `bi_self_subscription_requests_uuid`;
DELIMITER $$
CREATE TRIGGER `bi_self_subscription_requests_uuid`
BEFORE INSERT ON `self_subscription_requests`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END$$
DELIMITER ;
