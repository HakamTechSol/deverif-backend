-- 2026-11-03 — Generic entity attachments
--
-- WHY THIS EXISTS. Five modules introduced by the expansion need files attached
-- to a row they own: expense receipts, asset purchase invoices, onboarding
-- documents, training certificates and travel tickets. Each module previously
-- grew its own `<thing>_documents` table plus its own upload/delete endpoints,
-- which is how `employee_documents` ended up with a hand-rolled upload path
-- that no other module could reuse.
--
-- So attachments are polymorphic: one table, pointed at whatever owns the file
-- by (entity_type, entity_uuid). A module keeps its own domain row and never
-- grows a file column.
--
-- WHY entity_uuid HAS NO FOREIGN KEY. It references a different table per
-- entity_type (expense_claims, assets, onboarding_instances, ...), so a real FK
-- is impossible. Tenant isolation is therefore enforced in two places instead of
-- one: organization_id is NOT NULL and indexed, and every query in
-- services/attachments.service.js filters on it. That is a deliberate trade --
-- the DB cannot enforce "this uuid belongs to that org's expense_claim", so the
-- service is the enforcement point and tests/attachments.test.js pins it.
--
-- Rows are soft-deleted (deleted_at) rather than removed. A file whose row is
-- gone is unrecoverable, and an audit trail that quietly drops evidence is
-- worse than one that keeps a tombstone.

CREATE TABLE IF NOT EXISTS `attachments` (
  `id`              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `uuid`            CHAR(36) NOT NULL,
  `organization_id` BIGINT UNSIGNED NOT NULL,
  -- Namespaced free-form owner reference, e.g. 'expense_claim', 'asset',
  -- 'onboarding_task', 'training_certificate', 'travel_itinerary'.
  `entity_type`     VARCHAR(60) NOT NULL,
  `entity_uuid`     CHAR(36) NOT NULL,
  `file_name`       VARCHAR(255) NOT NULL,
  -- Stored relative to config/uploadPaths ATTACHMENTS_DIR, never as an
  -- absolute path: an absolute path breaks the moment the app moves, and it
  -- turns a path leak into a filesystem-read primitive.
  `file_path`       VARCHAR(500) NOT NULL,
  `mime_type`       VARCHAR(120) DEFAULT NULL,
  `file_size`       BIGINT UNSIGNED NOT NULL DEFAULT 0,
  -- Sub-classification within the entity, e.g. 'receipt', 'invoice',
  -- 'identity_document', 'certificate'.
  `category`        VARCHAR(40) DEFAULT NULL,
  `description`     VARCHAR(500) DEFAULT NULL,
  `uploaded_by_uuid` CHAR(36) DEFAULT NULL,
  `created_at`      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `deleted_at`      DATETIME DEFAULT NULL,
  UNIQUE KEY `uk_attachments_uuid` (`uuid`),
  INDEX `idx_attachments_entity` (`organization_id`, `entity_type`, `entity_uuid`),
  INDEX `idx_attachments_uploader` (`uploaded_by_uuid`),
  INDEX `idx_attachments_category` (`organization_id`, `entity_type`, `category`),
  CONSTRAINT `fk_attachments_org`
    FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_attachments_uploader`
    FOREIGN KEY (`uploaded_by_uuid`) REFERENCES `users` (`uuid`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP TRIGGER IF EXISTS `bi_attachments_uuid`;
DELIMITER $$
CREATE TRIGGER `bi_attachments_uuid`
BEFORE INSERT ON `attachments`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END$$
DELIMITER ;

-- Apply with:
--   RUN_ONLY=20261103_create_attachments.sql node migrations/run.mjs