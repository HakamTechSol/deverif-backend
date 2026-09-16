-- 2026-09-13 Phase 1 — safe cleanups (verified against backend code).
--
-- 1. verification_requests.priority
--    Dead column: no backend/frontend/test code reads or writes it (the only
--    `priority` usage in the codebase belongs to support_tickets.priority).
--    All 13 existing rows hold the default 'normal'. Drop it.
--
-- 2. organizations.subscription_plan
--    Dead/misused column. Historically written with plan NAMES (e.g. "Plan A"),
--    which the ENUM('monthly','yearly') definition silently coerced to '' —
--    the real billing period lives in subscription_plans.billing_period and the
--    real plan identity lives in subscription_plans.name via the existing
--    subscription_plan_id FK. All read/write paths in backend + frontend were
--    removed/redirected in this same change. Drop it.
--
-- 3. organizations.subscription_plan_id -> subscription_plans.id FK
--    Orphan check ran before this migration: every non-NULL subscription_plan_id
--    resolves to a subscription_plans row (0 orphans), so the FK is safe to add.
--    ON DELETE SET NULL keeps an organization intact if its plan is ever deleted.

-- 1. Add the missing FK (add-then-verify-then-drop: no orphans found).
ALTER TABLE `organizations`
  ADD CONSTRAINT `fk_org_subscription_plan_id`
  FOREIGN KEY (`subscription_plan_id`) REFERENCES `subscription_plans`(`id`)
  ON DELETE SET NULL;

-- 2. Drop dead columns (code was updated in the same pass).
ALTER TABLE `verification_requests` DROP COLUMN `priority`;
ALTER TABLE `organizations` DROP COLUMN `subscription_plan`;