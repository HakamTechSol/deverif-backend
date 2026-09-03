-- E2E walkthrough fix (2026-08-21)
-- verification_requests.verified_by stores a user id when an organization
-- verifies, but an ADMIN id when the platform admin acts on an SLA-breached
-- request (verification_method='admin_sla'). Admin ids live in
-- admin_profiles, not users, so the hard FK made every admin SLA action
-- fail with ER_NO_REFERENCED_ROW_2 (500). Polymorphic column -> plain index.
ALTER TABLE verification_requests DROP FOREIGN KEY fk_vr_verified_by;
ALTER TABLE verification_requests
  DROP INDEX fk_vr_verified_by,
  ADD INDEX idx_vr_verified_by (verified_by);
