-- 2026-09-13 Optional polish (post-Phase 3 review):
--   1. UNIQUE(organization_id, name) on designations / departments so the
--      controlled-vocabulary stays deduplicated (controller had an app-level
--      dup check; this makes it structural). No duplicates exist in data.
--   2. FK salary_records.created_by -> users(id) ON DELETE SET NULL.
--      Verified: the (only) writer, buildOrgSalaryRecords, stores
--      req.user?.id ?? null (a users.id) — this is the same safe pattern as
--      employee_salary_history, it plain lacked a FK because the table is
--      empty (0 rows) and has never held bad ids.
--   3. FK salary_components.created_by -> users(id) ON DELETE SET NULL for the
--      same reason (writer = org staff req.user.id; current row resolves to
--      users.id=1).

ALTER TABLE `designations`
  ADD UNIQUE KEY `uq_designations_org_name` (`organization_id`, `name`);

ALTER TABLE `departments`
  ADD UNIQUE KEY `uq_departments_org_name` (`organization_id`, `name`);

ALTER TABLE `salary_records`
  ADD CONSTRAINT `fk_sr_created_by`
  FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE SET NULL;

ALTER TABLE `salary_components`
  ADD CONSTRAINT `fk_sc_created_by`
  FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE SET NULL;