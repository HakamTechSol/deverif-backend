-- Leave workflow, half-day support, and an append-only balance ledger.
-- Existing leave requests and allocation values are preserved.

ALTER TABLE leave_requests
  MODIFY COLUMN status ENUM('pending','approved','rejected','cancelled') NOT NULL DEFAULT 'pending',
  ADD COLUMN day_portion ENUM('full','half') NOT NULL DEFAULT 'full',
  ADD COLUMN approved_days DECIMAL(8,2) NULL,
  ADD COLUMN cancelled_by CHAR(36) NULL,
  ADD COLUMN cancelled_at DATETIME NULL;

ALTER TABLE employee_leave_allocations
  MODIFY COLUMN used_days DECIMAL(8,2) NOT NULL DEFAULT 0,
  MODIFY COLUMN remaining_days DECIMAL(8,2) NOT NULL DEFAULT 0;

CREATE TABLE leave_balance_ledger (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_uuid CHAR(36) NOT NULL,
  leave_type_id BIGINT UNSIGNED NOT NULL,
  allocation_id BIGINT UNSIGNED NULL,
  transaction_type ENUM('opening_balance','allocation','leave_approved','leave_cancelled','admin_adjustment') NOT NULL,
  credited_days DECIMAL(8,2) NOT NULL DEFAULT 0,
  debited_days DECIMAL(8,2) NOT NULL DEFAULT 0,
  previous_balance DECIMAL(8,2) NOT NULL,
  updated_balance DECIMAL(8,2) NOT NULL,
  related_leave_request_uuid CHAR(36) NULL,
  transaction_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  performed_by CHAR(36) NULL,
  reason VARCHAR(1000) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_leave_ledger_request_action (related_leave_request_uuid, transaction_type),
  KEY idx_leave_ledger_allocation (allocation_id, id),
  KEY idx_leave_ledger_employee_type_date (employee_uuid, leave_type_id, transaction_at),
  CONSTRAINT fk_leave_ledger_employee FOREIGN KEY (employee_uuid) REFERENCES employees (uuid),
  CONSTRAINT fk_leave_ledger_type FOREIGN KEY (leave_type_id) REFERENCES leave_types (id),
  CONSTRAINT fk_leave_ledger_allocation FOREIGN KEY (allocation_id) REFERENCES employee_leave_allocations (id),
  CONSTRAINT fk_leave_ledger_request FOREIGN KEY (related_leave_request_uuid) REFERENCES leave_requests (uuid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Capture the existing available balance without rewriting or deleting leave
-- history. The old used_days value is retained in the reason for reconciliation.
INSERT INTO leave_balance_ledger
  (employee_uuid, leave_type_id, allocation_id, transaction_type,
   credited_days, debited_days, previous_balance, updated_balance, reason)
SELECT employee_uuid, leave_type_id, id, 'opening_balance',
       remaining_days, 0, 0, remaining_days,
       CONCAT('Legacy allocation snapshot; allocated=', allocated_days,
              ', used=', used_days, ', remaining=', remaining_days)
FROM employee_leave_allocations;

-- Rollback guidance (only if this migration has not yet been used):
-- DROP TABLE leave_balance_ledger;
-- ALTER TABLE employee_leave_allocations
--   MODIFY COLUMN used_days INT NOT NULL DEFAULT 0,
--   MODIFY COLUMN remaining_days INT NOT NULL DEFAULT 0;
-- ALTER TABLE leave_requests
--   DROP COLUMN cancelled_at, DROP COLUMN cancelled_by,
--   DROP COLUMN approved_days, DROP COLUMN day_portion,
--   MODIFY COLUMN status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending';
