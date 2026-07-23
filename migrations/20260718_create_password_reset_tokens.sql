-- Single-use password-reset tokens with expiry.
-- Replaces the JWT-based approach that derived tokens from user password hashes.

CREATE TABLE IF NOT EXISTS `password_reset_tokens` (
  `id`         bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_uuid`  char(36) NOT NULL,
  `token_hash` char(64) NOT NULL COMMENT 'SHA-256 hex of the raw token sent to user',
  `expires_at` datetime NOT NULL,
  `used_at`    datetime DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_prt_user_uuid` (`user_uuid`),
  KEY `idx_prt_token_hash` (`token_hash`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
