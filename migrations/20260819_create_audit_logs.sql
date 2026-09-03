-- audit_logs: permanent record of meaningful actions on the platform
CREATE TABLE IF NOT EXISTS audit_logs (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  uuid        CHAR(36) NOT NULL,
  actor_type  ENUM('admin','user') NOT NULL,
  actor_id    INT NOT NULL,
  actor_name  VARCHAR(190) DEFAULT NULL,
  action      VARCHAR(100) NOT NULL,
  entity_type VARCHAR(100) NOT NULL,
  entity_id   VARCHAR(100) DEFAULT NULL,
  details     JSON DEFAULT NULL,
  ip_address  VARCHAR(45) DEFAULT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE INDEX idx_audit_logs_uuid (uuid),
  INDEX idx_audit_actor (actor_type, actor_id),
  INDEX idx_audit_action (action),
  INDEX idx_audit_entity (entity_type, entity_id),
  INDEX idx_audit_date (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;