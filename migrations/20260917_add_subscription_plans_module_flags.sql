-- 2026-09-17 — subscription_plans.module_flags
--
-- New column controlling which HR modules a plan grants access to. It defaults
-- EVERY module to true so existing live organizations on existing plans are NOT
-- suddenly locked out of anything after this migration. The Platform Admin can
-- tighten module_flags per plan (Free / Basic / Premium) afterwards.
--
-- Non-destructive: ADD COLUMN only; existing rows receive the full-true default.
ALTER TABLE `subscription_plans`
  ADD COLUMN IF NOT EXISTS `module_flags` JSON NOT NULL DEFAULT
  '{"employee_management":true,"attendance_management":true,"user_management":true,"leave_management":true,"payroll_management":true}';