CREATE TABLE IF NOT EXISTS `notification_preferences` (
  `user_uuid` char(36) NOT NULL,
  `email_leave` tinyint(1) NOT NULL DEFAULT 1,
  `email_support` tinyint(1) NOT NULL DEFAULT 1,
  `email_recruitment` tinyint(1) NOT NULL DEFAULT 1,
  `email_payroll` tinyint(1) NOT NULL DEFAULT 1,
  `email_attendance` tinyint(1) NOT NULL DEFAULT 1,
  `email_onboarding` tinyint(1) NOT NULL DEFAULT 1,
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`user_uuid`),
  CONSTRAINT `fk_notification_preferences_user` FOREIGN KEY (`user_uuid`) REFERENCES `users` (`uuid`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `email_outbox` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `event_key` varchar(255) NOT NULL,
  `user_uuid` char(36) DEFAULT NULL,
  `recipient_email` varchar(190) NOT NULL,
  `category` enum('leave','support','recruitment','payroll','attendance','onboarding','system') NOT NULL,
  `language` enum('en','ur') NOT NULL DEFAULT 'en',
  `subject` varchar(255) NOT NULL,
  `title` varchar(255) NOT NULL,
  `message` text NOT NULL,
  `action_url` varchar(1000) DEFAULT NULL,
  `status` enum('pending','sending','sent','failed') NOT NULL DEFAULT 'pending',
  `attempts` tinyint unsigned NOT NULL DEFAULT 0,
  `available_at` datetime NOT NULL DEFAULT current_timestamp(),
  `claimed_at` datetime DEFAULT NULL,
  `sent_at` datetime DEFAULT NULL,
  `last_error` varchar(1000) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_email_outbox_event_key` (`event_key`),
  KEY `idx_email_outbox_delivery` (`status`,`available_at`,`id`),
  KEY `idx_email_outbox_user` (`user_uuid`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
