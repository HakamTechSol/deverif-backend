-- 2026-11-12 — Offboarding & exit management.
--
-- WHY THIS EXISTS. An employee leaving was, until now, a one-line status change:
-- someone edited employees.status to 'ex_employee' and the person disappeared
-- from every roster. Nothing recorded WHEN they were leaving, WHY, what they
-- still had in their hands, or what money was owed to them. The consequences were
-- concrete and all of them silent:
--
--   - A laptop went home and nobody ever knew it was company property.
--   - Unused annual leave was never paid out, because there was no moment at which
--     anyone computed it.
--   - An employee who served three days of a thirty-day notice was paid a full
--     month, because nothing compared the notice served against the notice agreed.
--   - There was no approval trail, so "who let this person go, and on whose
--     authority" had no answer six months later.
--
-- Three tables, one lifecycle. An exit_request is the spine; the checklist is what
-- each department must clear before the money moves; the settlement is the money.
--
-- Design notes that are load-bearing rather than cosmetic:
--
--  - `last_working_day` is the pivot for every calculation, and it is stored
--    explicitly rather than derived. It is usually "today plus notice", but an HR
--    team negotiating an earlier exit will move it, and every figure below has to
--    keep agreeing with the date on the letter.
--
--  - notice_period_days is the CONTRACTUAL notice, not the notice served. The
--    difference between the two is what the shortfall recovery is computed from,
--    so overwriting one with the other would destroy the calculation.
--
--  - `status` on the settlement is separate from `status` on the exit request on
--    purpose. An approved resignation with an unresolved checklist is still
--    approved; it is the PAYMENT that is blocked, not the approval.

-- ---------------------------------------------------------------------------
-- 1. exit_requests
--
-- One open exit per employee at a time. A generated column rather than a partial
-- index, for the same reason asset_assignments uses open_assignment_guard: the
-- obvious UNIQUE(employee_uuid, status) would permit a second 'pending' row
-- alongside a 'completed' one and, worse, NULL semantics would make the rule
-- untestable. The guard is a non-NULL constant while the request is open, which
-- MySQL's UNIQUE index does enforce.
--
-- Note the asymmetry that follows from the guard: only ONE row per employee can
-- exist at a time in an open state, but multiple COMPLETED/rejected histories are
-- allowed, because the guard is NULL for those. That is intentional - someone can
-- resign, be rehired, and resign again.
--
-- Every statement below is CREATE TABLE IF NOT EXISTS, so this file is
-- re-runnable. That is not decoration: an earlier migration in this schema aborted
-- halfway through on a syntax error in a later statement, leaving the file neither
-- applied nor recorded, and re-running it then failed on the tables it had already
-- created.

