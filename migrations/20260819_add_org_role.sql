-- org_admin: elevated role within a user's own organization.
ALTER TABLE users
  ADD COLUMN org_role ENUM('member','org_admin') NOT NULL DEFAULT 'member' AFTER status;