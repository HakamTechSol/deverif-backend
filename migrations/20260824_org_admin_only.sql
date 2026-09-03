-- 20260824_org_admin_only.sql
-- Remove the "member" concept: every platform user is an org admin.

ALTER TABLE users ALTER COLUMN org_role SET DEFAULT 'org_admin';

UPDATE users SET org_role = 'org_admin' WHERE org_role = 'member';
