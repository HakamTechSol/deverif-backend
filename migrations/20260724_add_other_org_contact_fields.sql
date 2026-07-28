-- Adds contact info columns for "Other" (unmatched) organization submissions.

ALTER TABLE `verification_requests`
  ADD COLUMN `other_organization_email`   varchar(190) DEFAULT NULL AFTER `other_organization_name`,
  ADD COLUMN `other_organization_phone`   varchar(30)  DEFAULT NULL AFTER `other_organization_email`,
  ADD COLUMN `other_organization_website` varchar(500) DEFAULT NULL AFTER `other_organization_phone`;
