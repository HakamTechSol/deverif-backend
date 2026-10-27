-- Preserve which organization department a support ticket came from.
SET @add_department_column = IF(
  EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'support_tickets'
       AND COLUMN_NAME = 'department_id'
  ),
  'SELECT 1',
  'ALTER TABLE `support_tickets` ADD COLUMN `department_id` int(11) DEFAULT NULL AFTER `organization_id`'
);
PREPARE add_department_column_stmt FROM @add_department_column;
EXECUTE add_department_column_stmt;
DEALLOCATE PREPARE add_department_column_stmt;

SET @add_department_index = IF(
  EXISTS(
    SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'support_tickets'
       AND INDEX_NAME = 'idx_support_tickets_department'
  ),
  'SELECT 1',
  'ALTER TABLE `support_tickets` ADD KEY `idx_support_tickets_department` (`department_id`)'
);
PREPARE add_department_index_stmt FROM @add_department_index;
EXECUTE add_department_index_stmt;
DEALLOCATE PREPARE add_department_index_stmt;

SET @add_department_fk = IF(
  EXISTS(
    SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND TABLE_NAME = 'support_tickets'
       AND CONSTRAINT_NAME = 'fk_support_tickets_department'
       AND CONSTRAINT_TYPE = 'FOREIGN KEY'
  ),
  'SELECT 1',
  'ALTER TABLE `support_tickets` ADD CONSTRAINT `fk_support_tickets_department` FOREIGN KEY (`department_id`) REFERENCES `departments` (`id`) ON DELETE SET NULL'
);
PREPARE add_department_fk_stmt FROM @add_department_fk;
EXECUTE add_department_fk_stmt;
DEALLOCATE PREPARE add_department_fk_stmt;

-- Existing employee-raised tickets can be attributed from their linked user or
-- matching organization email. Keep the department snapshot on the ticket.
UPDATE support_tickets t
JOIN users u ON u.uuid = t.raised_by_uuid
SET t.department_id = (
  SELECT e.department_id
    FROM employees e
   WHERE e.organization_id = t.organization_id
     AND e.department_id IS NOT NULL
     AND (e.linked_user_uuid = u.uuid OR (u.email IS NOT NULL AND e.email = u.email))
   ORDER BY (e.linked_user_uuid = u.uuid) DESC, e.id DESC
   LIMIT 1
)
WHERE t.department_id IS NULL
  AND EXISTS(
    SELECT 1 FROM employees e
     WHERE e.organization_id = t.organization_id
       AND e.department_id IS NOT NULL
       AND (e.linked_user_uuid = u.uuid OR (u.email IS NOT NULL AND e.email = u.email))
  );
