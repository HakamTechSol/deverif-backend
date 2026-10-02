-- A distinct terminal status for requests the system approved on its own.
--
-- WHY A NEW STATUS RATHER THAN A DISPLAY-ONLY BADGE: the requester needs to see
-- that nobody at the verifying organization looked at their document. Both
-- automatic paths already stamp `verification_method` ('automatic_match' for the
-- reference match, 'auto' for a repeat of an already-verified file), but that is
-- an implementation detail of the matching engine and was never surfaced to the
-- submitter. Promoting it to a first-class status makes the outcome filterable,
-- countable and assertable in one place instead of being re-derived from a
-- second column at every read site.
--
-- 'auto_verified' is TERMINAL, exactly like 'verified': the request is closed,
-- the document counts as authentic, and a QR certificate may be issued for it.
-- Every query that means "is this request a successful verification?" must
-- therefore test BOTH values. A query that tests only `status='verified'` will
-- silently stop seeing auto-approved requests — that is the single hazard this
-- migration introduces, and the reason the affected call sites are enumerated
-- below rather than left to be discovered later.
--
-- 'under_review' and 'unverified' are untouched, so nothing in the review queue
-- or the rejection path changes behaviour.
--
-- No new index: `idx_vr_status` already covers this column and MODIFY COLUMN
-- leaves an existing index on an ENUM in place, so adding a second one would
-- only duplicate work on every write.

ALTER TABLE `verification_requests`
    MODIFY COLUMN `status`
    ENUM('under_review','verified','auto_verified','unverified') NOT NULL DEFAULT 'under_review';

-- BACKFILL. Requests the system already approved are sitting in the table as a
-- plain 'verified', because before this migration the automatic outcome had no
-- status of its own and was recorded only in `verification_method`. Left alone
-- they would keep reporting as human-reviewed forever — permanently mislabelled
-- on the one page whose whole job is to tell the submitter the truth about who
-- approved their document.
--
-- Scoped to exactly the two automatic methods, so nothing a human decided is
-- touched. Matching on verification_method (rather than match_status) is what
-- makes the repeat-of-a-verified-file path included: that path never ran the
-- reference match, so its match_status is still 'not_attempted'.
-- NOTE: the `SET` keyword below was missing (the statement read
-- `ALTER TABLE ... UPDATE status = ...`, which is a syntax error). This file
-- had been applied by hand against the live database without being recorded in
-- schema_migrations, so the broken statement was never executed by the runner
-- and went unnoticed until migrations/run.mjs reached it. Corrected 2026-11-01.
-- The statement is idempotent (it only rewrites rows that are still 'verified').
UPDATE `verification_requests`
   SET `status` = 'auto_verified'
 WHERE `status` = 'verified'
   AND `verification_method` IN ('automatic_match', 'auto');