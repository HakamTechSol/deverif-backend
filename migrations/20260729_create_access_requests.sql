CREATE TABLE IF NOT EXISTS access_requests (
  id INT AUTO_INCREMENT PRIMARY KEY,
  uuid CHAR(36) NOT NULL UNIQUE DEFAULT (UUID()),
  organization_name VARCHAR(255) NOT NULL,
  contact_name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL,
  phone VARCHAR(50) DEFAULT NULL,
  company_size VARCHAR(100) DEFAULT NULL,
  message TEXT DEFAULT NULL,
  status ENUM('new','contacted','onboarded','rejected') NOT NULL DEFAULT 'new',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
