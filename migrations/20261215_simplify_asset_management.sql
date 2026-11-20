-- Remove the asset taxonomy and category table and category link after the application no longer depends on them.
-- Asset records themselves, including names, purchase details, assignments and maintenance history, are preserved.
DROP TRIGGER IF EXISTS bi_asset_categories_uuid;

ALTER TABLE assets
  DROP FOREIGN KEY fk_assets_category_same_org,
  DROP INDEX fk_assets_category_same_org,
  DROP INDEX idx_assets_category,
  DROP COLUMN category_uuid;

DROP TABLE asset_categories;
