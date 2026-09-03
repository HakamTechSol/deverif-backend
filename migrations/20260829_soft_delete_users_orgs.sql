-- Soft delete support for users and organizations
ALTER TABLE users ADD COLUMN deleted_at DATETIME NULL DEFAULT NULL;
ALTER TABLE organizations ADD COLUMN deleted_at DATETIME NULL DEFAULT NULL;

CREATE INDEX idx_users_deleted_at ON users (deleted_at);
CREATE INDEX idx_organizations_deleted_at ON organizations (deleted_at);
