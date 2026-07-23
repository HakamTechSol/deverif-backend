-- Adds an index on document_hash for faster auto-verification lookups,
-- and extends the verification_method enum to include 'auto' and 'admin'.

-- 1. Add index on document_hash
ALTER TABLE `verification_requests`
  ADD INDEX `idx_document_hash` (`document_hash`);

-- 2. Extend verification_method enum: add 'auto' and 'admin'
--    MySQL does not support DROP VALUE from enum directly.
--    We alter the column type, adding the new values.
ALTER TABLE `verification_requests`
  MODIFY COLUMN `verification_method` enum('manual','portal','auto','admin') NOT NULL DEFAULT 'manual';
