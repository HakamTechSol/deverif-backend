import * as assets from "../../services/assets.service.js";
import ApiError from "../../utils/ApiError.js";
import { ok } from "../../utils/response.js";
import { parsePagination } from "../../utils/pagination.js";

/**
 * HTTP surface for assets.
 *
 * Every handler takes the org scope from `req.scopeOrgId`, which the auth
 * middleware derived from the session. There is deliberately no organization_id
 * parameter anywhere in this module: a guessed asset uuid must 404, not return
 * another tenant's inventory.
 *
 * The actor comes from `req.user?.uuid` and is written to the audit log by the
 * service, so "who gave away the laptop" is always answerable.
 */

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export async function listCategories(req, res) {
  const includeInactive = req.query.include_inactive === "1" || req.query.include_inactive === "true";
  return ok(res, await assets.listCategories({ orgId: req.scopeOrgId, includeInactive }), "Categories");
}

export async function createCategory(req, res) {
  const category = await assets.createCategory({
    orgId: req.scopeOrgId,
    actorUuid: req.user?.uuid,
    data: req.body ?? {},
  });
  return ok(res, { category }, "Category created");
}

export async function updateCategory(req, res) {
  const category = await assets.updateCategory({
    orgId: req.scopeOrgId,
    actorUuid: req.user?.uuid,
    categoryUuid: req.params.uuid,
    data: req.body ?? {},
  });
  return ok(res, { category }, "Category updated");
}

