-- Employment identity is per organization, not platform-wide.
--
-- A person may leave one company and join another. Their `employees` row belongs
-- to the employment, so the same CNIC/email must be allowed in a different
-- organization once the old row is an ex-employee. The global identity remains
-- on `users` (one platform account, one CNIC/phone).
--
-- Generated columns keep the constraint honest under concurrency without
-- blocking historical rows: an ex_employee row contributes NULL and therefore
-- never conflicts, while a current/inactive row still enforces one identity per
-- organization. MySQL treats multiple NULLs as distinct in a UNIQUE index.
--
-- Dated after the full-schema snapshot so the migration replay sees these
-- columns; see tests/sqlColumns.test.js.

ALTER TABLE `employees`
  ADD COLUMN `active_cnic` varchar(20)
    GENERATED ALWAYS AS (IF(`status` <> 'ex_employee', `cnic`, NULL)) STORED,
  ADD COLUMN `active_email` varchar(190)
    GENERATED ALWAYS AS (IF(`status` <> 'ex_employee', `email`, NULL)) STORED;

ALTER TABLE `employees`
  ADD UNIQUE KEY `uq_employees_org_active_cnic` (`organization_id`, `active_cnic`),
  ADD UNIQUE KEY `uq_employees_org_active_email` (`organization_id`, `active_email`),
  ADD KEY `idx_employees_cnic` (`cnic`);
