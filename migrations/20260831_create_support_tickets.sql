-- Support ticket system — form-based submission & tracking (not live chat).

CREATE TABLE IF NOT EXISTS `support_tickets` (
  `id`              bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT,
  `uuid`            char(36) NOT NULL,
  `organization_id` bigint(20) UNSIGNED NOT NULL,
  `raised_by_uuid`  char(36) NOT NULL,
  `subject`         varchar(255) NOT NULL,
  `description`     text NOT NULL,
  `priority`        enum('low','medium','high') NOT NULL DEFAULT 'medium',
  `status`          enum('open','in_progress','resolved','closed') NOT NULL DEFAULT 'open',
  `created_at`      datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at`      datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_support_tickets_uuid` (`uuid`),
  KEY `idx_support_tickets_org` (`organization_id`),
  KEY `idx_support_tickets_status` (`status`),
  KEY `idx_support_tickets_priority` (`priority`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `support_ticket_replies` (
  `id`              bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT,
  `uuid`            char(36) NOT NULL,
  `ticket_uuid`     char(36) NOT NULL,
  `replied_by_uuid` char(36) NOT NULL,
  `replied_by_type` enum('admin','org_user') NOT NULL,
  `message`         text NOT NULL,
  `created_at`      datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_support_ticket_replies_uuid` (`uuid`),
  KEY `idx_support_replies_ticket` (`ticket_uuid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
