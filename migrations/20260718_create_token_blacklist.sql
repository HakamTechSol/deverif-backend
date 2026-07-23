CREATE TABLE IF NOT EXISTS `token_blacklist` (
  `id`         bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT,
  `token_hash` char(64) NOT NULL COMMENT 'SHA-256 hex of the raw JWT',
  `expires_at` datetime NOT NULL COMMENT 'Expiry of the blacklisted token',
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_token_blacklist_hash` (`token_hash`),
  KEY `idx_token_blacklist_expires` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
