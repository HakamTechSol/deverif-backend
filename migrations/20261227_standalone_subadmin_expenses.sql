-- Allow Sub-admin expense claims that are not linked to an employee or payroll record.
-- Apply manually after taking a database backup.

ALTER TABLE expense_claim_payments
  DROP FOREIGN KEY fk_expense_claim_payments_claim_employee;

ALTER TABLE expense_claims
  MODIFY employee_uuid CHAR(36) DEFAULT NULL,
  ADD UNIQUE KEY uk_expense_claims_org_uuid (organization_id, uuid),
  ADD KEY idx_expense_claims_creator (organization_id, created_by, expense_date);

ALTER TABLE expense_claim_payments
  MODIFY employee_uuid CHAR(36) DEFAULT NULL,
  ADD KEY idx_expense_claim_payments_org_claim (organization_id, claim_uuid),
  ADD CONSTRAINT fk_expense_claim_payments_claim_employee
    FOREIGN KEY (organization_id, claim_uuid, employee_uuid)
    REFERENCES expense_claims (organization_id, uuid, employee_uuid) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_expense_claim_payments_claim_org
    FOREIGN KEY (organization_id, claim_uuid)
    REFERENCES expense_claims (organization_id, uuid) ON DELETE RESTRICT;

-- Reversal guidance: remove the added claim FK and index, restore both columns to
-- NOT NULL only after all standalone claims/payments have been migrated or removed.
