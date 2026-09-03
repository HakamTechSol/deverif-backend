-- SLA monitoring for under_review verification requests.
-- Only applies to requests where BOTH the submitting and receiving organizations
-- are registered (issuing_organization_id IS NOT NULL). "Other/unmatched org"
-- requests are handled by the separate Unmatched Orgs flow.

-- Business email for organizations (receiving orgs get SLA reminder emails here)
ALTER TABLE organizations
  ADD COLUMN business_email VARCHAR(190) NULL;

-- SLA tracking on verification requests
ALTER TABLE verification_requests
  ADD COLUMN sla_reminder_sent_at DATETIME NULL,
  ADD COLUMN sla_flagged_at DATETIME NULL,
  ADD INDEX idx_vr_sla (status, issuing_organization_id, created_at);