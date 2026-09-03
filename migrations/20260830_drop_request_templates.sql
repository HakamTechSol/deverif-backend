-- Remove the discontinued "Request Templates" feature entirely.
-- 1. Drop the reusable request template definitions table (and its trigger).
-- 2. Drop the template_data column added to verification_requests for this
--    feature (stored submitted template field values).

DROP TABLE IF EXISTS `request_templates`;

ALTER TABLE `verification_requests`
  DROP COLUMN `template_data`;
