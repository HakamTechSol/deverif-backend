-- 2026-09-27b -- backfill every organization onto the real Free plan
--
-- Goal: no organization is ever in a NULL / 'none' limbo. Every org points at
-- a real subscription_plans row; Free is just the default, and it has no
-- billing cycle, so a Free org is subscription_status='active' with
-- subscription_expiry = NULL (NULL means "indefinite" for Free, NOT "expired").
--
-- Scope is deliberately narrow: only organizations currently in limbo are
-- touched. An org already holding a real paid plan with a live subscription
-- keeps everything -- the WHERE clause below never matches it.
--
-- The two selection rules:
--   * subscription_plan_id IS NULL  -> no plan at all, must be given Free
--   * subscription_status IN ('none','expired')
--     -> no live subscription, so the org moves to Free. This deliberately
--        INCLUDES an org that is already on Free but carries a stale 'expired'
--        flag: the plan is already right, the status is not, and normalising it
--        to 'active' is the point of this migration.
--
-- An org with a pending_plan_id is skipped: a deliberate downgrade is already
-- scheduled there and the lifecycle job will resolve it, so moving it to Free
-- now would silently cancel that intent.
--
-- subscription_start is backfilled from created_at so the org has a coherent
-- "customer since" date instead of NULL.

UPDATE `organizations` o
JOIN (
  SELECT `id` FROM `subscription_plans` WHERE `is_free` = 1 ORDER BY `id` ASC LIMIT 1
) fp
SET o.`subscription_plan_id` = fp.`id`,
    o.`subscription_status`  = 'active',
    o.`subscription_start`   = COALESCE(o.`subscription_start`, o.`created_at`),
    o.`subscription_expiry`  = NULL,
    o.`pending_plan_id`       = NULL
WHERE o.`deleted_at` IS NULL
  AND (o.`subscription_plan_id` IS NULL OR o.`subscription_status` IN ('none', 'expired'))
  AND o.`pending_plan_id` IS NULL;
