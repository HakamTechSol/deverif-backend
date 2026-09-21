-- 2026-09-17 — subscription_plans.is_free
--
-- Marks the single "Free plan". Newly created organizations are automatically
-- subscribed to it (subscription_status='active', subscription_plan_id set) so
-- their users get the baseline experience without manual admin setup.
--
-- Non-destructive: ADD COLUMN only; existing rows default to 0 (not free).
ALTER TABLE `subscription_plans`
  ADD COLUMN IF NOT EXISTS `is_free` TINYINT(1) NOT NULL DEFAULT 0 AFTER `is_custom`;