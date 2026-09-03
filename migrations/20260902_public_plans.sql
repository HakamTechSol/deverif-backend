-- Public, admin-managed subscription plans shown on the marketing site.
-- Adds marketing-facing fields (description, features, billing_period) and a
-- visibility toggle (is_public). Admin-created plans (is_custom=0) can be made
-- public; custom-assigned plans (is_custom=1) stay hidden from marketing.

-- 1) subscription_plans: marketing/display columns ---------------------------
ALTER TABLE `subscription_plans`
  ADD COLUMN IF NOT EXISTS `description` text NULL AFTER `daily_request_quota`,
  ADD COLUMN IF NOT EXISTS `features` longtext NULL AFTER `description`,
  ADD COLUMN IF NOT EXISTS `billing_period` enum('monthly','yearly') NOT NULL DEFAULT 'monthly' AFTER `features`,
  ADD COLUMN IF NOT EXISTS `is_public` tinyint(1) NOT NULL DEFAULT 0 AFTER `billing_period`;

-- Mark the original seeded plan rows (and any admin-created, non-custom plans)
-- as public so they appear on marketing. Custom plans stay hidden.
UPDATE `subscription_plans` SET `is_public` = 1 WHERE `is_custom` = 0;
