-- Give the Free plan portal accounts (User Management).
--
-- Free already includes Employee Management, but employee invitations are
-- gated separately by `user_management`: POST /org/employees rejects a
-- send_invite=true payload without it, and the Add Employee form disables the
-- "Portal access / send invitation" checkbox. That left a Free org able to add
-- roster-only employees but unable to give any of them a login, which is the
-- "Upgrade your plan to access User Management" report.
--
-- Merge rather than replace so every other flag the plan already has survives,
-- and skip NULL flags: NULL means a legacy unrestricted plan, and turning that
-- into a one-key object would lock every other module.
UPDATE subscription_plans
SET module_flags = JSON_MERGE_PATCH(module_flags, '{"user_management": true}')
WHERE is_free = 1
  AND module_flags IS NOT NULL;
