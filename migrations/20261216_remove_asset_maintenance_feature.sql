-- Maintenance workflows are retired from the application. Preserve historical
-- asset_maintenance rows and their attachments for audit purposes, but normalize
-- current asset statuses so no asset remains stranded in the removed status.
UPDATE assets a
LEFT JOIN asset_assignments g
  ON g.asset_uuid = a.uuid
 AND g.organization_id = a.organization_id
 AND g.returned_at IS NULL
SET a.status = CASE WHEN g.uuid IS NULL THEN 'available' ELSE 'assigned' END
WHERE a.status = 'maintenance';
