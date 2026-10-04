import { ok, created } from "../../utils/response.js";
import { parsePagination } from "../../utils/pagination.js";
import ApiError from "../../utils/ApiError.js";
import { sendPdf } from "../../utils/exportBuilders.js";
import { MERGE_TAGS, MANUAL_TAGS } from "../../utils/letterMerge.js";
import * as letters from "../../services/hrLetters.service.js";

/**
 * HTTP surface for HR Letters.
 *
 * Thin by design: validation of bodies and merge tags lives in the service, so
 * the same rules apply whether a letter is issued from HTTP, from a test, or
 * later from the Recruitment module's offer-acceptance flow.
 *
 * Every handler reads `req.scopeOrgId` and NEVER an organization id from the
 * body or params. That is the tenant boundary: the service scopes by it on every
 * query, so a caller who passes someone else's org id in a payload has it
 * ignored rather than obeyed.
 */

/** Fields a create/update request may set. Mirrors the service's own checks. */
const TEMPLATE_WRITABLE = ["letterType", "name", "body", "isActive"];

function pickWritable(body = {}, writable = TEMPLATE_WRITABLE) {
  const out = {};
  for (const key of writable) {
    if (Object.prototype.hasOwnProperty.call(body, key)) out[key] = body[key];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export async function listTemplates(req, res) {
  const data = await letters.listTemplates({
    orgId: req.scopeOrgId,
    letterType: req.query.letter_type || undefined,
    includeInactive: req.query.include_inactive === "1",
  });
  return ok(res, { items: data, merge_tags: MERGE_TAGS, manual_tags: MANUAL_TAGS }, "Templates");
}

export async function getTemplate(req, res) {
  const template = await letters.getTemplate({
    orgId: req.scopeOrgId,
    templateUuid: req.params.uuid,
  });
  return ok(res, { template }, "Template");
}

export async function createTemplate(req, res) {
  const template = await letters.createTemplate({
    orgId: req.scopeOrgId,
    actorUuid: req.user?.uuid,
    ...pickWritable(req.body),
  });
  return created(res, { template }, "Template created");
}

export async function updateTemplate(req, res) {
  const template = await letters.updateTemplate({
    orgId: req.scopeOrgId,
    templateUuid: req.params.uuid,
    actorUuid: req.user?.uuid,
    ...pickWritable(req.body),
  });
  return ok(res, { template }, "Template updated");
}

export async function deleteTemplate(req, res) {
  await letters.deleteTemplate({
    orgId: req.scopeOrgId,
    templateUuid: req.params.uuid,
    actorUuid: req.user?.uuid,
  });
  return ok(res, {}, "Template deleted");
}

// ---------------------------------------------------------------------------
// Letters
// ---------------------------------------------------------------------------

export async function listLetters(req, res) {
  const { page, limit, offset } = parsePagination(req.query);
  const data = await letters.listLetters({
    orgId: req.scopeOrgId,
    page,
    limit,
    offset,
    employeeUuid: req.query.employee_uuid || undefined,
    letterType: req.query.letter_type || undefined,
    status: req.query.status || undefined,
    search: req.query.search || undefined,
  });
  return ok(res, data, "Letters");
}

export async function getLetter(req, res) {
  const letter = await letters.getLetter({
    orgId: req.scopeOrgId,
    letterUuid: req.params.uuid,
  });
  return ok(res, { letter }, "Letter");
}

export async function createLetter(req, res) {
  const letter = await letters.createDraftLetter({
    orgId: req.scopeOrgId,
    actorUuid: req.user?.uuid,
    employeeUuid: req.body?.employee_uuid,
    templateUuid: req.body?.template_uuid,
    letterType: req.body?.letter_type,
    title: req.body?.title,
    values: req.body?.values ?? {},
  });
  return created(res, { letter }, "Draft letter created");
}

export async function issueLetter(req, res) {
  const letter = await letters.issueLetter({
    orgId: req.scopeOrgId,
    letterUuid: req.params.uuid,
    actorUuid: req.user?.uuid,
    values: req.body?.values ?? {},
  });
  return ok(res, { letter }, "Letter issued");
}

export async function revokeLetter(req, res) {
  const letter = await letters.revokeLetter({
    orgId: req.scopeOrgId,
    letterUuid: req.params.uuid,
    actorUuid: req.user?.uuid,
    reason: req.body?.reason,
  });
  return ok(res, { letter }, "Letter revoked");
}

/**
 * Return a revoked letter to draft.
 *
 * The re-issue is a separate, explicit step: reverting does NOT re-mint the QR
 * or set issued_at. Doing that here would let one click put a letter back into
 * circulation without anyone re-reading it, which is exactly what revoking was
 * meant to prevent.
 */
export async function revertLetter(req, res) {
  const letter = await letters.revertLetterToDraft({
    orgId: req.scopeOrgId,
    letterUuid: req.params.uuid,
    actorUuid: req.user?.uuid,
  });
  return ok(res, { letter }, "Letter reverted to draft");
}

export async function deleteLetter(req, res) {
  await letters.deleteLetter({
    orgId: req.scopeOrgId,
    letterUuid: req.params.uuid,
    actorUuid: req.user?.uuid,
  });
  return ok(res, {}, "Letter deleted");
}

export async function downloadLetterPdf(req, res) {
  const { buffer, filename } = await letters.renderLetterPdf({
    orgId: req.scopeOrgId,
    letterUuid: req.params.uuid,
  });
  return sendPdf(res, { filename, buffer });
}

export async function previewTemplate(req, res) {
  if (!req.body?.employee_uuid) throw new ApiError(400, "employee_uuid is required");
  const preview = await letters.previewTemplate({
    orgId: req.scopeOrgId,
    employeeUuid: req.body.employee_uuid,
    templateUuid: req.params.uuid,
    values: req.body?.values ?? {},
  });
  return ok(res, preview, "Preview");
}

// ---------------------------------------------------------------------------
// Public verification (no auth) — mounted in routes/index.js, not here.
// ---------------------------------------------------------------------------

export async function verifyPublicLetter(req, res) {
  const result = await letters.verifyLetterPublic({ qrToken: req.params.qr_token });
  // Fail closed with the SAME 404 the document-verification endpoint uses, so a
  // scanner cannot distinguish "no such letter" from "forged" or "revoked".
  if (!result) return res.status(404).json({ success: false, message: "Not found" });
  return res.status(200).json({ success: true, message: "Verified", data: result });
}