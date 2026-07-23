CREATE TABLE IF NOT EXISTS `notifications` (
  `id`         bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_uuid`  char(36) NOT NULL,
  `type`       varchar(50) NOT NULL DEFAULT 'verification_request',
  `title`      varchar(255) NOT NULL,
  `message`    text DEFAULT NULL,
  `link`       varchar(500) DEFAULT NULL,
  `reference_id` varchar(36) DEFAULT NULL COMMENT 'UUID of related entity (e.g. request uuid)',
  `read_at`    datetime DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_notif_user_uuid` (`user_uuid`),
  KEY `idx_notif_read` (`user_uuid`, `read_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
