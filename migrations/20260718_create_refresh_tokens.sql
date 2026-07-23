CREATE TABLE IF NOT EXISTS `refresh_tokens` (
  `id`         bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT,
  `token_hash` char(64) NOT NULL COMMENT 'SHA-256 hex of the raw refresh JWT',
  `type`       enum('user','admin') NOT NULL,
  `identifier` varchar(255) NOT NULL COMMENT 'user uuid or admin email',
  `expires_at` datetime NOT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_refresh_token_hash` (`token_hash`),
  KEY `idx_refresh_token_lookup` (`type`, `identifier`),
  KEY `idx_refresh_token_expires` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
