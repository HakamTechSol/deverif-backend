-- 2026-11-10c — Enforce that an asset's category belongs to the same organization
--
-- WHY. `assets.category_uuid` had a plain FK to `asset_categories(uuid)`, which
-- only proves the category EXISTS. It says nothing about WHICH TENANT owns it.
-- Verified against the running database: an asset belonging to organization B
-- could be inserted pointing at organization A's category, and the insert was
-- ACCEPTED.
--
-- The service does check this (categoryInOrg scopes by organization_id), so the
-- HTTP API cannot produce the bad state. But a service check is a convention and
-- a convention is one direct query, one script, or one future import path away
-- from being bypassed. Multi-tenancy is the one property that must not rely on
-- every caller remembering, so it belongs in the schema.
--
-- The fix is a composite foreign key. MySQL can only reference columns that are
-- themselves the subject of a UNIQUE key, hence the added (uuid,
-- organization_id) unique: it is the index the composite FK targets, and it also
-- documents that the pair identifies a category globally.

-- The composite unique below was added by the first (partially applied) run of
-- this migration and again by 20261110 for fresh installs, so it is NOT repeated
-- here: MySQL has no ADD UNIQUE KEY IF NOT EXISTS, and repeating it would abort
-- on an existing key and leave the FK swap undone — which is exactly what
-- happened once.

-- Replace the tenancy-blind key with one that spans both columns. Dropping and
-- re-adding is required: MySQL cannot alter a foreign key in place.
--
-- ON DELETE IS CASCADE, NOT RESTRICT, and that is a deliberate trade-off worth
-- being explicit about. RESTRICT is the intuitive choice — "a category must not
-- vanish out from under live inventory" — but it BREAKS organization deletion.
-- Deleting a tenant cascades to both its categories and its assets, and MySQL
-- evaluates the category delete first, hits the assets rows, and aborts the whole
-- operation with ER_ROW_IS_REFERENCED_2. Hard-deleting an organization is a
-- legitimate operation (data erasure, offboarding, test teardown), so a schema
-- that cannot perform it is wrong.
--
-- MySQL cannot express "restrict, unless the owning organization is going away
-- too", so the database must choose. CASCADE is chosen so tenant deletion works,
-- and the protection that actually matters is kept one layer up:
-- assetsService.deleteCategory refuses with a 409 while any asset still references
-- the category, naming the count. So the destructive path is guarded by
-- application logic and the referential graph stays consistent, rather than the
-- schema being internally consistent at the cost of an operation that must work.
ALTER TABLE `assets`
  DROP FOREIGN KEY `fk_assets_category`,
  ADD CONSTRAINT `fk_assets_category_same_org`
    FOREIGN KEY (`category_uuid`, `organization_id`)
    REFERENCES `asset_categories` (`uuid`, `organization_id`) ON DELETE CASCADE;

-- Apply with:
--   RUN_ONLY=20261110c_enforce_asset_category_tenancy.sql node migrations/run.mjs