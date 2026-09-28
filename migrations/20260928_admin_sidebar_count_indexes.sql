-- Status counts power the system-admin sidebar and need index-only scans.
ALTER TABLE `contact_leads` ADD INDEX `idx_contact_leads_status` (`status`);
ALTER TABLE `access_requests` ADD INDEX `idx_access_requests_status` (`status`);

-- Existing indexes cover support_tickets.status,
-- custom_plan_requests.status, unmatched_organizations.status, and
-- verification_requests.unmatched_org_id.
