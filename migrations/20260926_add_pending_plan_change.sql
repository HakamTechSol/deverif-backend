-- 2026-09-26 -- organizations.pending_plan_change
--
-- A downgrade must NOT take effect immediately: the organization keeps the
-- features of the plan it already paid for until that period ends naturally.
-- The paid-for plan therefore stays in subscription_plan_id and the newly
-- bought lower-tier plan is parked in pending_plan_id until
-- organizations.subscription_expiry is reached (applied by the periodic
-- subscription lifecycle job in src/services/subscriptionLifecycle.service.js).
--
-- ON DELETE SET NULL mirrors fk_org_subscription_plan_id: if the pending plan
-- is ever removed the organization simply keeps its current plan instead of
-- being left with a dangling plan reference.
--
-- Non-destructive: ADD COLUMN only; existing rows default to NULL (no pending
-- change in flight).
ALTER TABLE `organizations`
  ADD COLUMN IF NOT EXISTS `pending_plan_id` BIGINT UNSIGNED DEFAULT NULL AFTER `subscription_plan_id`;

ALTER TABLE `organizations`
  ADD CONSTRAINT `fk_org_pending_plan`
  FOREIGN KEY (`pending_plan_id`) REFERENCES `subscription_plans`(`id`)
  ON DELETE SET NULL;
