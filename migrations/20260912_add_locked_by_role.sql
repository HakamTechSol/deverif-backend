-- Distinguishes system-admin locks from user locks so the lock-holder name
-- resolves from the correct table (admin_profiles vs users). Their numeric
-- ids were previously ambiguous (an admin and a user could both be id=2).

ALTER TABLE `verification_requests`
  ADD COLUMN IF NOT EXISTS `locked_by_role` ENUM('admin','user') NULL AFTER `locked_by`;