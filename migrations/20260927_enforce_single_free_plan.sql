-- 2026-09-27 -- enforce "exactly one Free plan" at the database level
--
-- Every organization is always on a real subscription_plans row; Free is just
-- the default one, flagged with is_free=1. That makes "at most one row may have
-- is_free=1" a hard invariant, because two Free plans would make "the Free
-- plan" ambiguous for every caller that looks it up dynamically.
--
-- WHY A GENERATED COLUMN AND NOT A PARTIAL/FILTERED UNIQUE INDEX
-- -----------------------------------------------------------
-- Neither MySQL nor MariaDB supports filtered ("partial") unique indexes --
-- `CREATE UNIQUE INDEX ... WHERE is_free = 1` is not valid on either engine, so
-- that approach is unavailable regardless of version.
--
-- Both engines DO support indexed VIRTUAL (generated) columns, which gives the
-- same guarantee portably: a generated column that is 1 for the Free plan and
-- NULL for every other row, plus a UNIQUE index over it. Many NULLs are allowed
-- in a unique index while a second 1 is rejected, which is exactly the "at most
-- one Free plan" rule. Verified working on this server (MariaDB 10.4.32):
-- a second is_free=1 row fails with ER_DUP_ENTRY while extra is_free=0 rows
-- insert fine.
--
-- The application also guards this in the admin plans controller
-- (utils/subscriptionPlans.js: assertSingleFreePlan) so admins get a readable
-- 400 instead of a raw ER_DUP_ENTRY. Both layers are intentional.

-- 1. Repair first, so the unique index below can be created.
--    If more than one row is flagged is_free=1 -- only reachable via direct DB
--    edits, since the admin API already rejects it -- keep the row that is
--    actually in use (the plan most organizations point at) and clear the flag
--    on the rest. Ties break towards the lowest id, i.e. the original seeded
--    Free plan. This is a no-op on a healthy table.
DROP TEMPORARY TABLE IF EXISTS `_free_plan_winner`;
CREATE TEMPORARY TABLE `_free_plan_winner` AS
SELECT sp.`id`
FROM `subscription_plans` sp
WHERE sp.`is_free` = 1
ORDER BY (SELECT COUNT(*) FROM `organizations` o WHERE o.`subscription_plan_id` = sp.`id`) DESC, sp.`id` ASC
LIMIT 1;

UPDATE `subscription_plans`
SET `is_free` = 0
WHERE `is_free` = 1
  AND `id` <> (SELECT `id` FROM `_free_plan_winner`);

DROP TEMPORARY TABLE `_free_plan_winner`;

-- 2. Enforce the invariant going forward.
ALTER TABLE `subscription_plans`
  ADD COLUMN IF NOT EXISTS `free_plan_guard`
    TINYINT UNSIGNED AS (IF(`is_free` = 1, 1, NULL)) VIRTUAL;

-- MariaDB 10.4 has no `ADD UNIQUE KEY IF NOT EXISTS`, so guard the index
-- creation through information_schema to keep the script re-runnable.
SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'subscription_plans'
    AND INDEX_NAME   = 'uq_subscription_plans_single_free'
);
SET @idx_sql := IF(
  @idx_exists > 0,
  'DO 0',
  'ALTER TABLE `subscription_plans` ADD UNIQUE KEY `uq_subscription_plans_single_free` (`free_plan_guard`)'
);
PREPARE stmt FROM @idx_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
