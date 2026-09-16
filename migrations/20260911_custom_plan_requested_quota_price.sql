-- Add structured request fields to custom_plan_requests so orgs submit a
-- requested daily quota and expected budget instead of only free text.

ALTER TABLE `custom_plan_requests`
  ADD COLUMN IF NOT EXISTS `requested_quota` int(11) NULL AFTER `message`,
  ADD COLUMN IF NOT EXISTS `requested_price` decimal(12,2) NULL AFTER `requested_quota`;