-- Clean 3-tier role system: org_role ENUM('org_admin','sub_admin','employee').
-- Replaces the previous per-feature `feature_access` checkbox model with fixed
-- role-based permission sets. The `feature_access` column is retained but is no
-- longer consulted (pre-launch redesign; safe to ignore existing values).

-- 1) Widen/remap the org_role enum. 'member' (the old employee role) is remapped
--    to 'employee'. Use MODIFY to set the final allowed set.
UPDATE users SET org_role = 'employee' WHERE org_role = 'member';
ALTER TABLE users
  MODIFY COLUMN org_role ENUM('org_admin','sub_admin','employee')
  NOT NULL DEFAULT 'employee';
