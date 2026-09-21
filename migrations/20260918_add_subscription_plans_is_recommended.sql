-- 2026-09-18 — subscription_plans.is_recommended
--
-- Admin marks a plan "Recommended" so the marketing /pricing page can highlight
-- it (e.g. "Recommended" badge). Purely presentational; any number of plans can
-- be recommended.
--
-- Non-destructive: ADD COLUMN only; existing rows default to 0 (not recommended).
ALTER TABLE `subscription_plans`
  ADD COLUMN IF NOT EXISTS `is_recommended` TINYINT(1) NOT NULL DEFAULT 0 AFTER `is_free`;