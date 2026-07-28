-- Drops the 4 legacy "other organization" columns from verification_requests.
-- All data has been migrated to unmatched_organizations via 20260725_backfill_unmatched_organizations.sql.
-- The backend no longer writes to these columns.

ALTER TABLE `verification_requests`
  DROP COLUMN IF EXISTS `other_organization_name`,
  DROP COLUMN IF EXISTS `other_organization_email`,
  DROP COLUMN IF EXISTS `other_organization_phone`,
  DROP COLUMN IF EXISTS `other_organization_website`;
