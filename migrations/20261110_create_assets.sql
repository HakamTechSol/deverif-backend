-- 2026-11-10 — Assets: categories, inventory, assignments, maintenance
--
-- WHY. Asset tracking is the one inventory system that still lives entirely in
-- spreadsheets, and spreadsheets lose. Nobody can answer "who has the laptop
-- that was bought in March" without asking three people, an asset goes missing
-- with no record of it ever existing, and a maintenance bill gets paid against
-- no asset at all. The cost is not the purchase price, it is the write-offs.
--
-- THE CENTRAL INVARIANT. An asset has AT MOST ONE open assignment, AT MOST ONE
-- open maintenance job, and a status that is a function of those two, never
-- independently edited. Everything below is arranged to make an illegal state
-- unrepresentable rather than merely discouraged, because a status you can type
-- by hand will eventually contradict the rows beside it.
--
-- WHY STATUS IS NOT ENUMERATED-FREE. status is deliberately an ENUM so the
-- database refuses a value nobody designed for. The alternative (a lookup table
-- admins can extend) looks more flexible and in practice produces six statuses,
-- two of them misspelled, within a year.

-- ---------------------------------------------------------------------------
-- 1. asset_categories — reusable, per organization
-- ---------------------------------------------------------------------------
-- Not platform-scoped: "Vehicles" means a different inventory policy to a
-- software company than to a logistics firm, and category-level reporting
-- (depreciation by class) must not mix across organizations sharing a plan.
--
-- `is_active` rather than DELETE, because an asset must keep pointing at its
-- category forever; deleting the category would either orphan the asset or
-- cascade away a purchase history.
CREATE TABLE IF NOT EXISTS `asset_categories` (
  `id`              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `uuid`            CHAR(36) NOT NULL,
  `organization_id` BIGINT UNSIGNED NOT NULL,
  `name`            VARCHAR(120) NOT NULL,
  `description`     VARCHAR(500) DEFAULT NULL,
  -- Optional accounting hint. NULL means "no useful default", which is
  -- different from 0 and must stay distinguishable.
  `default_lifespan_months` INT UNSIGNED DEFAULT NULL,
  `is_active`       TINYINT(1) NOT NULL DEFAULT 1,
  `created_by_uuid` CHAR(36) DEFAULT NULL,
  `created_at`      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_asset_categories_uuid` (`uuid`),
  UNIQUE KEY `uk_asset_categories_org_name` (`organization_id`, `name`),
  -- Composite unique targeting the (category_uuid, organization_id) FK on
  -- `assets`, which is what makes it impossible for an asset to sit in one
  -- organization while pointing at another organization's category. MySQL can
  -- only reference columns that are the subject of a unique key.
  UNIQUE KEY `uk_asset_categories_uuid_org` (`uuid`, `organization_id`),
  INDEX `idx_asset_categories_org` (`organization_id`, `is_active`),
  CONSTRAINT `fk_asset_categories_org`
    FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_asset_categories_creator`
    FOREIGN KEY (`created_by_uuid`) REFERENCES `users` (`uuid`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 2. assets — the inventory item
-- ---------------------------------------------------------------------------
-- asset_tag is the human identifier ("AST-0042") and is unique PER ORG, not
-- globally: two companies both starting at AST-0001 is normal, and a global
-- unique constraint would force meaningless prefixes onto one of them.
-- serial_number is NOT unique — manufacturers reuse serials across model years
-- and reissue them, so a duplicate here is a data-entry error to warn about, not
-- a constraint to enforce. It is indexed for lookup only.
--
-- status is maintained by the service from the assignment/maintenance rows and
-- must never be set directly by a client.
CREATE TABLE IF NOT EXISTS `assets` (
  `id`              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `uuid`            CHAR(36) NOT NULL,
  `organization_id` BIGINT UNSIGNED NOT NULL,
  `category_uuid`   CHAR(36) NOT NULL,
  `asset_tag`       VARCHAR(40) NOT NULL,
  `name`            VARCHAR(200) NOT NULL,
  -- Freeform manufacturer + model, kept as one string because every register
  -- asks for it that way and splitting it invents fields nobody uses.
  `model_details`   VARCHAR(200) DEFAULT NULL,
  `serial_number`   VARCHAR(120) DEFAULT NULL,
  `purchase_date`   DATE DEFAULT NULL,
  `purchase_cost`   DECIMAL(12,2) DEFAULT NULL,
  `vendor`          VARCHAR(200) DEFAULT NULL,
  -- Purchase receipt / invoice image. A relative path under ATTACHMENTS_DIR,
  -- never a caller-supplied absolute path.
  `receipt_path`    VARCHAR(500) DEFAULT NULL,
  `warranty_expires_at` DATE DEFAULT NULL,
  `status`          ENUM('available','assigned','maintenance','retired') NOT NULL DEFAULT 'available',
  `notes`           TEXT NULL,
  `created_by_uuid` CHAR(36) DEFAULT NULL,
  `created_at`      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_assets_uuid` (`uuid`),
  UNIQUE KEY `uk_assets_org_tag` (`organization_id`, `asset_tag`),
  INDEX `idx_assets_org_status` (`organization_id`, `status`),
  INDEX `idx_assets_category` (`category_uuid`),
  INDEX `idx_assets_serial` (`organization_id`, `serial_number`),
  INDEX `idx_assets_purchase_date` (`organization_id`, `purchase_date`),
  CONSTRAINT `fk_assets_org`
    FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE,
  -- ON DELETE CASCADE, see 20261110c for why RESTRICT is not an option here:
-- it makes organization deletion impossible. The protective guard (refuse to
-- delete a category that still holds assets) lives in the service instead.
CONSTRAINT `fk_assets_category`
    FOREIGN KEY (`category_uuid`, `organization_id`)
    REFERENCES `asset_categories` (`uuid`, `organization_id`) ON DELETE CASCADE,
  CONSTRAINT `fk_assets_creator`
    FOREIGN KEY (`created_by_uuid`) REFERENCES `users` (`uuid`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 3. asset_assignments — the custody history
-- ---------------------------------------------------------------------------
-- Append-only HISTORY, not a pointer on the asset. An asset is handed out and
-- taken back many times, and the only way to answer "who had this in June" is to
-- have kept every row. `returned_at IS NULL` means currently held.
--
-- The partial-uniqueness trick below is what actually enforces "at most one
-- holder": MySQL has no filtered indexes, but a generated column that is NULL
-- once returned, inside a UNIQUE key, is the standard workaround. The asset is
-- the left column so the guarantee is PER ASSET rather than per employee — an
-- employee holding two laptops is normal and must be allowed.
ALTER TABLE `assets`
  ADD COLUMN `active_assignment_guard` CHAR(36)
    GENERATED ALWAYS AS (CASE WHEN `status` = 'assigned' THEN `uuid` ELSE NULL END) STORED,
  ADD UNIQUE KEY `uk_assets_single_holder` (`active_assignment_guard`);

CREATE TABLE IF NOT EXISTS `asset_assignments` (
  `id`              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `uuid`            CHAR(36) NOT NULL,
  `organization_id` BIGINT UNSIGNED NOT NULL,
  `asset_uuid`      CHAR(36) NOT NULL,
  `employee_uuid`   CHAR(36) NOT NULL,
  `assigned_by_uuid` CHAR(36) DEFAULT NULL,
  `assigned_at`     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- NULL while the asset is still held. Set on return.
  `returned_at`     DATETIME DEFAULT NULL,
  `returned_to_uuid` CHAR(36) DEFAULT NULL,
  -- Condition at return is the point of the field: "returned, minor scratches"
  -- vs "returned, screen cracked" decides whether maintenance follows.
  `return_condition` ENUM('good','damaged','needs_maintenance') DEFAULT NULL,
  `return_notes`    VARCHAR(500) DEFAULT NULL,
  -- Generated guard for the open-assignment unique key below.
  --
  -- THE OBVIOUS KEY IS WRONG, and was verified wrong: (asset_uuid, returned_at)
  -- does NOT enforce "at most one holder", because an open row has
  -- returned_at = NULL and NULLs do not collide in a MySQL UNIQUE index. Two
  -- open assignments for one asset were both accepted against exactly that key.
  -- So the guard is a non-NULL constant while the row is open, mirroring
  -- `open_job_guard` on asset_maintenance, which does enforce its invariant.
  `open_assignment_guard` TINYINT GENERATED ALWAYS AS
                       (CASE WHEN `returned_at` IS NULL THEN 1 ELSE NULL END) STORED,
  `created_at`      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_asset_assignments_uuid` (`uuid`),
  -- One open assignment per asset. Every closed row yields NULL here, so the
  -- entire returned history is unconstrained and only the open row must be
  -- unique.
  UNIQUE KEY `uk_asset_assignments_open` (`asset_uuid`, `open_assignment_guard`),
  INDEX `idx_asset_assignments_employee` (`organization_id`, `employee_uuid`),
  INDEX `idx_asset_assignments_asset` (`asset_uuid`, `assigned_at`),
  CONSTRAINT `fk_asset_assignments_org`
    FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_asset_assignments_asset`
    FOREIGN KEY (`asset_uuid`) REFERENCES `assets` (`uuid`) ON DELETE CASCADE,
  CONSTRAINT `fk_asset_assignments_employee`
    FOREIGN KEY (`employee_uuid`) REFERENCES `employees` (`uuid`) ON DELETE CASCADE,
  CONSTRAINT `fk_asset_assignments_assigner`
    FOREIGN KEY (`assigned_by_uuid`) REFERENCES `users` (`uuid`) ON DELETE SET NULL,
  CONSTRAINT `fk_asset_assignments_returner`
    FOREIGN KEY (`returned_to_uuid`) REFERENCES `users` (`uuid`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 4. asset_maintenance — the repair history
-- ---------------------------------------------------------------------------
-- Same append-only shape as assignments: `completed_at IS NULL` means an open job,
-- so at most one job per asset at a time (enforced below).
--
-- cost is the amount actually paid, distinct from any estimate, because the
-- difference between the two is precisely what asset registers get wrong.
CREATE TABLE IF NOT EXISTS `asset_maintenance` (
  `id`              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `uuid`            CHAR(36) NOT NULL,
  `organization_id` BIGINT UNSIGNED NOT NULL,
  `asset_uuid`      CHAR(36) NOT NULL,
  `title`           VARCHAR(200) NOT NULL,
  `description`     TEXT NULL,
  `status`          ENUM('open','completed','cancelled') NOT NULL DEFAULT 'open',
  `vendor`          VARCHAR(200) DEFAULT NULL,
  `cost`            DECIMAL(12,2) DEFAULT NULL,
  -- Invoice image for the work done. Relative path only, as with receipt_path.
  `invoice_path`    VARCHAR(500) DEFAULT NULL,
  `reported_by_uuid` CHAR(36) DEFAULT NULL,
  `reported_at`     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `completed_at`    DATETIME DEFAULT NULL,
  `completed_by_uuid` CHAR(36) DEFAULT NULL,
  `completion_notes` TEXT NULL,
  -- Generated guard for the open-job unique key below. MUST be declared in the
  -- CREATE TABLE: an index cannot reference a column added by a later ALTER.
  -- Yields 1 while the job is open and NULL once it is closed, and NULLs do not
  -- collide in a MySQL UNIQUE key — so exactly one open job per asset is
  -- permitted and the entire completed history is unconstrained.
  `open_job_guard`  TINYINT GENERATED ALWAYS AS
                       (CASE WHEN `status` = 'open' THEN 1 ELSE NULL END) STORED,
  `created_at`      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_asset_maintenance_uuid` (`uuid`),
  UNIQUE KEY `uk_asset_maintenance_open` (`asset_uuid`, `open_job_guard`),
  INDEX `idx_asset_maintenance_org` (`organization_id`, `status`),
  INDEX `idx_asset_maintenance_asset` (`asset_uuid`, `reported_at`),
  CONSTRAINT `fk_asset_maintenance_org`
    FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_asset_maintenance_asset`
    FOREIGN KEY (`asset_uuid`) REFERENCES `assets` (`uuid`) ON DELETE CASCADE,
  CONSTRAINT `fk_asset_maintenance_reporter`
    FOREIGN KEY (`reported_by_uuid`) REFERENCES `users` (`uuid`) ON DELETE SET NULL,
  CONSTRAINT `fk_asset_maintenance_finisher`
    FOREIGN KEY (`completed_by_uuid`) REFERENCES `users` (`uuid`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- UUID triggers (house convention)
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS `bi_asset_categories_uuid`;
DELIMITER $$
CREATE TRIGGER `bi_asset_categories_uuid`
BEFORE INSERT ON `asset_categories`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END$$
DELIMITER ;

DROP TRIGGER IF EXISTS `bi_assets_uuid`;
DELIMITER $$
CREATE TRIGGER `bi_assets_uuid`
BEFORE INSERT ON `assets`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END$$
DELIMITER ;

DROP TRIGGER IF EXISTS `bi_asset_assignments_uuid`;
DELIMITER $$
CREATE TRIGGER `bi_asset_assignments_uuid`
BEFORE INSERT ON `asset_assignments`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END$$
DELIMITER ;

DROP TRIGGER IF EXISTS `bi_asset_maintenance_uuid`;
DELIMITER $$
CREATE TRIGGER `bi_asset_maintenance_uuid`
BEFORE INSERT ON `asset_maintenance`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END$$
DELIMITER ;

-- Apply with:
--   RUN_ONLY=20261110_create_assets.sql node migrations/run.mjs