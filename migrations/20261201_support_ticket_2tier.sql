-- Support tickets: FlowHCM-style 2-tier routing.
--
-- Tier 1: employee / sub_admin -> their Organization Admin (org_admin)
-- Tier 2: Organization Admin  -> System Admin (system_admin)
--
-- Dynamic SQL is used for the column additions because MySQL does not support
-- `ADD COLUMN IF NOT EXISTS` while MariaDB does. This keeps the migration
-- idempotent on both, and lets a fresh database (whose 20261126 full schema
-- already contains these columns) skip the ALTERs safely.

SET @add_category = IF(
  EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'support_tickets'
       AND COLUMN_NAME = 'category'
  ),
  'SELECT 1',
  'ALTER TABLE `support_tickets` ADD COLUMN `category` ENUM(''it'',''hr'',''admin'',''payroll'') NOT NULL DEFAULT ''it'' AFTER `description`'
);
PREPARE add_category_stmt FROM @add_category;
EXECUTE add_category_stmt;
DEALLOCATE PREPARE add_category_stmt;

SET @had_assigned_role = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'support_tickets'
     AND COLUMN_NAME = 'assigned_to_role'
);
SET @add_assigned_role = IF(
  @had_assigned_role > 0,
  'SELECT 1',
  'ALTER TABLE `support_tickets` ADD COLUMN `assigned_to_role` ENUM(''org_admin'',''system_admin'') NOT NULL DEFAULT ''org_admin'' AFTER `priority`'
);
PREPARE add_assigned_role_stmt FROM @add_assigned_role;
EXECUTE add_assigned_role_stmt;
DEALLOCATE PREPARE add_assigned_role_stmt;

SET @add_assigned_to = IF(
  EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'support_tickets'
       AND COLUMN_NAME = 'assigned_to_uuid'
  ),
  'SELECT 1',
  'ALTER TABLE `support_tickets` ADD COLUMN `assigned_to_uuid` CHAR(36) DEFAULT NULL AFTER `assigned_to_role`'
);
PREPARE add_assigned_to_stmt FROM @add_assigned_to;
EXECUTE add_assigned_to_stmt;
DEALLOCATE PREPARE add_assigned_to_stmt;

SET @add_category_idx = IF(
  EXISTS(
    SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'support_tickets'
       AND INDEX_NAME = 'idx_support_tickets_category'
  ),
  'SELECT 1',
  'ALTER TABLE `support_tickets` ADD KEY `idx_support_tickets_category` (`category`)'
);
PREPARE add_category_idx_stmt FROM @add_category_idx;
EXECUTE add_category_idx_stmt;
DEALLOCATE PREPARE add_category_idx_stmt;

SET @add_role_idx = IF(
  EXISTS(
    SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'support_tickets'
       AND INDEX_NAME = 'idx_support_tickets_assigned_role'
  ),
  'SELECT 1',
  'ALTER TABLE `support_tickets` ADD KEY `idx_support_tickets_assigned_role` (`assigned_to_role`)'
);
PREPARE add_role_idx_stmt FROM @add_role_idx;
EXECUTE add_role_idx_stmt;
DEALLOCATE PREPARE add_role_idx_stmt;

-- Backfill existing rows from the raiser's role so old tickets land in the
-- correct tier immediately after the upgrade. Guarded on the column having just
-- been created: a re-run must not reclassify a ticket whose raiser was promoted
-- to org_admin after it was raised.
SET @backfill_assigned_role = IF(
  @had_assigned_role > 0,
  'SELECT 1',
  'UPDATE `support_tickets` t JOIN `users` u ON u.`uuid` = t.`raised_by_uuid` SET t.`assigned_to_role` = IF(u.`org_role` = ''org_admin'', ''system_admin'', ''org_admin'')'
);
PREPARE backfill_assigned_role_stmt FROM @backfill_assigned_role;
EXECUTE backfill_assigned_role_stmt;
DEALLOCATE PREPARE backfill_assigned_role_stmt;