CREATE TABLE IF NOT EXISTS `exit_requests` (
  `id`                    BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `uuid`                  CHAR(36) NOT NULL,
  `organization_id`       BIGINT UNSIGNED NOT NULL,
  `employee_uuid`         CHAR(36) NOT NULL,
  -- Full name is denormalised deliberately. The exit record is a legal document
  -- and must remain readable years after the employee row is edited, merged or
  -- deleted; joining to a mutable roster for an employee's name on a termination
  -- letter is not something to discover at audit time.
  `employee_name`         VARCHAR(200) NOT NULL,
  `designation`           VARCHAR(150) DEFAULT NULL,
  -- 'resignation' = the employee gave notice. 'termination' = the employer ended
  -- it. The distinction is not cosmetic: a termination has no notice to serve and
  -- no employee-caused shortfall, so recovery runs the other way.
  `request_type`          ENUM('resignation','termination') NOT NULL,
  `notice_period_days`    INT NOT NULL DEFAULT 0,
  `last_working_day`      DATE NOT NULL,
  `reason`                VARCHAR(1000) DEFAULT NULL,
  `status`                ENUM('pending','approved','rejected','completed') NOT NULL DEFAULT 'pending',
  `decided_by`            CHAR(36) DEFAULT NULL,
  `decided_at`            DATETIME DEFAULT NULL,
  `decision_notes`        VARCHAR(1000) DEFAULT NULL,
  -- When the exit actually completed, as opposed to when it was approved. Set once,
  -- at completion, and it is what flips the employee to 'ex_employee'.
  `completed_at`          DATETIME DEFAULT NULL,
  `hr_notes`              TEXT DEFAULT NULL,
  `created_by`            CHAR(36) DEFAULT NULL,
  `created_at`            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `open_exit_guard`       TINYINT GENERATED ALWAYS AS
                          (CASE WHEN `status` IN ('pending','approved') THEN 1 ELSE NULL END) STORED,
  UNIQUE KEY `uk_exit_requests_uuid` (`uuid`),
  -- At most one exit in flight per employee. See the note above on why this is a
  -- generated column and not a plain UNIQUE(employee_uuid, status).
  UNIQUE KEY `uk_exit_requests_open` (`employee_uuid`, `open_exit_guard`),
  INDEX `idx_exit_requests_org_status` (`organization_id`, `status`),
  INDEX `idx_exit_requests_employee` (`organization_id`, `employee_uuid`),
  INDEX `idx_exit_requests_lwd` (`organization_id`, `last_working_day`),
  -- decided_by and created_by are polymorphic over users/admin_profiles, which is
  -- why there is no FK: a hard FK to users(uuid) is what made platform-admin
  -- approvals fail before (see 20260821_audit_fixes.sql).
  CONSTRAINT `fk_exit_requests_org`
    FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_exit_requests_employee`
    FOREIGN KEY (`employee_uuid`) REFERENCES `employees` (`uuid`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 2. offboarding_checklists
--
-- Four departments because four teams have something to hand back or switch off,
-- and because "HR will chase IT" is not a process. The four standard rows are
-- seeded by the service on request creation, so a new exit always starts from the
-- same baseline instead of from whatever someone remembered to type.
--
-- UNIQUE(exit_request_uuid, task_name), NOT (exit_request_uuid, department). The
-- obvious key is wrong, and it was wrong here first: a department has more than
-- one thing to hand back (IT revokes access AND collects devices), so a
-- per-department key refuses the second IT task and the whole request 409s. A
-- department column is a grouping, not a uniqueness constraint. Keying on the
-- task name still does the job it was there for - a duplicated INSERT cannot
-- quietly create two IT tasks and make the checklist look 60% clear when it is
-- 50%.
--
-- `cleared_by_uuid` is nullable and NOT an FK for the same polymorphic reason.
CREATE TABLE IF NOT EXISTS `offboarding_checklists` (
  `id`                 BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `uuid`               CHAR(36) NOT NULL,
  `organization_id`    BIGINT UNSIGNED NOT NULL,
  `exit_request_uuid`  CHAR(36) NOT NULL,
  `department`         ENUM('IT','Finance','Assets','HR') NOT NULL,
  `task_name`          VARCHAR(200) NOT NULL,
  `status`             ENUM('pending','cleared') NOT NULL DEFAULT 'pending',
  `cleared_by_uuid`    CHAR(36) DEFAULT NULL,
  `cleared_at`         DATETIME DEFAULT NULL,
  `notes`              VARCHAR(500) DEFAULT NULL,
  `created_at`         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_offboarding_checklists_uuid` (`uuid`),
  UNIQUE KEY `uk_checklist_exit_task` (`exit_request_uuid`, `task_name`),
  INDEX `idx_checklist_org_status` (`organization_id`, `status`),
  CONSTRAINT `fk_checklist_exit`
    FOREIGN KEY (`exit_request_uuid`) REFERENCES `exit_requests` (`uuid`) ON DELETE CASCADE,
  CONSTRAINT `fk_checklist_org`
    FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 3. final_settlements
--
-- The money. Every column is the INPUT to the calculation as well as its result,
-- because a settlement someone cannot reconstruct is one nobody will approve: an
-- employee disputing the figure needs the encashment, the shortfall recovery and
-- the asset exposure shown separately, not just the net.
--
-- `leave_encashment_days` and `basic_salary_for_rate` exist so the per-day rate
-- used is knowable AFTER the fact. Recomputing it later from a salary that has
-- since changed produces a different number, which is indistinguishable from
-- someone having tampered with the payout.
--
-- `asset_deductions` is the amount ACTUALLY deducted from the settlement, which is
-- capped at the gross payable: a laptop worth more than the remaining salary
-- cannot produce a negative final settlement. The uncapped exposure is returned by
-- the API alongside it (`asset_deductions_exposure`) so HR can still see what is
-- owed - the cap limits the deduction, it does not erase the debt.
--
-- UNIQUE(exit_request_uuid): one settlement per exit. A termination gets exactly
-- one chance to be calculated, and the guard on processing (see the service) is
-- what stops a second one being inserted after the fact.
CREATE TABLE IF NOT EXISTS `final_settlements` (
  `id`                        BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `uuid`                      CHAR(36) NOT NULL,
  `organization_id`           BIGINT UNSIGNED NOT NULL,
  `exit_request_uuid`         CHAR(36) NOT NULL,
  `employee_uuid`             CHAR(36) NOT NULL,
  -- Frozen inputs, so the rate behind the figures is auditable.
  `basic_salary`              DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `working_days_in_month`     INT NOT NULL DEFAULT 0,
  `per_day_rate`              DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `leave_encashment_days`     DECIMAL(8,2) NOT NULL DEFAULT 0.00,
  `leave_encashment_amount`   DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  -- Negative when the employee UNDER-SERVED notice (a recovery), positive only if
  -- an employer ever chose to pay out over-service, which the service does not do.
  `notice_period_days`        INT NOT NULL DEFAULT 0,
  `notice_days_served`        INT NOT NULL DEFAULT 0,
  `notice_pay_adjustment`     DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `asset_deductions`          DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  -- Uncapped value of assets still held, retained even when the applied deduction
  -- was capped. Never null: 0 means "nothing outstanding", which is a different
  -- statement from "not yet calculated".
  `asset_deductions_exposure` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `unreturned_asset_count`    INT NOT NULL DEFAULT 0,
  `net_fnf_amount`            DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `status`                    ENUM('draft','processed','paid') NOT NULL DEFAULT 'draft',
  `processed_by`              CHAR(36) DEFAULT NULL,
  `processed_at`              DATETIME DEFAULT NULL,
  `paid_at`                   DATETIME DEFAULT NULL,
  `payment_reference`         VARCHAR(120) DEFAULT NULL,
  `notes`                     VARCHAR(1000) DEFAULT NULL,
  `created_at`                DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`                DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_final_settlements_uuid` (`uuid`),
  UNIQUE KEY `uk_final_settlements_exit` (`exit_request_uuid`),
  INDEX `idx_settlements_org_status` (`organization_id`, `status`),
  INDEX `idx_settlements_employee` (`organization_id`, `employee_uuid`),
  CONSTRAINT `fk_settlements_exit`
    FOREIGN KEY (`exit_request_uuid`) REFERENCES `exit_requests` (`uuid`) ON DELETE CASCADE,
  CONSTRAINT `fk_settlements_employee`
    FOREIGN KEY (`employee_uuid`) REFERENCES `employees` (`uuid`) ON DELETE CASCADE,
  CONSTRAINT `fk_settlements_org`
    FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;