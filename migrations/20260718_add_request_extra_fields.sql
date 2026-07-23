-- Adds other_organization_name and submission_remarks columns
-- to verification_requests, required for the "Other" org and notes features.

ALTER TABLE `verification_requests`
  ADD COLUMN `other_organization_name` varchar(200) DEFAULT NULL AFTER `organization_conserned_for_future`,
  ADD COLUMN `submission_remarks`     varchar(500) DEFAULT NULL AFTER `other_organization_name`;
