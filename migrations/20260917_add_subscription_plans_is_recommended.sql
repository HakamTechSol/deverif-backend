-- 2026-09-17 — subscription_plans.is_recommended
--
-- Marks the single "Recommended" plan highlighted on the public pricing page.
-- Exposed via /api/v1/marketing/plans for the marketing site.
--
-- Non-destructive: ADD COLUMN only; existing rows default to 0 (not recommended).
ALTER TABLE `subscription_plans`
  ADD COLUMN IF NOT EXISTS `is_recommended` TINYINT(1) NOT NULL DEFAULT 0 AFTER `is_free`;