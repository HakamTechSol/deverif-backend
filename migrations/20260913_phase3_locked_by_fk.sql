-- 2026-09-13 Phase 3.1 — verification_requests.lock: admin-only, single FK.
--
-- Verified in code: the only lock/unlock routes are
--   PATCH /admin/verification/:uuid/lock   (authAdminEnv)
--   PATCH /admin/verification/:uuid/unlock (authAdminEnv)
-- so only system admins ever lock/unlock a request. `lockRequest` previously
-- wrote locked_by_role='admin'|'user' based on req.admin vs req.user, but the
-- user path is unreachable (no user-facing lock route exists). With id spaces
-- shared between users and admin_profiles (id 2 exists in BOTH tables today),
-- the polymorphic join was fragile. This migration:
--   1. Clears any lock whose id does not resolve to an admin_profiles row.
--   2. Adds FK locked_by -> admin_profiles.id ON DELETE SET NULL.
--   3. Drops the now-redundant locked_by_role column (code no longer reads/writes it).

-- 1. Orphan/user locks -> unlocked (also nulls legacy 'user'-role locks).
UPDATE `verification_requests` vr
LEFT JOIN `admin_profiles` ap ON ap.`id` = vr.`locked_by`
SET vr.`locked_by` = NULL, vr.`locked_at` = NULL
WHERE vr.`locked_by` IS NOT NULL AND ap.`id` IS NULL;

-- 2. FK to admin_profiles (existing index on locked_by is reused).
ALTER TABLE `verification_requests`
  ADD CONSTRAINT `fk_vr_locked_by_admin`
  FOREIGN KEY (`locked_by`) REFERENCES `admin_profiles`(`id`) ON DELETE SET NULL;

-- 3. Drop the polymorphic discriminator column.
ALTER TABLE `verification_requests` DROP COLUMN `locked_by_role`;