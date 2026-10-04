-- 20261110d — Let an organization be hard-deleted again
--
-- WHY. 20261110c made the asset->category foreign key span both columns, which
-- is what stops an asset in one organization pointing at another organization's
-- category. It set ON DELETE RESTRICT, reasoning that a category must not vanish
-- out from under live inventory.
--
-- That breaks organization deletion, and it was caught only because
-- assets.db.test.js exercises a real database. Deleting a tenant cascades to
-- both its categories and its assets; MySQL evaluates the category delete first,
-- finds assets rows referencing it, and aborts the entire operation:
--
--   ER_ROW_IS_REFERENCED_2 ... CONSTRAINT `fk_assets_category_same_org`
--
-- Hard-deleting an organization is a legitimate operation — data erasure under
-- privacy law, offboarding, and test teardown all need it — so a schema that
-- cannot perform it is wrong regardless of how tidy it looks.
--
-- MySQL has no way to say "restrict, unless the owning organization is being
-- deleted too", so the database must pick one. CASCADE is picked so tenant
-- deletion works.
--
-- THE PROTECTION IS KEPT, ONE LAYER UP. Deleting a category is now a genuinely
-- destructive action at the schema level, so the guard that matters is enforced
-- in the service instead: assetsService.deleteCategory refuses with a 409 while
-- any asset still references the category, and names the count so the user can
-- reassign them first. That is covered by tests/assets.test.js ("refuses to
-- delete a category that still holds assets").
--
-- Net effect: referential integrity stays consistent, tenant deletion works, and
-- the destructive path is still guarded where a human is in the loop.

-- Split into two statements. MySQL rejects a single ALTER that drops and
-- re-adds a constraint with the same name (errno 121), and because DDL
-- auto-commits a failed combined ALTER can leave the table with no FK at all.
ALTER TABLE `assets`
  DROP FOREIGN KEY `fk_assets_category_same_org`;

ALTER TABLE `assets`
  ADD CONSTRAINT `fk_assets_category_same_org`
    FOREIGN KEY (`category_uuid`, `organization_id`)
    REFERENCES `asset_categories` (`uuid`, `organization_id`) ON DELETE CASCADE;

-- Apply with:
--   RUN_ONLY=20261110d_allow_org_deletion.sql node migrations/run.mjs