export async function deleteCategory(req, res) {
  await assets.deleteCategory({
    orgId: req.scopeOrgId,
    actorUuid: req.user?.uuid,
    categoryUuid: req.params.uuid,
  });
  return ok(res, null, "Category deleted");
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

export async function listAssets(req, res) {
  const { page, limit, offset } = parsePagination(req.query);
  const result = await assets.listAssets({
    orgId: req.scopeOrgId,
    page,
    limit,
    offset,
    search: typeof req.query.search === "string" ? req.query.search : undefined,
    status: typeof req.query.status === "string" ? req.query.status : undefined,
    categoryUuid: typeof req.query.category_uuid === "string" ? req.query.category_uuid : undefined,
  });
  return ok(res, result, "Assets");
}

export async function getAsset(req, res) {
  const asset = await assets.getAsset({ orgId: req.scopeOrgId, assetUuid: req.params.uuid });
  return ok(res, { asset }, "Asset");
}

export async function createAsset(req, res) {
  const asset = await assets.createAsset({
    orgId: req.scopeOrgId,
    actorUuid: req.user?.uuid,
    data: req.body ?? {},
  });
  return ok(res, { asset }, "Asset created");
}

export async function updateAsset(req, res) {
  const asset = await assets.updateAsset({
    orgId: req.scopeOrgId,
    actorUuid: req.user?.uuid,
    assetUuid: req.params.uuid,
    data: req.body ?? {},
  });
  return ok(res, { asset }, "Asset updated");
}

export async function summary(req, res) {
  return ok(res, await assets.assetSummary({ orgId: req.scopeOrgId }), "Summary");
}

// ---------------------------------------------------------------------------
// Custody
// ---------------------------------------------------------------------------

export async function assignAsset(req, res) {
  const result = await assets.assignAsset({
    orgId: req.scopeOrgId,
    actorUuid: req.user?.uuid,
    assetUuid: req.params.uuid,
    employeeUuid: req.body?.employee_uuid,
  });
  return ok(res, result, "Asset assigned");
}

export async function returnAsset(req, res) {
  const result = await assets.returnAsset({
    orgId: req.scopeOrgId,
    actorUuid: req.user?.uuid,
    assetUuid: req.params.uuid,
    condition: req.body?.condition ?? "good",
    notes: req.body?.notes ?? null,
  });
  return ok(res, result, "Asset returned");
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

export async function listMaintenance(req, res) {
  const rows = await assets.listMaintenance({
    orgId: req.scopeOrgId,
    assetUuid: typeof req.query.asset_uuid === "string" ? req.query.asset_uuid : undefined,
    status: typeof req.query.status === "string" ? req.query.status : undefined,
  });
  return ok(res, { items: rows }, "Maintenance");
}

export async function reportMaintenance(req, res) {
  const result = await assets.reportMaintenance({
    orgId: req.scopeOrgId,
    actorUuid: req.user?.uuid,
    assetUuid: req.params.uuid,
    data: req.body ?? {},
  });
  return ok(res, result, "Maintenance reported");
}

export async function completeMaintenance(req, res) {
  if (!req.params.jobUuid) throw new ApiError(400, "A maintenance job uuid is required");
  const result = await assets.completeMaintenance({
    orgId: req.scopeOrgId,
    actorUuid: req.user?.uuid,
    jobUuid: req.params.jobUuid,
    data: req.body ?? {},
  });
  return ok(res, result, "Maintenance closed");
}

// ---------------------------------------------------------------------------
// Employee self-service
// ---------------------------------------------------------------------------

/**
 * Assets assigned to the signed-in employee.
 *
 * Takes no parameters at all. That is the point: there is no employee_uuid to
 * tamper with, and the answer is derived from the session.
 */
export async function listMyAssets(req, res) {
  const items = await assets.listMyAssets({
    orgId: req.scopeOrgId,
    userUuid: req.user?.uuid,
  });
  return ok(res, { items }, "My assets");
}

// ---------------------------------------------------------------------------
// Attachments: purchase receipts and repair invoices
// ---------------------------------------------------------------------------

export async function uploadReceipts(req, res) {
  const rows = await assets.attachReceipt({
    orgId: req.scopeOrgId,
    actorUuid: req.user?.uuid,
    assetUuid: req.params.uuid,
    files: req.files ?? [],
    category: typeof req.body?.category === "string" ? req.body.category : undefined,
    description: req.body?.description ?? null,
  });
  return ok(res, { items: rows }, "Receipts uploaded");
}

export async function listReceipts(req, res) {
  const rows = await assets.listReceipts({ orgId: req.scopeOrgId, assetUuid: req.params.uuid });
  return ok(res, { items: rows }, "Receipts");
}

export async function uploadInvoices(req, res) {
  const rows = await assets.attachInvoice({
    orgId: req.scopeOrgId,
    actorUuid: req.user?.uuid,
    jobUuid: req.params.jobUuid,
    files: req.files ?? [],
    description: req.body?.description ?? null,
  });
  return ok(res, { items: rows }, "Invoices uploaded");
}

export async function listInvoices(req, res) {
  const rows = await assets.listInvoices({ orgId: req.scopeOrgId, jobUuid: req.params.jobUuid });
  return ok(res, { items: rows }, "Invoices");
}

export async function removeAttachment(req, res) {
  const result = await assets.removeAssetAttachment({
    orgId: req.scopeOrgId,
    actorUuid: req.user?.uuid,
    attachmentUuid: req.params.attachmentUuid,
  });
  return ok(res, result, "Attachment removed");
}

export async function downloadAttachment(req, res) {
  const resolved = await assets.resolveAssetAttachment({
    orgId: req.scopeOrgId,
    attachmentUuid: req.params.attachmentUuid,
  });

  res.setHeader("Content-Type", resolved.mime_type || "application/octet-stream");
  // Quoted and stripped of anything that could break out of the header, because
  // file_name is attacker-influenced original-upload text.
  const safeName = String(resolved.file_name || "download").replace(/[^\w.\- ]+/g, "_");
  res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
  return res.sendFile(resolved.absolutePath);
}

// ---------------------------------------------------------------------------
// Retirement
// ---------------------------------------------------------------------------

export async function retireAsset(req, res) {
  const result = await assets.retireAsset({
    orgId: req.scopeOrgId,
    actorUuid: req.user?.uuid,
    assetUuid: req.params.uuid,
    reason: req.body?.reason ?? null,
  });
  return ok(res, result, "Asset retired");
}

export async function reinstateAsset(req, res) {
  const result = await assets.reinstateAsset({
    orgId: req.scopeOrgId,
    actorUuid: req.user?.uuid,
    assetUuid: req.params.uuid,
  });
  return ok(res, result, "Asset reinstated");
}