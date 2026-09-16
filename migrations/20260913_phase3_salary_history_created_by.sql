-- 2026-09-13 Phase 3.6 — employee_salary_history.created_by: fix the -1 bug + FK.
--
-- Root cause (verified in code): the initial salary row created inside
-- createEmployee (admin/employees.controller.js) passed the ACTOR'S UUID
-- (char 36) into the numeric created_by column — MySQL coerced it to garbage,
-- and an external/seed write for the same column produced 18446744073709551615
-- (-1 cast to unsigned BIGINT). The only other writer is the org "Increment
-- Salary" handler, which correctly stores req.user.id (a users.id).
--
-- Fix:
--   1. The auto-created row is a system action -> created_by is now written
--      as NULL in code (this migration is the data side of that change).
--   2. Null every existing created_by that does not resolve to a real users
--      row (handles the -1 row and any other coerced garbage).
--   3. FK created_by -> users(id) ON DELETE SET NULL.
--
-- NOTE (deviation from the original plan): the plan said FK to admin_profiles,
-- but the only live writer stores a users.id (org staff use Increment Salary);
-- an admin_profiles FK would fail at runtime on every org increment.

UPDATE `employee_salary_history` esh
LEFT JOIN `users` u ON u.`id` = esh.`created_by`
SET esh.`created_by` = NULL
WHERE esh.`created_by` IS NOT NULL AND u.`id` IS NULL;

ALTER TABLE `employee_salary_history`
  ADD CONSTRAINT `fk_esh_created_by`
  FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE SET NULL;