-- Persons: canonical identity records keyed on CNIC.
--
-- cnic_encrypted holds the AES-256-GCM ciphertext (see src/utils/encrypt.js).
-- cnic_hash is the deterministic SHA-256 of the raw/normalized CNIC and is the
-- indexed lookup + matching column, so existence checks never decrypt.

CREATE TABLE IF NOT EXISTS `persons` (
  `id`                bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT,
  `uuid`              char(36) NOT NULL,
  `cnic_encrypted`    varchar(500) NOT NULL,
  `cnic_hash`         char(64) NOT NULL,
  `full_name`         varchar(200) NULL,
  `is_nadra_verified` enum('yes','no') NOT NULL DEFAULT 'no',
  `created_at`        datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_persons_uuid` (`uuid`),
  UNIQUE KEY `uq_persons_cnic_hash` (`cnic_hash`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TRIGGER IF EXISTS `bi_persons_uuid`;
DELIMITER $$
CREATE TRIGGER `bi_persons_uuid`
BEFORE INSERT ON `persons`
FOR EACH ROW
BEGIN
  IF NEW.`uuid` IS NULL OR NEW.`uuid` = '' THEN
    SET NEW.`uuid` = UUID();
  END IF;
END$$
DELIMITER ;
