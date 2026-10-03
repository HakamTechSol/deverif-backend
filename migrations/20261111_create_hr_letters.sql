-- 2026-11-11 — HR Letters: templates and issued letters
--
-- WHY. Offer, increment, experience and confirmation letters are the documents
-- an HR department is asked for most often, and today they are Word files made
-- by hand. Beyond the manual work, they are unauthenticated: a PDF emailed by
-- anyone can be presented as genuine. These letters carry a QR the holder — or
-- a bank, an embassy, a background checker — can scan to confirm issuer, person
-- and issue date against Dverif's own records. That turns a template into the
-- platform's core proposition applied to HR paperwork.
--
-- letter_templates holds the reusable body with $merge_tags; hr_letters holds
-- one issued instance per employee.

-- ---------------------------------------------------------------------------
-- 1. letter_templates — reusable, per organization
-- ---------------------------------------------------------------------------
-- Organization-scoped, NOT platform-scoped: letter wording is legally and
-- culturally specific ("Dear Mr." vs "Dear Ms." vs "Dear Sir/Madam"), so
-- templates must not leak between organizations even though they share a plan.
--
-- `merge_fields` is the machine-readable list of tags the body may use. Storing
-- it separately from the body lets the UI offer a tag picker and lets issuance
-- reject a body referencing a tag it has no value for, instead of silently
-- printing a literal "$designation" onto a letter given to an employee.
CREATE TABLE IF NOT EXISTS `letter_templates` (
  `id`              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `uuid`            CHAR(36) NOT NULL,
  `organization_id` BIGINT UNSIGNED NOT NULL,
  `letter_type`     ENUM('offer','increment','experience','employment_confirmation',
                         'warning','appreciation','custom') NOT NULL DEFAULT 'custom',
  `name`            VARCHAR(120) NOT NULL,
  `body`            LONGTEXT NOT NULL,
  `merge_fields`    JSON NULL,
  `is_active`       TINYINT(1) NOT NULL DEFAULT 1,
  `created_by_uuid` CHAR(36) DEFAULT NULL,
  `created_at`      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_letter_templates_uuid` (`uuid`),
  UNIQUE KEY `uk_letter_templates_org_name` (`organization_id`, `name`),
  INDEX `idx_letter_templates_org` (`organization_id`, `letter_type`, `is_active`),
  CONSTRAINT `fk_letter_templates_org`
    FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_letter_templates_creator`
    FOREIGN KEY (`created_by_uuid`) REFERENCES `users` (`uuid`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 2. hr_letters — one issued letter per employee
-- ---------------------------------------------------------------------------
-- body_snapshot IS THE POINT. An employee keeps this letter for years and
-- presents it to a bank or an employer. If rendering happened at PDF-download
-- time from the CURRENT template, correcting a template's wording would silently
-- rewrite the wording of every letter already handed out — and a salary
-- increment letter whose numbers no longer match its snapshot is worse than no
-- letter at all. So the merged text is frozen at issue time and is what the QR
-- attests to.
--
-- qr_token / qr_signature exist only for ISSUED letters. A draft has nothing to
-- attest to, and populating them early would publish a verifiable URL for a
-- document nobody has issued yet.
--
-- reference_no is unique per organization so it can be quoted in correspondence
-- ("your letter ref HR/2026/0007") without ambiguity.
CREATE TABLE IF NOT EXISTS `hr_letters` (
  `id`              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `uuid`            CHAR(36) NOT NULL,
  `organization_id` BIGINT UNSIGNED NOT NULL,
  `employee_uuid`   CHAR(36) NOT NULL,
  `template_uuid`   CHAR(36) DEFAULT NULL,
  `letter_type`     ENUM('offer','increment','experience','employment_confirmation',
                         'warning','appreciation','custom') NOT NULL DEFAULT 'custom',
  `reference_no`    VARCHAR(40) NOT NULL,
  `title`           VARCHAR(200) NOT NULL,
  -- The merge values used, kept for audit: "what did we tell them, and from
  -- what inputs" stays answerable even after the employee row changes.
  `payload`         JSON NULL,
  -- Rendered, merged text frozen at issue time. Never recomputed.
  `body_snapshot`   LONGTEXT NULL,
  `file_path`       VARCHAR(500) DEFAULT NULL,
  `qr_token`        CHAR(64) DEFAULT NULL,
  `qr_signature`    CHAR(64) DEFAULT NULL,
  `status`          ENUM('draft','issued','revoked') NOT NULL DEFAULT 'draft',
  `issued_by_uuid`  CHAR(36) DEFAULT NULL,
  `issued_at`       DATETIME DEFAULT NULL,
  `revoked_at`      DATETIME DEFAULT NULL,
  `revoked_reason`  VARCHAR(500) DEFAULT NULL,
  `notes`           TEXT NULL,
  `created_at`      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_hr_letters_uuid` (`uuid`),
  UNIQUE KEY `uk_hr_letters_reference` (`organization_id`, `reference_no`),
  -- Partial-uniqueness trick: a revoked letter frees its number for reuse,
  -- while two issued letters can never share one.
  UNIQUE KEY `uk_hr_letters_qr_token` (`qr_token`),
  INDEX `idx_hr_letters_entity` (`organization_id`, `letter_type`, `status`),
  INDEX `idx_hr_letters_employee` (`employee_uuid`),
  INDEX `idx_hr_letters_qr` (`qr_token`),
  CONSTRAINT `fk_hr_letters_org`
    FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_hr_letters_employee`
    FOREIGN KEY (`employee_uuid`) REFERENCES `employees` (`uuid`) ON DELETE CASCADE,
  CONSTRAINT `fk_hr_letters_template`
    FOREIGN KEY (`template_uuid`) REFERENCES `letter_templates` (`uuid`) ON DELETE SET NULL,
  CONSTRAINT `fk_hr_letters_issuer`
    FOREIGN KEY (`issued_by_uuid`) REFERENCES `users` (`uuid`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- UUID triggers (house convention)
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS `bi_letter_templates_uuid`;
DELIMITER $$
CREATE TRIGGER `bi_letter_templates_uuid`
BEFORE INSERT ON `letter_templates`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END$$
DELIMITER ;

DROP TRIGGER IF EXISTS `bi_hr_letters_uuid`;
DELIMITER $$
CREATE TRIGGER `bi_hr_letters_uuid`
BEFORE INSERT ON `hr_letters`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END$$
DELIMITER ;

-- Apply with:
--   RUN_ONLY=20261111_create_hr_letters.sql node migrations/run.mjs