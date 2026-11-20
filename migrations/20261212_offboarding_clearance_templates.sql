-- Organization-owned clearance templates. No defaults are seeded: an empty
-- template intentionally creates an empty checklist for new exit requests.
CREATE TABLE IF NOT EXISTS offboarding_clearance_templates (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  organization_id BIGINT UNSIGNED NOT NULL,
  department ENUM('IT','Finance','Assets','HR') NOT NULL,
  task_name VARCHAR(200) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_offboarding_clearance_template_uuid (uuid),
  UNIQUE KEY uk_offboarding_clearance_template_org_task (organization_id, task_name),
  KEY idx_offboarding_clearance_template_org_active (organization_id, is_active, sort_order),
  CONSTRAINT fk_offboarding_clearance_template_org
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
