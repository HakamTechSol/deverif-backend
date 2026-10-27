-- Index employees.email.
--
-- WHY
--     `users.email` is UNIQUE, but `employees.email` had neither a unique
--     constraint nor an index. Two consequences, both now load-bearing:
--
--       1. Correctness. Nothing stopped an employee row and a user row from
--          holding the same address. app/services/employeeAccess.service.js
--          links the two, but the admin user-creation paths did not, so one
--          person could end up as an unlinked employee plus an unrelated login.
--          That is now prevented in code by assertEmailAvailable()
--          (utils/identityUniqueness.js), which queries this column on every
--          user create and update.
--
--       2. Performance. The check already existed in
--          controllers/admin/employees.controller.js ("An employee with this
--          email already exists") and was a full table scan. With the new check
--          added to the user paths, an unindexed lookup would run on every
--          account creation as well.
--
--     Deliberately NOT unique. A unique index here would be the stronger
--     guarantee, but it cannot be added while any two employees share an
--     address, and it would also hard-fail on a legitimate person who is an
--     employee in one organization and a user in another — the case this
--     migration's sibling fix deliberately allows an admin to resolve by hand.
--     The rule is enforced in one place, with a message that says what to do,
--     rather than by a constraint that cannot explain itself.
--
-- IDEMPOTENT
--     MySQL has no CREATE INDEX IF NOT EXISTS, so the existence check is done
--     through information_schema and the ALTER is prepared conditionally. Safe
--     to re-run.

SET @idx_exists := (
  SELECT COUNT(*)
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'employees'
    AND INDEX_NAME = 'idx_employees_email'
);

SET @idx_sql := IF(
  @idx_exists > 0,
  'SELECT 1 AS idx_employees_email_already_exists',
  'ALTER TABLE `employees` ADD INDEX `idx_employees_email` (`email`)'
);

PREPARE idx_stmt FROM @idx_sql;
EXECUTE idx_stmt;
DEALLOCATE PREPARE idx_stmt;