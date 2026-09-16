CREATE TABLE IF NOT EXISTS organization_types (
  id INT NOT NULL AUTO_INCREMENT,
  name VARCHAR(100) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_organization_types_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO organization_types (name) VALUES
  ('software_house'),
  ('education'),
  ('government')
ON DUPLICATE KEY UPDATE name = VALUES(name);