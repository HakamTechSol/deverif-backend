-- 2026-09-09: organizations.organization_type now stores organization_types.id instead of an ENUM name.

-- Step 1: snapshot current name values before the column type changes
-- CREATE TEMPORARY TABLE _org_type_backfill AS
-- SELECT o.id AS org_id, o.organization_type AS type_name
-- FROM organizations o
-- WHERE o.organization_type IS NOT NULL AND o.organization_type <> '';

-- Step 2: switch column to INT (snapshot values coerce to 0)
ALTER TABLE organizations MODIFY organization_type INT NULL;

-- Step 3: backfill ids from the snapshot
-- UPDATE organizations o
-- JOIN _org_type_backfill b ON b.org_id = o.id
-- LEFT JOIN organization_types t ON LOWER(t.name) = LOWER(b.type_name)
-- SET o.organization_type = t.id;

-- Step 4: clear values that could not be mapped
UPDATE organizations
SET organization_type = NULL
WHERE organization_type IS NOT NULL
  AND organization_type NOT IN (SELECT id FROM organization_types);

-- Step 5: referential integrity
ALTER TABLE organizations
  ADD INDEX idx_org_type (organization_type),
  ADD CONSTRAINT fk_org_org_type
    FOREIGN KEY (organization_type) REFERENCES organization_types(id)
    ON DELETE SET NULL;