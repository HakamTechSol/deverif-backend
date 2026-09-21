-- Extend the verification_method enum with 'automatic_match', used by the
-- lazy reference-match engine when it auto-approves a request on confidence>=90.
-- Note: MODIFY preserves existing rows (values 'manual','portal','auto','admin').
ALTER TABLE verification_requests
  MODIFY COLUMN verification_method
    ENUM('manual','portal','auto','admin','automatic_match') NOT NULL DEFAULT 'manual';