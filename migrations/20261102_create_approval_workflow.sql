-- 2026-11-02 — Generic multi-step approval workflow
--
-- WHY THIS EXISTS. Six of the fourteen HR modules introduced by the expansion
-- need a submit → review → decide chain: Expense Claims, Travel Requests,
-- Leave (policy-driven escalation), Recruitment Offers, Separations and Help
-- Desk escalation. Written per module, that is the same state machine six
-- times: a status column that drifts between implementations, no record of WHO
-- approved WHAT at WHICH step, and no way to answer "who signed off on this?"
-- six months later.
--
-- So the state machine lives here ONCE, driven by data (workflow_definitions +
-- workflow_steps). Each module keeps its OWN domain table and points at this one
-- through (entity_type, entity_uuid). The engine never writes to the domain
-- table; the module's controller subscribes to the resolved state.
--
-- `approval_step_history` is append-only: rows are never updated or deleted, so
-- it is a genuine audit trail rather than a denormalised status cache.

-- ---------------------------------------------------------------------------
-- 1. workflow_definitions — one active chain per (org, module, entity type)
-- ---------------------------------------------------------------------------
-- organization_id is NOT NULL on purpose. A nullable column here would break
-- uk_workflow_definitions_org: MySQL treats every NULL as distinct in a UNIQUE
-- index, so "platform-wide template" rows could be inserted without limit and
-- the uniqueness guarantee would silently evaporate. Organizations that have not
-- configured a chain are handled by the service synthesising a single
-- org_admin step at request time, which needs no stored row at all.
CREATE TABLE IF NOT EXISTS `workflow_definitions` (
  `id`              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `uuid`            CHAR(36) NOT NULL,
  `organization_id` BIGINT UNSIGNED NOT NULL,
  `module_key`      VARCHAR(60) NOT NULL,
  `entity_type`     VARCHAR(60) NOT NULL,
  `name`            VARCHAR(120) NOT NULL,
  `description`     TEXT NULL,
  `is_active`       TINYINT(1) NOT NULL DEFAULT 1,
  `is_default`      TINYINT(1) NOT NULL DEFAULT 0,
  `created_by_uuid` CHAR(36) NULL,
  `created_at`      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_workflow_definitions_uuid` (`uuid`),
  UNIQUE KEY `uk_workflow_definitions_org` (`organization_id`, `module_key`, `entity_type`),
  INDEX `idx_workflow_definitions_org` (`organization_id`),
  CONSTRAINT `fk_workflow_definitions_org`
    FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_workflow_definitions_creator`
    FOREIGN KEY (`created_by_uuid`) REFERENCES `users` (`uuid`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 2. workflow_steps — the ordered approvers of one definition
-- ---------------------------------------------------------------------------
-- approver_uuid is only meaningful for approver_type='specific_user'; the
-- service rejects that combination rather than letting a step silently resolve
-- to nobody. 'reporting_manager' resolves through employees.linked_user_uuid at
-- decision time, which is why it needs no stored pointer.
CREATE TABLE IF NOT EXISTS `workflow_steps` (
  `id`                 BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `uuid`               CHAR(36) NOT NULL,
  `workflow_id`        BIGINT UNSIGNED NOT NULL,
  `step_order`         SMALLINT UNSIGNED NOT NULL,
  `name`               VARCHAR(120) NOT NULL,
  `approver_type`      ENUM('org_admin','sub_admin','specific_user','reporting_manager') NOT NULL,
  `approver_uuid`      CHAR(36) NULL,
  `required_approvals` SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  `created_at`         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_workflow_steps_uuid` (`uuid`),
  UNIQUE KEY `uk_workflow_steps_order` (`workflow_id`, `step_order`),
  CONSTRAINT `fk_workflow_steps_workflow`
    FOREIGN KEY (`workflow_id`) REFERENCES `workflow_definitions` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_workflow_steps_approver`
    FOREIGN KEY (`approver_uuid`) REFERENCES `users` (`uuid`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 3. approval_requests — one in-flight approval per entity
-- ---------------------------------------------------------------------------
-- WHY THE GENERATED COLUMN. The rule is "an entity cannot have two approvals in
-- flight at once", but it must still be possible to approve, get rejected, and
-- resubmit the same entity — so a plain UNIQUE (entity_type, entity_uuid) would
-- be wrong, and MySQL has no partial/filtered unique index to express it.
--
-- `live_entity_uuid` carries the entity uuid ONLY while status='pending', and is
-- NULL once resolved. NULLs never collide in a MySQL unique index, so this
-- allows unlimited resolved history per entity while making a second concurrent
-- pending request impossible at the database level — not merely by an
-- application-level check that a race could bypass.
--
-- The UNIQUE violation surfaces as ER_DUP_ENTRY (errno 1062), which the service
-- catches and converts into a 409 with a readable message.
CREATE TABLE IF NOT EXISTS `approval_requests` (
  `id`                 BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `uuid`               CHAR(36) NOT NULL,
  `organization_id`    BIGINT UNSIGNED NOT NULL,
  `workflow_id`        BIGINT UNSIGNED NOT NULL,
  `module_key`         VARCHAR(60) NOT NULL,
  `entity_type`        VARCHAR(60) NOT NULL,
  `entity_uuid`        CHAR(36) NOT NULL,
  `current_step_order` SMALLINT UNSIGNED NULL,
  `status`             ENUM('pending','approved','rejected','cancelled') NOT NULL DEFAULT 'pending',
  `title`              VARCHAR(200) NULL,
  `payload`            JSON NULL,
  `requested_by_uuid`  CHAR(36) NOT NULL,
  `requested_at`       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `resolved_at`        DATETIME NULL,
  `resolved_by_uuid`   CHAR(36) NULL,
  `outcome_notes`      TEXT NULL,
  `live_entity_uuid`   CHAR(36)
    GENERATED ALWAYS AS (CASE WHEN `status` = 'pending' THEN `entity_uuid` ELSE NULL END) STORED,
  UNIQUE KEY `uk_approval_requests_uuid` (`uuid`),
  UNIQUE KEY `uk_approval_requests_one_live` (`organization_id`, `entity_type`, `live_entity_uuid`),
  INDEX `idx_approval_requests_entity` (`organization_id`, `entity_type`, `entity_uuid`),
  INDEX `idx_approval_requests_pending` (`organization_id`, `status`, `current_step_order`),
  INDEX `idx_approval_requests_requester` (`requested_by_uuid`),
  CONSTRAINT `fk_approval_requests_org`
    FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_approval_requests_workflow`
    FOREIGN KEY (`workflow_id`) REFERENCES `workflow_definitions` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_approval_requests_requester`
    FOREIGN KEY (`requested_by_uuid`) REFERENCES `users` (`uuid`) ON DELETE CASCADE,
  CONSTRAINT `fk_approval_requests_resolver`
    FOREIGN KEY (`resolved_by_uuid`) REFERENCES `users` (`uuid`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 4. approval_step_history — append-only audit of every transition
-- ---------------------------------------------------------------------------
-- 'skipped' and 'forwarded' exist so an auto-advanced or bypassed step leaves a
-- visible trace. Without them a skipped step is simply absent from the trail and
-- the history silently disagrees with the workflow.
CREATE TABLE IF NOT EXISTS `approval_step_history` (
  `id`                    BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `uuid`                  CHAR(36) NOT NULL,
  `approval_request_uuid` CHAR(36) NOT NULL,
  `step_id`               BIGINT UNSIGNED NULL,
  `step_order`            SMALLINT UNSIGNED NOT NULL,
  `step_name`             VARCHAR(120) NOT NULL,
  `approver_uuid`         CHAR(36) NULL,
  `approver_name`         VARCHAR(150) NULL,
  `decision`              ENUM('pending','approved','rejected','skipped','cancelled','forwarded') NOT NULL,
  `comments`              TEXT NULL,
  `acted_at`              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_approval_step_history_uuid` (`uuid`),
  INDEX `idx_approval_step_history_request` (`approval_request_uuid`, `step_order`, `acted_at`),
  INDEX `idx_approval_step_history_approver` (`approver_uuid`),
  CONSTRAINT `fk_approval_step_history_request`
    FOREIGN KEY (`approval_request_uuid`) REFERENCES `approval_requests` (`uuid`) ON DELETE CASCADE,
  CONSTRAINT `fk_approval_step_history_step`
    FOREIGN KEY (`step_id`) REFERENCES `workflow_steps` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_approval_step_history_approver`
    FOREIGN KEY (`approver_uuid`) REFERENCES `users` (`uuid`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- UUID triggers (house convention: every table gets one)
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS `bi_workflow_definitions_uuid`;
DELIMITER $$
CREATE TRIGGER `bi_workflow_definitions_uuid`
BEFORE INSERT ON `workflow_definitions`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END$$
DELIMITER ;

DROP TRIGGER IF EXISTS `bi_workflow_steps_uuid`;
DELIMITER $$
CREATE TRIGGER `bi_workflow_steps_uuid`
BEFORE INSERT ON `workflow_steps`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END$$
DELIMITER ;

DROP TRIGGER IF EXISTS `bi_approval_requests_uuid`;
DELIMITER $$
CREATE TRIGGER `bi_approval_requests_uuid`
BEFORE INSERT ON `approval_requests`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END$$
DELIMITER ;

DROP TRIGGER IF EXISTS `bi_approval_step_history_uuid`;
DELIMITER $$
CREATE TRIGGER `bi_approval_step_history_uuid`
BEFORE INSERT ON `approval_step_history`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END$$
DELIMITER ;

-- Apply with:
--   RUN_ONLY=20261102_create_approval_workflow.sql node migrations/run.mjs