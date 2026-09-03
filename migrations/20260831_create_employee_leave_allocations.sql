-- employee_leave_allocations: per-employee, per-leave-type, per-year leave
-- balances. Allocation is INDIVIDUAL (not an org-wide default). Each year keeps
-- its own permanent rows — previous years are never overwritten or reset; a new
-- year requires (re)allocating fresh balances (manually, or via the bulk
-- "copy last year" helper).
CREATE TABLE IF NOT EXISTS employee_leave_allocations (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  uuid           CHAR(36) NOT NULL,
  employee_uuid  CHAR(36) NOT NULL,
  leave_type_id  BIGINT UNSIGNED NOT NULL,
  year           SMALLINT UNSIGNED NOT NULL,
  allocated_days INT NOT NULL DEFAULT 0,
  used_days      INT NOT NULL DEFAULT 0,
  remaining_days INT NOT NULL DEFAULT 0,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_ela (employee_uuid, leave_type_id, year),
  INDEX idx_ela_employee_year (employee_uuid, year),
  CONSTRAINT fk_ela_employee
    FOREIGN KEY (employee_uuid) REFERENCES employees (uuid) ON DELETE CASCADE,
  CONSTRAINT fk_ela_type
    FOREIGN KEY (leave_type_id) REFERENCES leave_types (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP TRIGGER IF EXISTS `bi_employee_leave_allocations_uuid`;
DELIMITER $$
CREATE TRIGGER `bi_employee_leave_allocations_uuid`
BEFORE INSERT ON `employee_leave_allocations`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END$$
DELIMITER ;

-- Backfill: seed each existing employee's CURRENT-year allocation for every
-- leave type their org defines, using the legacy org-level default
-- (days_allowed_per_year) as the starting point so no existing behavior is lost.
-- Idempotent: only employees/types/years with no allocation row yet are seeded.
INSERT INTO employee_leave_allocations
  (uuid, employee_uuid, leave_type_id, year, allocated_days, used_days, remaining_days, created_at)
SELECT UUID(), e.uuid, lt.id, YEAR(CURDATE()),
       lt.days_allowed_per_year,
       0,
       lt.days_allowed_per_year,
       NOW()
FROM employees e
JOIN leave_types lt ON lt.organization_id = e.organization_id
LEFT JOIN employee_leave_allocations ela
       ON ela.employee_uuid = e.uuid
      AND ela.leave_type_id = lt.id
      AND ela.year = YEAR(CURDATE())
WHERE ela.id IS NULL;
