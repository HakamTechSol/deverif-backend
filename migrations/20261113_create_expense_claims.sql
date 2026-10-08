-- 2026-11-13 — Expense claims and reimbursements.
--
-- WHY THIS EXISTS. Employees paid their own money and had no way to claim it back:
-- a taxi fare, a hotel, a client lunch. Where expenses were handled at all it was
-- outside the system, so the company either paid twice (once on a claim form, once
-- on a claim in payroll) or paid nothing and lost the person. Either way there
-- was no record, and no way to answer "what did we spend on clients in March".
--
-- Two tables. expense_categories is this org's policy - what may be claimed, up
-- to what, and whether evidence is mandatory. expense_claims is the money.
--
-- THE INVARIANT THIS SCHEMA EXISTS TO ENFORCE: a claim can be paid once.
--
-- Payroll pays approved claims that are set to go through payroll, and a claim
-- can also be reimbursed directly as a bank transfer. Two administrators, two
-- clicks, one expense paid twice is otherwise the default outcome - the window
-- between "approved" and "paid" is long enough for it to happen. So approval does
-- not mark anything paid, `paid` is terminal, and the row that consumed the claim
-- is recorded, which is what makes regenerating a payroll period safe.
--
-- Every statement is CREATE TABLE IF NOT EXISTS or a guarded ALTER, so the file is
-- re-runnable. That is not decoration: an earlier migration in this schema aborted
-- halfway through on a syntax error in a later statement, leaving the file neither
-- applied nor recorded.

