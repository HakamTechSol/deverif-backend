-- 2026-11-10b — Fix the open-assignment uniqueness guard
--
-- WHY THIS FILE EXISTS. The original 20261110_create_assets.sql enforced "at most
-- one open assignment per asset" with:
--
--   UNIQUE KEY uk_asset_assignments_open (asset_uuid, returned_at)
--
-- That does not work, and this was verified against the database rather than
-- assumed. An open row has returned_at = NULL, and NULLs do not collide in a
-- MySQL UNIQUE index, so inserting two open assignments for the same asset was
-- ACCEPTED twice. The invariant the schema documented was not enforced, which
-- left an asset appearing to be held by two employees at once — the single worst
-- data error an asset register can contain.
--
-- The fix is the same generated-column technique already used, and verified
-- working, for asset_maintenance.open_job_guard: a non-NULL constant while the
-- row is open, NULL once closed, so only the open row must be unique.
--
-- 20261110 is also corrected in place for fresh installs. Both changes are
-- needed: the runner tracks applied migrations, so editing the original alone
-- would never fix an already-provisioned database.

-- Any duplicate open rows make the new unique key impossible to create, so the
-- data has to be reconciled first. Ordering is by assigned_at: the EARLIEST open
-- row is treated as the genuine holder, because a later duplicate is always the
-- erroneous one (the asset was handed over once; the second row is a mistake).
-- Closing the others records them as returned rather than deleting them, since
-- they are part of the custody history.
UPDATE `asset_assignments`
SET `returned_at` = COALESCE(`returned_at`, NOW()),
    `return_condition` = COALESCE(`return_condition`, 'good'),
    `return_notes` = COALESCE(
      `return_notes`,
      'Closed automatically by 20261110b: duplicate open assignment reconciled, keeping the earliest row as the holder.'
    )
WHERE `returned_at` IS NULL
  AND `uuid` NOT IN (
    -- Keep the earliest open row per asset.
    SELECT keep_uuid FROM (
      SELECT `uuid` AS keep_uuid
        FROM (
          SELECT `uuid`,
                 ROW_NUMBER() OVER (PARTITION BY `asset_uuid` ORDER BY `assigned_at`, `id`) AS rn
            FROM `asset_assignments`
           WHERE `returned_at` IS NULL
        ) ranked
       WHERE ranked.rn = 1
    ) keepers
  );

-- Drop the ineffective key before replacing it, so the name is not left behind
-- describing a rule it does not enforce.
ALTER TABLE `asset_assignments`
  DROP INDEX `uk_asset_assignments_open`;

ALTER TABLE `asset_assignments`
  ADD COLUMN `open_assignment_guard` TINYINT
    GENERATED ALWAYS AS (CASE WHEN `returned_at` IS NULL THEN 1 ELSE NULL END) STORED,
  ADD UNIQUE KEY `uk_asset_assignments_open` (`asset_uuid`, `open_assignment_guard`);

-- Apply with:
--   RUN_ONLY=20261110b_fix_asset_assignment_guard.sql node migrations/run.mjs