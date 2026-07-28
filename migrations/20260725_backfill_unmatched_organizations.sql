-- Backfills unmatched_organizations from existing verification_requests rows
-- where other_organization_name is not null, deduplicating by name.

-- Step 1: Insert unique orgs (combine data from multiple requests — take the most recent values)
INSERT IGNORE INTO `unmatched_organizations` (`name`, `email`, `phone`, `website`, `created_at`)
SELECT
  vr.`other_organization_name`,
  MAX(vr.`other_organization_email`),
  MAX(vr.`other_organization_phone`),
  MAX(vr.`other_organization_website`),
  MIN(vr.`created_at`)
FROM `verification_requests` vr
WHERE vr.`other_organization_name` IS NOT NULL
  AND vr.`other_organization_name` != ''
GROUP BY vr.`other_organization_name`;

-- Step 2: Backfill unmatched_org_id on verification_requests
UPDATE `verification_requests` vr
INNER JOIN `unmatched_organizations` uo ON uo.`name` = vr.`other_organization_name`
SET vr.`unmatched_org_id` = uo.`id`
WHERE vr.`other_organization_name` IS NOT NULL
  AND vr.`unmatched_org_id` IS NULL;
