-- Person documents: scanned IDs, certificates, etc. linked to a person.
-- document_hash stores the same SHA-256 hex digest used on
-- verification_requests.document_hash for cross-matching.

CREATE TABLE IF NOT EXISTS `person_documents` (
  `id`                                bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT,
  `uuid`                              char(36) NOT NULL,
  `person_id`                         bigint(20) UNSIGNED NOT NULL,
  `document_type`                     varchar(100) NULL,
  `document_hash`                     varchar(64) NULL,
  `verified_by_organization_id`       bigint(20) UNSIGNED NULL,
  `verified_by_verification_request_id` bigint(20) UNSIGNED NULL,
  `verified_at`                       datetime NULL,
  `status`                            enum('verified','unverified') NOT NULL DEFAULT 'verified',
  `created_at`                        datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE  KEY `uq_person_documents_uuid` (`uuid`),
  KEY     `idx_person_documents_person` (`person_id`),
  KEY     `idx_person_documents_doc_hash` (`document_hash`),
  FOREIGN KEY (`person_id`)                           REFERENCES `persons` (`id`)                    ON DELETE CASCADE,
  FOREIGN KEY (`verified_by_organization_id`)         REFERENCES `organizations` (`id`)              ON DELETE SET NULL,
  FOREIGN KEY (`verified_by_verification_request_id`) REFERENCES `verification_requests` (`id`)      ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TRIGGER IF EXISTS `bi_person_documents_uuid`;
DELIMITER $$
CREATE TRIGGER `bi_person_documents_uuid`
BEFORE INSERT ON `person_documents`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END$$
DELIMITER ;
