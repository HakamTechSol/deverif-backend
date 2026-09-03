-- Add the 'sub_admin' organization role (a Member with admin-configurable
-- elevated permissions, distinct from the single primary 'org_admin').
ALTER TABLE users
  MODIFY COLUMN org_role ENUM('member','org_admin','sub_admin') NOT NULL DEFAULT 'org_admin';