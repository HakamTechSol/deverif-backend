-- Single-use password-reset tokens for System Admin accounts.
-- Completely separate from password_reset_tokens (which is user-only) so the
-- admin forgot-password flow never shares state with regular users.

CREATE TABLE IF NOT EXISTS `admin_password_reset_tokens` (
  `id`          bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT,
  `admin_uuid`  char(36) NOT NULL,
  `token_hash`  char(64) NOT NULL COMMENT 'SHA-256 hex of the raw token sent to admin',
  `expires_at`  datetime NOT NULL,
  `used_at`     datetime DEFAULT NULL,
  `created_at`  datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_aprt_admin_uuid` (`admin_uuid`),
  KEY `idx_aprt_token_hash` (`token_hash`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
