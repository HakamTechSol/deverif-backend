-- 2026-11-01 — Backfill the 13 new HR module keys into every existing plan
--
-- WHY THIS MIGRATION IS MANDATORY (not cosmetic):
--
--   utils/moduleFlags.js `isModuleIncluded()` decides access with
--       if (flags == null) return true;      // legacy plan, nothing locked
--       return flags[moduleKey] === true;     // ANY other shape is BLOCKED
--
--   A key that is merely ABSENT from the JSON reads as `undefined`, and
--   `undefined !== true`, so it evaluates to BLOCKED. Every plan row created
--   before this migration stores only the original five keys, so simply adding
--   the new keys to MODULE_FEATURE_KEYS would have silently locked all 13 new
--   modules on EVERY organization in production — including paying customers —
--   with no error anywhere, because the middleware is behaving exactly as
--   documented.
--
-- POLICY: every new module ships defaulting to TRUE.
--
--   This mirrors the stated intent of 20260917_add_subscription_plans_module_flags.sql,
--   which set its own DEFAULT to all-true specifically so that "existing live
--   organizations are NOT suddenly locked out of anything after this migration".
--   Defaulting new modules OFF would be a billing decision that can be applied
--   later, per plan, from the admin plan editor. Defaulting them OFF here would
--   take that decision away from the admin and impose it on live orgs instead.
--
-- The `WHERE module_flags IS NOT NULL` clause is deliberate:
--
--   parseModuleFlags(null) returns `null`, which isModuleIncluded() treats as
--   UNRESTRICTED. A NULL row is therefore the one shape that must be left
--   alone — rewriting it to `{}` would be the opposite of safe, since `{}`
--   blocks every module.
--
-- Non-destructive: UPDATE + a DEFAULT change only. No rows are dropped, and any
-- module an admin had already turned off (an explicit `false`) is preserved,
-- because JSON_SET only writes the thirteen listed paths.
--
-- VERIFY BEFORE/AFTER (run read-only first if you like):
--
--   -- Plans that DO have flags but are missing at least one new key.
--   -- This is the row count the UPDATE should fix; expect 0 afterwards.
--   SELECT COUNT(*) AS plans_needing_backfill
--     FROM subscription_plans
--    WHERE module_flags IS NOT NULL
--      AND NOT JSON_CONTAINS_PATH(
--            module_flags, 'all',
--            '$.manpower_management', '$.recruitment_management',
--            '$.onboarding_management', '$.separation_management',
--            '$.training_management', '$.performance_management',
--            '$.piece_work_management', '$.expense_management',
--            '$.travel_management', '$.asset_management',
--            '$.helpdesk_management', '$.scheduled_reports',
--            '$.hr_letters_management'
--          );
--
--   -- Legacy plans deliberately left untouched (should stay as-is).
--   SELECT COUNT(*) AS legacy_null_plans
--     FROM subscription_plans WHERE module_flags IS NULL;
--
-- Apply with:
--   RUN_ONLY=20261101_hr_modules_backfill_module_flags.sql node migrations/run.mjs
-- (migrations/run.mjs absorbs an existing file into its "already applied"
-- baseline on a pre-existing database unless it is named in RUN_ONLY.)

-- 1. Grant the thirteen new modules to every plan that carries explicit flags.
UPDATE `subscription_plans`
   SET `module_flags` = JSON_SET(
         COALESCE(`module_flags`, JSON_OBJECT()),
         '$.manpower_management',      TRUE,
         '$.recruitment_management',   TRUE,
         '$.onboarding_management',    TRUE,
         '$.separation_management',    TRUE,
         '$.training_management',      TRUE,
         '$.performance_management',   TRUE,
         '$.piece_work_management',    TRUE,
         '$.expense_management',       TRUE,
         '$.travel_management',        TRUE,
         '$.asset_management',         TRUE,
         '$.helpdesk_management',      TRUE,
         '$.scheduled_reports',        TRUE,
         '$.hr_letters_management',    TRUE
       )
 WHERE `module_flags` IS NOT NULL;

-- 2. Extend the column DEFAULT so plans created from here on (and any future
--    INSERT that omits the column) carry all eighteen keys. Key order matches
--    MODULE_FEATURE_KEYS exactly. This also replaces the five-key default set
--    by 20260917.
ALTER TABLE `subscription_plans`
  MODIFY COLUMN `module_flags` JSON NOT NULL DEFAULT
'{"employee_management":true,"attendance_management":true,"user_management":true,"leave_management":true,"payroll_management":true,"manpower_management":true,"recruitment_management":true,"onboarding_management":true,"separation_management":true,"training_management":true,"performance_management":true,"piece_work_management":true,"expense_management":true,"travel_management":true,"asset_management":true,"helpdesk_management":true,"scheduled_reports":true,"hr_letters_management":true}';