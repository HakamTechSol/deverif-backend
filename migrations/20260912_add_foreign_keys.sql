-- 2026-09-12: enforce referential integrity with proper foreign keys.
--
-- Safe FKs (matching types, existing values resolve):
--   custom_plan_requests.organization_id            -> organizations.id
--   daily_request_usage.organization_id             -> organizations.id
--   support_tickets.organization_id                 -> organizations.id   (already bigint unsigned)
--   support_tickets.raised_by_uuid                  -> users.uuid
--   support_ticket_replies.replied_by_uuid          -> users.uuid
--   support_ticket_replies.ticket_uuid              -> support_tickets.uuid
--   notifications.user_uuid                         -> users.uuid
--   password_reset_tokens.user_uuid                 -> users.uuid
--   employees.added_by_uuid / linked_user_uuid / promoted_by_uuid -> users.uuid
--
-- FKs requiring a column type fix (int -> bigint unsigned to match organizations.id):
--   employees.organization_id
--   self_subscription_requests.organization_id
--   subscription_checkouts.organization_id
--   invite_tokens.user_uuid                          -> users.uuid (char already matches; 1 orphan cleaned)
--
-- Deliberately NOT FK'd (polymorphic / user-or-admin targets):
--   audit_logs.actor_id, login_history.identity_id, login_otps.identity_id,
--   verification_requests.locked_by, verification_requests.verified_by

-- 1. Normalize int-typed organization_id columns to bigint unsigned to match organizations.id
ALTER TABLE employees MODIFY organization_id BIGINT UNSIGNED NOT NULL;
ALTER TABLE self_subscription_requests MODIFY organization_id BIGINT UNSIGNED NOT NULL;
ALTER TABLE subscription_checkouts MODIFY organization_id BIGINT UNSIGNED NOT NULL;

-- 2. Clean up orphaned invite_tokens rows so the FK can be added
DELETE FROM invite_tokens
WHERE user_uuid IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM users WHERE users.uuid = invite_tokens.user_uuid);

-- 3. Add the foreign keys
ALTER TABLE custom_plan_requests
  ADD INDEX fk_cpr_org_idx (organization_id),
  ADD CONSTRAINT fk_cpr_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT;

ALTER TABLE daily_request_usage
  ADD INDEX fk_dru_org_idx (organization_id),
  ADD CONSTRAINT fk_dru_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT;

ALTER TABLE employees
  ADD INDEX fk_emp_org_idx (organization_id),
  ADD INDEX fk_emp_added_by_idx (added_by_uuid),
  ADD INDEX fk_emp_linked_user_idx (linked_user_uuid),
  ADD INDEX fk_emp_promoted_by_idx (promoted_by_uuid),
  ADD CONSTRAINT fk_emp_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_emp_added_by FOREIGN KEY (added_by_uuid) REFERENCES users(uuid) ON DELETE SET NULL,
  ADD CONSTRAINT fk_emp_linked_user FOREIGN KEY (linked_user_uuid) REFERENCES users(uuid) ON DELETE SET NULL,
  ADD CONSTRAINT fk_emp_promoted_by FOREIGN KEY (promoted_by_uuid) REFERENCES users(uuid) ON DELETE SET NULL;

ALTER TABLE invite_tokens
  ADD INDEX fk_it_user_idx (user_uuid),
  ADD CONSTRAINT fk_it_user FOREIGN KEY (user_uuid) REFERENCES users(uuid) ON DELETE RESTRICT;

ALTER TABLE notifications
  ADD INDEX fk_notif_user_idx (user_uuid),
  ADD CONSTRAINT fk_notif_user FOREIGN KEY (user_uuid) REFERENCES users(uuid) ON DELETE CASCADE;

ALTER TABLE password_reset_tokens
  ADD INDEX fk_prt_user_idx (user_uuid),
  ADD CONSTRAINT fk_prt_user FOREIGN KEY (user_uuid) REFERENCES users(uuid) ON DELETE CASCADE;

ALTER TABLE self_subscription_requests
  ADD INDEX fk_ssr_org_idx (organization_id),
  ADD CONSTRAINT fk_ssr_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT;

ALTER TABLE subscription_checkouts
  ADD INDEX fk_sco_org_idx (organization_id),
  ADD CONSTRAINT fk_sco_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT;

ALTER TABLE support_tickets
  ADD INDEX fk_st_org_idx (organization_id),
  ADD INDEX fk_st_raised_by_idx (raised_by_uuid),
  ADD CONSTRAINT fk_st_org FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_st_raised_by FOREIGN KEY (raised_by_uuid) REFERENCES users(uuid) ON DELETE RESTRICT;

ALTER TABLE support_ticket_replies
  ADD INDEX fk_str_replied_by_idx (replied_by_uuid),
  ADD INDEX fk_str_ticket_idx (ticket_uuid),
  ADD CONSTRAINT fk_str_replied_by FOREIGN KEY (replied_by_uuid) REFERENCES users(uuid) ON DELETE CASCADE,
  ADD CONSTRAINT fk_str_ticket FOREIGN KEY (ticket_uuid) REFERENCES support_tickets(uuid) ON DELETE CASCADE;