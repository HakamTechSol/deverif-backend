-- Tracks which verified organization an unmatched org's requests were
-- routed to when the system admin assigns them (status becomes `converted`).

ALTER TABLE `unmatched_organizations`
  ADD COLUMN IF NOT EXISTS `assigned_organization_id` bigint(20) UNSIGNED DEFAULT NULL AFTER `status`;

ALTER TABLE `unmatched_organizations`
  ADD KEY IF NOT EXISTS `idx_unmatched_orgs_assigned_org` (`assigned_organization_id`);

ALTER TABLE `unmatched_organizations`
  ADD CONSTRAINT `fk_unmatched_orgs_assigned_org`
  FOREIGN KEY (`assigned_organization_id`) REFERENCES `organizations`(`id`) ON DELETE SET NULL;