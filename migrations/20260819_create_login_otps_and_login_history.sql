-- login_otps: stores OTP codes issued during the password-verified step
CREATE TABLE IF NOT EXISTS login_otps (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  identity_type   ENUM('admin','user') NOT NULL,
  identity_id     INT NOT NULL,
  otp_hash        VARCHAR(128) NOT NULL,
  attempts        TINYINT UNSIGNED NOT NULL DEFAULT 0,
  expires_at      DATETIME NOT NULL,
  used_at         DATETIME DEFAULT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_login_otps_lookup (identity_type, identity_id, used_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- login_history: records every login attempt (success and failure)
CREATE TABLE IF NOT EXISTS login_history (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  uuid            CHAR(36) NOT NULL,
  identity_type   ENUM('admin','user') NOT NULL,
  identity_id     INT NOT NULL,
  ip_address      VARCHAR(45) DEFAULT NULL,
  user_agent      VARCHAR(512) DEFAULT NULL,
  login_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  success         ENUM('yes','no') NOT NULL DEFAULT 'no',
  UNIQUE INDEX idx_login_history_uuid (uuid),
  INDEX idx_login_history_identity (identity_type, identity_id),
  INDEX idx_login_history_date (login_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
