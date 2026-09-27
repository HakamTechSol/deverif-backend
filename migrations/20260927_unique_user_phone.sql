-- 2026-09-27 -- one phone number, one person: enforce uniqueness on users.phone
--
-- The defect
--   CNIC already had a UNIQUE key, but `phone` had no constraint of any kind —
--   not an index, not a check. Two users could be created with the same number
--   and the database was happy. On a B2B platform where a phone number is how a
--   person is identified and contacted, that means duplicate identities: the
--   same human holding two accounts, and OTP going to an ambiguous target.
--
-- Why the raw column is not enough to index
--   The same number is written many ways: "03182484396", "+92 318 2484396",
--   "00923182484396", "3182484396". A UNIQUE index on the raw string would let
--   all four through while they are one number, and would also reject two
--   genuinely different people whose formatting happened to differ. So the
--   index goes on a canonical national number, not on what was typed.
--
-- Why triggers rather than application code
--   There are seven separate code paths that write users.phone (admin user
--   create/update, admin employee create/update, admin's own profile, org
--   invites, self-service profile update). A check in each one is a check that
--   a future path can forget. Deriving the value in a BEFORE INSERT/UPDATE
--   trigger means the invariant holds for every writer, including ad-hoc SQL,
--   and the UNIQUE index is a hard backstop underneath it.
--
-- Soft-deleted users
--   A departed employee's number should be reusable by their replacement, so a
--   soft-deleted row yields NULL and claims nothing. NULLs do not collide in a
--   UNIQUE index, which is exactly the behaviour wanted. CNIC is left globally
--   unique and permanently reserved — it is a government identifier, and
--   reusing one would attach a new person to an old person's history.
--
-- Existing duplicate
--   The constraint cannot be added while a duplicate exists, and deleting or
--   editing a real user's number to satisfy a migration is not this file's
--   decision to make. So the raw `phone` is left untouched on every row and
--   only the CLAIM is released: in each duplicate group the earliest user keeps
--   phone_normalized and the rest get NULL. No data is lost, the index applies,
--   and the affected rows are listed at the end so a human can correct them.

DROP FUNCTION IF EXISTS `dverif_normalize_phone`;

-- Canonicalises a phone number to its national form.
--   03182484396 / +92 318 2484396 / 00923182484396 / 3182484396  ->  3182484396
-- Returns NULL for a blank number, and for any row that is soft-deleted.
DELIMITER $$
CREATE FUNCTION `dverif_normalize_phone`(p_phone VARCHAR(30), p_deleted_at DATETIME)
RETURNS VARCHAR(20)
DETERMINISTIC
BEGIN
  DECLARE v_digits VARCHAR(30);

  -- A soft-deleted row claims nothing, so the number frees up for a replacement.
  IF p_phone IS NULL OR p_deleted_at IS NOT NULL THEN
    RETURN NULL;
  END IF;

  SET v_digits = REGEXP_REPLACE(p_phone, '[^0-9]', '');

  IF v_digits = '' THEN
    RETURN NULL;
  END IF;

  -- Strip a country code, then a national trunk prefix, but only at the exact
  -- lengths where doing so is unambiguous. An unexpected length is left alone
  -- rather than guessed at: a wrong guess would merge two different numbers,
  -- which is the very bug this migration exists to prevent.
  IF CHAR_LENGTH(v_digits) = 14 AND v_digits LIKE '0092%' THEN
    SET v_digits = SUBSTRING(v_digits, 5);
  ELSEIF CHAR_LENGTH(v_digits) = 12 AND v_digits LIKE '92%' THEN
    SET v_digits = SUBSTRING(v_digits, 3);
  ELSEIF CHAR_LENGTH(v_digits) = 11 AND v_digits LIKE '0%' THEN
    SET v_digits = SUBSTRING(v_digits, 2);
  END IF;

  RETURN v_digits;
END$$
DELIMITER ;

ALTER TABLE `users`
  ADD COLUMN IF NOT EXISTS `phone_normalized` VARCHAR(20) NULL
    COMMENT 'Canonical national form of `phone`, derived by trigger. UNIQUE across live rows; NULL for soft-deleted or blank.'
    AFTER `phone`;

-- The uuid trigger is named bi_users_uuid, so ordering is explicit rather than
-- left to creation order.
DROP TRIGGER IF EXISTS `bi_users_phone_normalize`;
DELIMITER $$
CREATE TRIGGER `bi_users_phone_normalize` BEFORE INSERT ON `users`
FOR EACH ROW
FOLLOWS `bi_users_uuid`
BEGIN
  SET NEW.phone_normalized = dverif_normalize_phone(NEW.phone, NEW.deleted_at);
END$$
DELIMITER ;

DROP TRIGGER IF EXISTS `bu_users_phone_normalize`;
DELIMITER $$
CREATE TRIGGER `bu_users_phone_normalize` BEFORE UPDATE ON `users`
FOR EACH ROW
BEGIN
  SET NEW.phone_normalized = dverif_normalize_phone(NEW.phone, NEW.deleted_at);
END$$
DELIMITER ;

-- Backfill live rows. The BEFORE UPDATE trigger recomputes the same value, so
-- this is about populating rows that predate the trigger rather than about
-- setting a value the trigger would disagree with.
UPDATE `users`
   SET `phone_normalized` = dverif_normalize_phone(`phone`, `deleted_at`);

-- Release the claim on all but the earliest row of each duplicate group. The raw
-- `phone` is deliberately left as typed: this is a uniqueness constraint, not a
-- data cleanup, and silently editing a user's number would be worse than
-- reporting it.
--
-- The UPDATE trigger is dropped for this one statement, and that is essential:
-- it recomputes phone_normalized on every UPDATE, so it would immediately undo
-- the NULL written here — and then the statement would fail against the new
-- index. Reinstated on the very next line, so no writer is left unguarded.
DROP TRIGGER IF EXISTS `bu_users_phone_normalize`;

UPDATE `users` u
   JOIN (
     SELECT `phone_normalized` AS pn, MIN(`id`) AS keep_id
       FROM `users`
      WHERE `phone_normalized` IS NOT NULL
        AND `deleted_at` IS NULL
      GROUP BY `phone_normalized`
     HAVING COUNT(*) > 1
   ) d ON d.pn = u.`phone_normalized`
   SET u.`phone_normalized` = NULL
 WHERE u.`id` <> d.keep_id
   AND u.`deleted_at` IS NULL;

DELIMITER $$
CREATE TRIGGER `bu_users_phone_normalize` BEFORE UPDATE ON `users`
FOR EACH ROW
BEGIN
  SET NEW.phone_normalized = dverif_normalize_phone(NEW.phone, NEW.deleted_at);
END$$
DELIMITER ;

-- Now the invariant can be enforced.
CREATE UNIQUE INDEX `uq_users_phone_normalized`
  ON `users` (`phone_normalized`);

-- Lookup support for "does this number already belong to someone?".
CREATE INDEX `idx_users_cnic` ON `users` (`cnic`);

-- Report what still needs a human: rows whose stored number duplicates another
-- live row, now that the claim has been released.
SELECT `id`, `email`, `phone`, `phone_normalized`, `deleted_at`
  FROM `users`
 WHERE `phone_normalized` IS NULL
   AND `phone` IS NOT NULL
   AND `phone` <> ''
   AND `deleted_at` IS NULL
 ORDER BY `id`;