-- ---------------------------------------------------------------------------
-- 1. expense_categories — this org's policy, not a global list
--
-- Org-scoped on purpose. A category is a statement about what this company will
-- reimburse, and "we do not pay for first class flights" is not universal. A
-- global catalogue would need per-org overrides and would end up with a single
-- limit that is wrong everywhere except the company that set it.
--
-- max_limit_per_claim is NULLABLE to mean "no limit". Defaulting it to 0 instead
-- would read as "nothing may be claimed", and a zero would also block the row
-- from ever being used rather than simply going unchecked.
--
-- requires_receipt is the flag that makes the attachments integration worth
-- having: a category marked this way cannot be APPROVED without a receipt, so
-- "attach a receipt or it will be rejected" is enforced by the schema's own
-- companion rules rather than by everyone remembering.
CREATE TABLE IF NOT EXISTS `expense_categories` (
  `id`                   BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `uuid`                 CHAR(36) NOT NULL,
  `organization_id`      BIGINT UNSIGNED NOT NULL,
  `name`                 VARCHAR(120) NOT NULL,
  `description`          VARCHAR(500) DEFAULT NULL,
  -- NULL = no ceiling. See the note above for why 0 is not the same thing.
  `max_limit_per_claim`  DECIMAL(14,2) DEFAULT NULL,
  `requires_receipt`     TINYINT(1) NOT NULL DEFAULT 0,
  `is_active`            TINYINT(1) NOT NULL DEFAULT 1,
  `created_by`           BIGINT UNSIGNED NULL,
  `created_at`           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_expense_categories_uuid` (`uuid`),
  -- Needed by the composite tenant FK on expense_claims below: a foreign key must
  -- reference an indexed prefix, and (organization_id, uuid) is what makes the
  -- claim's category provably belong to the claim's own organization.
  UNIQUE KEY `uk_expense_categories_org_uuid` (`organization_id`, `uuid`),
  -- One category per name per org. Without this, two "Travel" categories exist
  -- with different limits and a claim's validity depends on which one was picked.
  UNIQUE KEY `uk_expense_categories_org_name` (`organization_id`, `name`),
  INDEX `idx_expense_categories_org` (`organization_id`, `is_active`),
  CONSTRAINT `fk_expense_categories_org`
    FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 2. expense_claims
--
-- employee_name is denormalised for the same reason exit_requests does it: an
-- expense claim is financial evidence and has to stay readable after the roster
-- is edited or the employee is deleted. Joining to a mutable name for an audit
-- trail is not something to discover at audit time.
--
-- expense_date is what payroll buckets a claim by, so it - not created_at - is
-- the date an expense belongs to. Claiming in March for a February taxi must land
-- in February's payroll, which is the whole reason this column is separate.
--
-- `paid_via_salary_record_uuid` is the anti-double-payment record: it names the
-- exact salary record that consumed the claim. No FK, because salary_records.uuid
-- is unique but its rows are deletable along with a regenerated period, and a
-- dangling pointer here would be harmless - the claim stays paid, which is the
-- correct state for money that was already disbursed.
--
-- `review_guard` is a generated column so that approving an already-reviewed claim
-- is impossible rather than merely discouraged. A partial UNIQUE cannot express
-- "at most one approved-but-unpaid claim per employee per month per payment mode",
-- and the generated-column trick is what asset_assignments and exit_requests
-- already use here for exactly this reason.
--
-- No unique constraint on (employee, category, expense_date, amount): two taxis on
-- one day are two legitimate claims, and de-duplicating them would silently delete
-- a real expense. Duplicate submission is caught by the review step instead, where
-- a human can see it.
CREATE TABLE IF NOT EXISTS `expense_claims` (
  `id`                     BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `uuid`                   CHAR(36) NOT NULL,
  `organization_id`        BIGINT UNSIGNED NOT NULL,
  `employee_uuid`          CHAR(36) NOT NULL,
  `employee_name`          VARCHAR(200) NOT NULL,
  `category_uuid`          CHAR(36) NOT NULL,
  `amount`                 DECIMAL(14,2) NOT NULL,
  `expense_date`           DATE NOT NULL,
  `description`            VARCHAR(500) DEFAULT NULL,
  `status`                 ENUM('pending','approved','rejected','paid') NOT NULL DEFAULT 'pending',
  -- 'payroll' means the claim is reimbursed on the next payroll run, as a
  -- non-taxable earning line. 'direct' means a bank transfer, handled outside
  -- payroll entirely. Kept distinct because the two have genuinely different
  -- consequences: a payroll-mode claim that has been processed is PAID, while a
  -- direct one stays approved until someone confirms the transfer.
  `payment_mode`           ENUM('payroll','direct') NOT NULL DEFAULT 'payroll',
  `reviewed_by_uuid`       CHAR(36) DEFAULT NULL,
  `reviewed_at`            DATETIME DEFAULT NULL,
  `rejection_reason`       VARCHAR(500) DEFAULT NULL,
  `paid_at`                DATETIME DEFAULT NULL,
  `paid_via_salary_record_uuid` CHAR(36) DEFAULT NULL,
  `payment_reference`      VARCHAR(120) DEFAULT NULL,
  `created_by`             CHAR(36) DEFAULT NULL,
  `created_at`             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  -- Non-NULL while a claim is approved but not yet paid. Approving a second claim
  -- for the same employee, month and payment mode while the first is still open is
  -- refused by the index below rather than by a check some future caller forgets.
  `unpaid_approval_guard`  TINYINT GENERATED ALWAYS AS
                           (CASE WHEN `status` = 'approved' THEN 1 ELSE NULL END) STORED,
  -- Generated rather than indexed as YEAR(expense_date)/MONTH(expense_date),
  -- because MySQL refuses to index a non-deterministic function and payroll looks
  -- claims up by month. Stored columns keep the lookup an index range scan instead
  -- of a full scan of every claim in the organization.
  `expense_year`           SMALLINT UNSIGNED GENERATED ALWAYS AS (YEAR(`expense_date`)) STORED,
  `expense_month`          TINYINT UNSIGNED GENERATED ALWAYS AS (MONTH(`expense_date`)) STORED,
  UNIQUE KEY `uk_expense_claims_uuid` (`uuid`),
  -- UNIQUE, and that word is the entire point of the generated column: written as
  -- a plain KEY the whole guard silently does nothing, because a non-unique index
  -- does not reject a duplicate, it merely makes the lookup fast. That is not
  -- hypothetical - it is how this column shipped the first time, and the test that
  -- tried to catch it passed against a database that happily accepted the second
  -- approval. A guard that cannot fail is not a guard.
  UNIQUE KEY `uk_expense_claims_unpaid_approval`
       (`employee_uuid`, `expense_date`, `payment_mode`, `unpaid_approval_guard`),
  INDEX `idx_expense_claims_org_status` (`organization_id`, `status`),
  INDEX `idx_expense_claims_employee` (`organization_id`, `employee_uuid`, `expense_date`),
  INDEX `idx_expense_claims_period` (`organization_id`, `expense_year`, `expense_month`),
  INDEX `idx_expense_claims_paid_via` (`paid_via_salary_record_uuid`),
  CONSTRAINT `fk_expense_claims_org`
    FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_expense_claims_employee`
    FOREIGN KEY (`employee_uuid`) REFERENCES `employees` (`uuid`) ON DELETE CASCADE,
  CONSTRAINT `fk_expense_claims_category`
    FOREIGN KEY (`category_uuid`) REFERENCES `expense_categories` (`uuid`) ON DELETE RESTRICT,
  -- reviewed_by and created_by are polymorphic over users/admin_profiles, which is
  -- why there is no FK: a hard FK to users(uuid) is what made platform-admin
  -- approvals fail before (see 20260821_audit_fixes.sql).
  CONSTRAINT `fk_expense_claims_category_tenant`
    FOREIGN KEY (`organization_id`, `category_uuid`)
    REFERENCES `expense_categories` (`organization_id`, `uuid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 3. Widen salary_record_lines so a reimbursement can be a line item.
--
-- The claim reimbursement is an EARNING on the payslip, sourced from a rule rather
-- than typed by anyone, exactly like the automatic leave deduction added in Phase 3.
-- Without this the payslip could show a reimbursement in its total and still be
-- unable to say what it was - which is the defect salary_record_lines was created
-- to end.
--
-- MODIFY COLUMN, not a new table: the old values must survive, so the full enum is
-- restated. Guarded through information_schema because the column definition has to
-- be compared as text, and a re-run must not fail.
--
-- basis_unit gains 'claims' for the same reason: the line's amount is derived from a
-- count of claims, and a basis that cannot be expressed is a basis nobody can audit.
SET @ddl := (
  SELECT IF(
    COLUMN_TYPE LIKE '%auto_expense%',
    'DO 0',
    'ALTER TABLE `salary_record_lines` MODIFY COLUMN `source` ENUM(''basic'',''component'',''auto_unpaid_leave'',''auto_absenteeism'',''auto_late'',''auto_overtime'',''auto_expense'',''manual'') NOT NULL'
  )
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'salary_record_lines'
    AND column_name = 'source'
  LIMIT 1
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl := (
  SELECT IF(
    COLUMN_TYPE LIKE '%claims%',
    'DO 0',
    'ALTER TABLE `salary_record_lines` MODIFY COLUMN `basis_unit` ENUM(''days'',''hours'',''late_arrivals'',''claims'') DEFAULT NULL'
  )
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'salary_record_lines'
    AND column_name = 'basis_unit'
  LIMIT 1
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;