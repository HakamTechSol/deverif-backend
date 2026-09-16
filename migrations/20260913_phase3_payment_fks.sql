-- 2026-09-13 Phase 3.5 — payment: add organization_id FK; user_id FK CASCADE -> SET NULL.
--
-- (1) payment had no organization_id; the org was only reachable through a
--     users JOIN. Payments now carry the payer's organization id directly,
--     backfilled from users.organization (orgless payers stay NULL).
-- (2) users ON DELETE CASCADE silently wiped payment history if a user was
--     ever hard-deleted. Financial records are preserved with SET NULL instead
--     (application code was updated to write organization_id in the same pass).

-- 1. Make user_id nullable (required before FK can use ON DELETE SET NULL).
ALTER TABLE `payment`
  DROP FOREIGN KEY `fk_pay_user`,
  MODIFY COLUMN `user_id` BIGINT(20) UNSIGNED NULL DEFAULT NULL;

-- 2. Add the organization FK column.
ALTER TABLE `payment`
  ADD COLUMN `organization_id` BIGINT(20) UNSIGNED NULL DEFAULT NULL AFTER `user_id`,
  ADD KEY `idx_payment_org` (`organization_id`);

-- 3. Backfill from the payer's user row (orgless payers remain NULL).
UPDATE `payment` p
JOIN `users` u ON u.`id` = p.`user_id`
SET p.`organization_id` = u.`organization`
WHERE u.`organization` IS NOT NULL;

-- 4. Recreate user_id FK with SET NULL + add organization_id FK.
ALTER TABLE `payment`
  ADD CONSTRAINT `fk_pay_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL,
  ADD CONSTRAINT `fk_pay_org` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE SET NULL;