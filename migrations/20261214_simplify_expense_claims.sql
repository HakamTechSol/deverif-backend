-- Simplify expense claims: replace category policy with a free-text expense name.
-- Preserve every historical claim label before detaching the legacy category FK.
ALTER TABLE expense_claims
  ADD COLUMN expense_name varchar(160) NULL AFTER employee_name;

UPDATE expense_claims c
LEFT JOIN expense_categories ec ON ec.uuid = c.category_uuid
SET c.expense_name = COALESCE(NULLIF(TRIM(ec.name), ''), 'Expense')
WHERE c.expense_name IS NULL OR c.expense_name = '';

ALTER TABLE expense_claims
  MODIFY COLUMN expense_name varchar(160) NOT NULL,
  DROP FOREIGN KEY fk_expense_claims_category,
  DROP FOREIGN KEY fk_expense_claims_category_tenant,
  DROP INDEX fk_expense_claims_category,
  DROP INDEX fk_expense_claims_category_tenant,
  MODIFY COLUMN category_uuid char(36) NULL;

-- category_uuid is retained as a historical identifier only; the category system
-- itself is removed. Existing display/payroll data now comes from expense_name.
DROP TABLE expense_categories;
