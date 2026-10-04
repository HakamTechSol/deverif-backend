-- 2026-11-10e -- Replace the asset file-path columns with attachment entities
--
-- WHY. 20261110 gave `assets` a `receipt_path` and `asset_maintenance` an
-- `invoice_path`. That contradicts the house design, stated explicitly in
-- 20261103_create_attachments.sql:
--
--   "A module keeps its own domain row and never grows a file column."
--
-- That same migration even lists `assets` as an anticipated entity_type, so the
-- intended route was always the polymorphic attachments table. The columns were
-- wrong on three counts, not merely stylistically:
--
--   1. NO TENANT ISOLATION. attachments filters organization_id on every query;
--      a bare path column on `assets` had nothing to filter, so receipt access
--      depended entirely on the asset read already being scoped.
--   2. NO PATH-TRAVERSAL GUARD. resolveAttachmentPath() re-anchors a stored path
--      against ATTACHMENTS_DIR and refuses anything escaping it. A column holding
--      a caller-supplied path has no such guard, which is how a stored
--      "../../.env" turns a download endpoint into an arbitrary-file-read.
--   3. NO AUDIT OR SOFT DELETE. Attachment rows are soft-deleted so a mistaken
--      removal leaves a tombstone, and every upload is written to the audit log.
--
-- The columns carried no data (the module had not shipped), so this is a plain
-- drop. entity_type values follow the namespacing already used by the table:
-- 'asset' for receipts, 'asset_maintenance' for repair invoices, distinguished
-- further by the attachments.category column.

ALTER TABLE `assets`
  DROP COLUMN `receipt_path`;

ALTER TABLE `asset_maintenance`
  DROP COLUMN `invoice_path`;

-- Apply with:
--   RUN_ONLY=20261110e_use_attachment_entities.sql node migrations/run.mjs