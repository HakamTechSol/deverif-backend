-- Expense permissions, approval bypass audit, payroll carry-forward, and immutable payment history.
-- Apply manually after taking a database backup. This migration preserves existing claims.

ALTER TABLE expense_claims
  ADD COLUMN auto_approved TINYINT(1) NOT NULL DEFAULT 0 AFTER payment_mode,
  ADD COLUMN auto_approved_by_uuid CHAR(36) DEFAULT NULL AFTER auto_approved,
  ADD COLUMN reimbursement_month TINYINT UNSIGNED DEFAULT NULL AFTER expense_month,
  ADD COLUMN reimbursement_year SMALLINT UNSIGNED DEFAULT NULL AFTER reimbursement_month,
  ADD UNIQUE KEY uk_expense_claims_payment_scope
    (organization_id, uuid, employee_uuid),
  ADD KEY idx_expense_claims_reimbursement_period
    (organization_id, reimbursement_year, reimbursement_month, employee_uuid, status);

ALTER TABLE salary_records
  ADD UNIQUE KEY uk_salary_records_payment_scope
    (organization_id, uuid, employee_uuid);

CREATE TABLE expense_payroll_period_locks (
  organization_id BIGINT UNSIGNED NOT NULL,
  employee_uuid CHAR(36) NOT NULL,
  year SMALLINT UNSIGNED NOT NULL,
  month TINYINT UNSIGNED NOT NULL,
  PRIMARY KEY (organization_id, employee_uuid, year, month),
  CONSTRAINT fk_expense_payroll_period_locks_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE,
  CONSTRAINT fk_expense_payroll_period_locks_employee
    FOREIGN KEY (employee_uuid) REFERENCES employees (uuid) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE expense_claim_payments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  organization_id BIGINT UNSIGNED NOT NULL,
  claim_uuid CHAR(36) NOT NULL,
  employee_uuid CHAR(36) NOT NULL,
  salary_record_uuid CHAR(36) DEFAULT NULL,
  legacy_salary_record_uuid CHAR(36) DEFAULT NULL,
  payment_mode ENUM('payroll', 'direct') NOT NULL,
  amount DECIMAL(14,2) NOT NULL,
  payment_reference VARCHAR(120) DEFAULT NULL,
  paid_at DATETIME NOT NULL,
  performed_by_uuid CHAR(36) DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_expense_claim_payments_uuid (uuid),
  UNIQUE KEY uk_expense_claim_payments_claim (claim_uuid),
  KEY idx_expense_claim_payments_org_employee (organization_id, employee_uuid, paid_at),
  KEY idx_expense_claim_payments_salary_record (organization_id, salary_record_uuid, employee_uuid),
  CONSTRAINT fk_expense_claim_payments_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_expense_claim_payments_claim_employee
    FOREIGN KEY (organization_id, claim_uuid, employee_uuid)
    REFERENCES expense_claims (organization_id, uuid, employee_uuid) ON DELETE RESTRICT,
  CONSTRAINT fk_expense_claim_payments_salary_employee
    FOREIGN KEY (organization_id, salary_record_uuid, employee_uuid)
    REFERENCES salary_records (organization_id, uuid, employee_uuid) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Preserve every already-paid claim, including a historical payroll pointer that
-- no longer resolves. Keep that old value explicitly instead of deleting evidence.
INSERT INTO expense_claim_payments (
  uuid, organization_id, claim_uuid, employee_uuid, salary_record_uuid,
  legacy_salary_record_uuid, payment_mode, amount, payment_reference, paid_at,
  performed_by_uuid
)
SELECT UUID(), c.organization_id, c.uuid, c.employee_uuid, sr.uuid,
       CASE WHEN c.paid_via_salary_record_uuid IS NOT NULL AND sr.uuid IS NULL
            THEN c.paid_via_salary_record_uuid ELSE NULL END,
       c.payment_mode, c.amount, c.payment_reference,
       COALESCE(c.paid_at, c.updated_at, c.created_at),
       COALESCE(c.reviewed_by_uuid, c.created_by)
  FROM expense_claims c
  LEFT JOIN salary_records sr
    ON sr.uuid = c.paid_via_salary_record_uuid
   AND sr.organization_id = c.organization_id
   AND sr.employee_uuid = c.employee_uuid
 WHERE c.status = 'paid';

-- Reversal guidance: remove the FK constraints and payment/lock tables first, then
-- drop the added columns/index. Do not reverse this migration after payment history
-- has been written unless that history has been archived and explicitly approved.
