-- 2026-09-13 Phase 3.3 — employees.designation / employees.department (free text)
-- -> FK columns referencing the org-scoped designations / departments tables.
--
-- The controlled-vocabulary tables already existed (managed via the
-- /org/departments and /org/designations APIs) but employee rows were never
-- linked to them. This migration:
--   1. Creates a reference row for every distinct free-text value still in use
--      (so nothing is lost during backfill).
--   2. Adds designation_id / department_id columns.
--   3. Backfills by matching name within the same organization.
--   4. Drops the free-text columns (all backend reads/writes were switched to
--      the FK columns + joined names in the same change).
--   5. Adds the FKs (ON DELETE SET NULL: deleting a vocabulary item unassigns
--      it from employees instead of failing; the delete handlers already run
--      in app code).

INSERT INTO `designations` (`uuid`, `organization_id`, `name`)
SELECT UUID(), oe.`organization_id`, oe.`designation`
FROM (SELECT DISTINCT `organization_id`, `designation` FROM `employees` WHERE `designation` IS NOT NULL AND `designation` <> '') oe
LEFT JOIN `designations` d ON d.`organization_id` = oe.`organization_id` AND d.`name` = oe.`designation`
WHERE d.`id` IS NULL;

INSERT INTO `departments` (`uuid`, `organization_id`, `name`)
SELECT UUID(), oe.`organization_id`, oe.`department`
FROM (SELECT DISTINCT `organization_id`, `department` FROM `employees` WHERE `department` IS NOT NULL AND `department` <> '') oe
LEFT JOIN `departments` d ON d.`organization_id` = oe.`organization_id` AND d.`name` = oe.`department`
WHERE d.`id` IS NULL;

ALTER TABLE `employees`
  ADD COLUMN `designation_id` INT NULL DEFAULT NULL AFTER `department`,
  ADD COLUMN `department_id` INT NULL DEFAULT NULL AFTER `designation_id`;

UPDATE `employees` e
JOIN `designations` d ON d.`organization_id` = e.`organization_id` AND d.`name` = e.`designation`
SET e.`designation_id` = d.`id`
WHERE e.`designation` IS NOT NULL AND e.`designation` <> '';

UPDATE `employees` e
JOIN `departments` d ON d.`organization_id` = e.`organization_id` AND d.`name` = e.`department`
SET e.`department_id` = d.`id`
WHERE e.`department` IS NOT NULL AND e.`department` <> '';

ALTER TABLE `employees` DROP COLUMN `designation`, DROP COLUMN `department`;

ALTER TABLE `employees`
  ADD CONSTRAINT `fk_employee_designation` FOREIGN KEY (`designation_id`) REFERENCES `designations`(`id`) ON DELETE SET NULL,
  ADD CONSTRAINT `fk_employee_department` FOREIGN KEY (`department_id`) REFERENCES `departments`(`id`) ON DELETE SET NULL;