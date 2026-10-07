-- 2026-11-07 — Payroll auto-computation: the tables it needs to read, and the
-- one it needs to write.
--
-- WHY THIS EXISTS. Payroll was a manual ledger: POST /org/payroll/generate read
-- employee_salary_history for a basic salary and employee_salary_components for
-- fixed/percentage allowances, then folded everything into three scalars. Leave
-- and attendance were never consulted, so an employee could take four days of
-- unpaid leave, never clock in for a week, work forty overtime hours, and be paid
-- the same as a colleague who did none of it. Both modules were fully built and
-- simply not connected to money.
--
-- Four things had to exist before any of it could be computed, and none of them
-- did. This migration adds exactly those, and nothing speculative:
--
--   1. leave_types.is_paid          — there was no paid/unpaid concept anywhere,
--                                     so "unpaid_leave_days" was not derivable.
--   2. holidays + work_week_config   — absence is implicit in this schema (no
--                                     attendance row means no day), and there was
--                                     no calendar of non-working days. Counting
--                                     absences without this treats every Saturday
--                                     and Sunday as unpaid absence and docks pay
--                                     for two days a week, every week.
--   3. overtime_requests             — no overtime column, table or approval flow
--                                     existed; `overtime` appeared nowhere in the
--                                     codebase.
--   4. salary_record_lines            — salary_records holds only pre-aggregated
--                                     allowances/deductions scalars, so a payslip
--                                     could show a total but never say WHICH
--                                     absence or WHICH leave caused it.

-- ---------------------------------------------------------------------------
-- 1. leave_types.is_paid
--
-- DEFAULT 'yes', deliberately. The two leave types every organization starts
-- with (Annual, Sick) are paid by law and by convention; defaulting to 'no' would
-- make every pre-existing row silently unpaid and start docking pay from the
-- month this migration ran, with no way for an admin to see why. Defaulting to
-- 'yes' means: absent an explicit choice, nobody loses pay. The failure mode of
-- the opposite default is money leaving a payroll; the failure mode of this one is
-- a deduction an admin has to switch on deliberately.
--
-- The flag lives on the TYPE, not the request, because entitlement is a property
-- of the class of leave. A per-request override would let one unpaid day be
-- smuggled through by editing a single row, which is not an audit trail.
--
-- Wrapped in an information_schema guard because MySQL has no
-- `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` (MariaDB does; this server is MySQL
-- 8.0 CE). Without the guard a partially-applied file cannot be re-run: the ALTER
-- aborts on the duplicate column and every later statement is never reached.
-- That is not hypothetical - it is exactly what happened the first time this file
-- ran, when a later statement had a syntax error.
SET @ddl := (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE `leave_types` ADD COLUMN `is_paid` ENUM(''yes'',''no'') NOT NULL DEFAULT ''yes'' AFTER `days_allowed_per_year`',
    'DO 0'
  )
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'leave_types'
    AND column_name = 'is_paid'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------------
