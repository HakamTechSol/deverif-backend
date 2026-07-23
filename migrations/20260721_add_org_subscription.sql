ALTER TABLE `organizations`
  ADD COLUMN IF NOT EXISTS `subscription_status` ENUM('active','expired','none') DEFAULT 'none' AFTER `organization_type`,
  ADD COLUMN IF NOT EXISTS `subscription_start` datetime NULL AFTER `subscription_status`,
  ADD COLUMN IF NOT EXISTS `subscription_expiry` datetime NULL AFTER `subscription_start`,
  ADD COLUMN IF NOT EXISTS `subscription_plan` ENUM('monthly','yearly') NULL AFTER `subscription_expiry`;