-- 2. holidays — the org's non-working days
--
-- `date` is the day being marked off, not the day of the holiday. UNIQUE on
-- (organization_id, date) so the same public holiday cannot be entered twice and
-- then counted twice in the working-day total.
CREATE TABLE IF NOT EXISTS `holidays` (
  `id`              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `uuid`            CHAR(36) NOT NULL,
  `organization_id` BIGINT UNSIGNED NOT NULL,
  `name`            VARCHAR(150) NOT NULL,
  `date`            DATE NOT NULL,
  `created_by`      BIGINT UNSIGNED NULL,
  `created_at`      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_holidays_uuid` (`uuid`),
  UNIQUE KEY `uk_holidays_org_date` (`organization_id`, `date`),
  INDEX `idx_holidays_org_date` (`organization_id`, `date`),
  CONSTRAINT `fk_holidays_org`
    FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 2b. work_week_config — which weekdays this org works
--
-- One row per organization. Stored as seven 0/1 flags rather than a
-- "weekend days" pair because the Gulf work week (Fri/Sat off, or Fri half) is
-- not expressible as two days, and a half-day is not expressible at all; the flag
-- set is.
--
-- Defaults: Saturday and Saturday+Friday off, i.e. Mon-Fri on. This is the
-- least-wrong guess for an unspecified org and, importantly, it never counts a
-- day as WORKING that a human would call a weekend. Where no config row exists
-- the service reads this default from the code rather than from the table, so a
-- missing row degrades to the sane answer instead of to zero working days (which
-- would divide by zero in the per-day rate).
CREATE TABLE IF NOT EXISTS `work_week_config` (
  `id`              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `organization_id` BIGINT UNSIGNED NOT NULL,
  `mon` TINYINT(1) NOT NULL DEFAULT 1,
  `tue` TINYINT(1) NOT NULL DEFAULT 1,
  `wed` TINYINT(1) NOT NULL DEFAULT 1,
  `thu` TINYINT(1) NOT NULL DEFAULT 1,
  `fri` TINYINT(1) NOT NULL DEFAULT 1,
  `sat` TINYINT(1) NOT NULL DEFAULT 0,
  `sun` TINYINT(1) NOT NULL DEFAULT 0,
  `updated_by`      BIGINT UNSIGNED NULL,
  `created_at`      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_work_week_org` (`organization_id`),
  CONSTRAINT `fk_work_week_org`
    FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 3. overtime_requests
--
-- Modelled on leave_requests, because it is the same shape of problem: someone
-- asks, somebody decides, payroll reads the decided answer. The two hours columns
-- are separate on purpose — `requested_hours` is what the employee claims and
-- `approved_hours` is what management allowed, and payroll may only ever pay the
-- second. Collapsing them is how overtime creep becomes invisible.
--
-- No FK on decided_by: the same polymorphic users/admin_profiles UUID problem that
-- forced 20260821_audit_fixes.sql to drop the equivalent on leave_requests.
CREATE TABLE IF NOT EXISTS `overtime_requests` (
  `id`              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `uuid`            CHAR(36) NOT NULL,
  `employee_uuid`   CHAR(36) NOT NULL,
  `organization_id` BIGINT UNSIGNED NOT NULL,
  `work_date`       DATE NOT NULL,
  `requested_hours` DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  `approved_hours`  DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  `reason`          VARCHAR(500) DEFAULT NULL,
  `status`          ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  `decided_by`      CHAR(36) DEFAULT NULL,
  `decided_at`      DATETIME DEFAULT NULL,
  `decision_notes`  VARCHAR(500) DEFAULT NULL,
  `created_at`      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_overtime_requests_uuid` (`uuid`),
  -- One request per employee per day: two rows for the same day would either
  -- double-pay or silently arbitrate, and neither is knowable after the fact.
  UNIQUE KEY `uk_overtime_employee_date` (`employee_uuid`, `work_date`),
  INDEX `idx_overtime_org_status` (`organization_id`, `status`),
  INDEX `idx_overtime_org_date` (`organization_id`, `work_date`),
  CONSTRAINT `fk_overtime_employee`
    FOREIGN KEY (`employee_uuid`) REFERENCES `employees` (`uuid`) ON DELETE CASCADE,
  CONSTRAINT `fk_overtime_org`
    FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 4. salary_record_lines — one row per line on a payslip
--
-- salary_records keeps its two scalars, which stay authoritative for the net
-- figure and for every export and report that already reads them. This table is
-- the explanation: which allowance, which deduction, and where each came from.
--
-- `source` is what makes an automatic deduction reviewable. An employee asking
-- "why was 2,000 deducted?" needs the answer to be "2 unpaid leave days at
-- 1,000/day", produced by a rule, not typed by a human — and to be
-- distinguishable from a manual deduction an admin entered for something
-- entirely different.
--
-- 4a. salary_records.uuid needs a UNIQUE key before this table can reference it.
-- It had NO index at all, which is only tolerated because nothing depended on it
-- being unique — the payslip endpoint selects by it, so two records sharing a
-- uuid would make /salary-records/:uuid/payslip ambiguous and return an arbitrary
-- one of the two. The foreign key below forces the issue, and forcing it here
-- means the guarantee exists rather than being assumed.
-- Verified duplicate-free before adding; guarded so a re-run is a no-op.
SET @ddl := (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE `salary_records` ADD UNIQUE KEY `uk_salary_records_uuid` (`uuid`)',
    'DO 0'
  )
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'salary_records'
    AND index_name = 'uk_salary_records_uuid'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
--
-- ON DELETE CASCADE from salary_records: deleting a period must not leave orphan
-- lines pointing at records that no longer exist.
CREATE TABLE IF NOT EXISTS `salary_record_lines` (
  `id`                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `uuid`              CHAR(36) NOT NULL,
  `salary_record_uuid` CHAR(36) NOT NULL,
  `organization_id`   BIGINT UNSIGNED NOT NULL,
  `employee_uuid`     CHAR(36) NOT NULL,
  `month`             TINYINT UNSIGNED NOT NULL,
  `year`              SMALLINT UNSIGNED NOT NULL,
  `label`             VARCHAR(150) NOT NULL,
  `type`              ENUM('earning','deduction') NOT NULL,
  `source`            ENUM('basic','component','auto_unpaid_leave','auto_absenteeism','auto_late','auto_overtime','manual') NOT NULL,
  `amount`            DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  -- The numbers behind the number, so the payslip can show the arithmetic and a
  -- later raise can be checked against the day count that produced it. NULL for
  -- component lines, which have no day/hour basis. A nullable ENUM rather than an
  -- enum with a NULL member: MySQL rejects a bare NULL inside ENUM(...), and the
  -- whole column being nullable already expresses "no basis".
  `basis_value`       DECIMAL(10,2) DEFAULT NULL,
  `basis_unit`        ENUM('days','hours','late_arrivals') DEFAULT NULL,
  `created_at`        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_salary_record_lines_uuid` (`uuid`),
  INDEX `idx_srl_record` (`salary_record_uuid`),
  INDEX `idx_srl_employee_period` (`employee_uuid`, `year`, `month`),
  INDEX `idx_srl_org` (`organization_id`),
  CONSTRAINT `fk_srl_record`
    FOREIGN KEY (`salary_record_uuid`) REFERENCES `salary_records` (`uuid`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 5. Seed the Mon-Fri default for organizations that already exist, so the
-- config table is not empty for anyone and the admin UI has a row to edit rather
-- than a first-run empty state that looks like "no one works here".
--
-- INSERT IGNORE, not INSERT: re-running a migration must not fail on the unique
-- key, and a re-materialised database should converge to the same shape.
INSERT IGNORE INTO `work_week_config` (`organization_id`)
  SELECT `id` FROM `organizations`;
