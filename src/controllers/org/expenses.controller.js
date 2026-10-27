import ApiError from "../../utils/ApiError.js";
import { pool } from "../../config/db.js";
import { ok, created } from "../../utils/response.js";
import { assertUuid } from "../../utils/publicResponse.js";
import { parsePagination } from "../../utils/pagination.js";
import { logAudit, getActorFromReq } from "../../utils/auditLog.js";
import {
  listCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  listClaims,
  getClaim,
  createClaim,
  attachReceipts,
  removeReceipt,
  resolveReceipt,
  reviewClaim,
  markClaimPaid,
  bulkMarkClaimsPaid,
  autoApproveClaim,
  ATTACHMENT_ENTITY,
} from "../../services/expenses.service.js";

/**
 * HTTP surface for expense claims.
 *
 * Thin, like every other module controller here: the rules live in the service and
 * are enforced in the database. One thing is deliberate and worth stating - every
 * handler takes the organization from the session and NEVER from the body, so a
 * guessed claim or category uuid must 404 rather than return another tenant's
 * expense records.
 *
 * Receipts go through the shared attachments table with entity_type
 * 'expense_claim', which the attachments migration already documents as the
 * worked example. No file column is added to this module's own table, because
 * attachments is what supplies tenant scoping, the path-traversal guard, soft
 * delete and the audit entry.
 *
 * STAFF DO NOT FILE CLAIMS. There is no create handler in the staff half of this
 * file, and that is the rule rather than an omission: the staff gate is
 * requirePermission("approve_expenses"), which is unconditionally true for an
 * org_admin, so a staff creation route would let the one account that can approve
 * any reimbursement originate one - approving its own. Claims are created only by
 * submitMyExpenseClaim below, which takes the claimant from the session.
 */

/** The caller's own employee row, or null. */
async function callerEmployee(orgId, req) {
  const [rows] = await pool.query(
    "SELECT uuid, full_name FROM employees WHERE linked_user_uuid=? AND organization_id=?",
    [req.user?.uuid, orgId],
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Categories (staff)
// ---------------------------------------------------------------------------

export async function listExpenseCategories(req, res) {
  const includeInactive = req.query.include_inactive === "1" || req.query.include_inactive === "true";
  const items = await listCategories({ orgId: req.scopeOrgId, includeInactive });
  return ok(res, { items }, "Expense categories");
}

export async function createExpenseCategory(req, res) {
  const category = await createCategory({
    orgId: req.scopeOrgId,
    actorId: req.user?.id ?? null,
    name: req.body?.name,
    description: req.body?.description,
    maxLimitPerClaim: req.body?.max_limit_per_claim,
    requiresReceipt: req.body?.requires_receipt,
  });
  logAudit({
    ...getActorFromReq(req),
    action: "expense_category.create",
    entityType: "expense_category",
    entityId: category.uuid,
    details: { name: category.name, requires_receipt: category.requires_receipt },
    req,
  });
  return created(res, { category }, "Expense category created");
}

/**
 * Edit a category.
 *
 * Org from the session, never the body — the same rule as every handler here, and
 * the reason a guessed category uuid cannot reach another tenant's policy.
 */
export async function updateExpenseCategory(req, res) {
  const category = await updateCategory({
    orgId: req.scopeOrgId,
    actorUuid: req.user?.uuid ?? null,
    categoryUuid: req.params.uuid,
    name: req.body?.name,
    description: req.body?.description,
    maxLimitPerClaim: req.body?.max_limit_per_claim,
    requiresReceipt: req.body?.requires_receipt,
    isActive: req.body?.is_active,
  });
  logAudit({
    ...getActorFromReq(req),
    action: "expense_category.update",
    entityType: "expense_category",
    entityId: category.uuid,
    details: {
      name: category.name,
      requires_receipt: category.requires_receipt,
      max_limit_per_claim: category.max_limit_per_claim,
      is_active: category.is_active,
    },
    req,
  });
  return ok(res, { category }, "Expense category updated");
}

/**
 * Retire a category. Deactivates rather than erasing — see deleteCategory in the
 * service for why a claim that has been reimbursed must keep the category it was
 * filed under.
 */
export async function deleteExpenseCategory(req, res) {
  const result = await deleteCategory({
    orgId: req.scopeOrgId,
    actorUuid: req.user?.uuid ?? null,
    categoryUuid: req.params.uuid,
  });
  logAudit({
    ...getActorFromReq(req),
    action: "expense_category.delete",
    entityType: "expense_category",
    entityId: req.params.uuid,
    // claims_preserved is the interesting half of this entry: it records that the
    // category was retired rather than destroyed, and how much history rides on it.
    details: { claims_preserved: result.claimsPreserved },
    req,
  });
  // camelCase in the service, snake_case on the wire, like every other field this
  // API returns. The client reads `claims_preserved` to decide what the toast says.
  return ok(
    res,
    { retired: result.retired, claims_preserved: result.claimsPreserved },
    "Expense category removed",
  );
}

// ---------------------------------------------------------------------------
// Claims (staff) — read, review, settle. Never create.
// ---------------------------------------------------------------------------

export async function listExpenseClaims(req, res) {
  const { page, limit, offset } = parsePagination(req.query);
  const result = await listClaims({
    orgId: req.scopeOrgId,
    status: req.query.status,
    employeeUuid: req.query.employee_uuid,
    categoryUuid: req.query.category_uuid,
    page,
    limit,
    offset,
  });
  return ok(res, result, "Expense claims");
}

export async function getExpenseClaim(req, res) {
  const claim = await getClaim({ orgId: req.scopeOrgId, claimUuid: req.params.uuid });
  return ok(res, { claim }, "Expense claim");
}

export async function reviewExpenseClaim(req, res) {
  const claim = await reviewClaim({
    orgId: req.scopeOrgId,
    actorUuid: req.user?.uuid ?? null,
    claimUuid: req.params.uuid,
    decision: req.body?.decision,
    rejectionReason: req.body?.rejection_reason,
    paymentMode: req.body?.payment_mode,
  });
  logAudit({
    ...getActorFromReq(req),
    action: `expense_claim.${claim.status}`,
    entityType: ATTACHMENT_ENTITY.CLAIM,
    entityId: claim.uuid,
    details: {
      amount: claim.amount,
      rejection_reason: claim.rejection_reason,
      payment_mode: claim.payment_mode,
    },
    req,
  });
  return ok(res, { claim }, `Expense claim ${claim.status}`);
}

export async function payExpenseClaim(req, res) {
  const claim = await markClaimPaid({
    orgId: req.scopeOrgId,
    actorUuid: req.user?.uuid ?? null,
    claimUuid: req.params.uuid,
    paymentReference: req.body?.payment_reference,
  });
  logAudit({
    ...getActorFromReq(req),
    action: "expense_claim.paid",
    entityType: ATTACHMENT_ENTITY.CLAIM,
    entityId: claim.uuid,
    details: { amount: claim.amount, payment_reference: claim.payment_reference },
    req,
  });
  return ok(res, { claim }, "Expense claim marked paid");
}

export async function bulkPayExpenseClaims(req, res) {
  const result = await bulkMarkClaimsPaid({
    orgId: req.scopeOrgId,
    actorUuid: req.user?.uuid ?? null,
    claimUuids: req.body?.claim_uuids,
    paymentReference: req.body?.payment_reference,
  });
  logAudit({
    ...getActorFromReq(req),
    action: "expense_claim.bulk_paid",
    entityType: ATTACHMENT_ENTITY.CLAIM,
    entityId: null,
    details: { paid: result.paid.length, refused: result.refused.length },
    req,
  });
  // Partial success is REPORTED, not silently swallowed: a batch that quietly
  // skipped the claims it could not settle leaves the caller believing the whole
  // batch is done.
  return ok(res, result, "Expense claims settled");
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

export async function uploadExpenseReceipts(req, res) {
  const rows = await attachReceipts({
    orgId: req.scopeOrgId,
    actorUuid: req.user?.uuid ?? null,
    claimUuid: req.params.uuid,
    files: req.files ?? [],
    description: req.body?.description ?? null,
  });
  return ok(res, { items: rows }, "Receipts uploaded");
}

export async function removeExpenseReceipt(req, res) {
  const result = await removeReceipt({
    orgId: req.scopeOrgId,
    actorUuid: req.user?.uuid ?? null,
    attachmentUuid: req.params.attachmentUuid,
  });
  return ok(res, result, "Receipt removed");
}

export async function downloadExpenseReceipt(req, res) {
  const resolved = await resolveReceipt({
    orgId: req.scopeOrgId,
    attachmentUuid: req.params.attachmentUuid,
  });
  res.setHeader("Content-Type", resolved.mime_type || "application/octet-stream");
  // file_name is attacker-influenced original-upload text, so anything that could
  // break out of the header is replaced before it goes in.
  const safeName = String(resolved.file_name || "receipt").replace(/[^\w.\- ]+/g, "_");
  res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
  return res.sendFile(resolved.absolutePath);
}

// ---------------------------------------------------------------------------
// Employee self-service
// ---------------------------------------------------------------------------

/**
 * The categories this employee may file a claim under.
 *
 * EXISTS BECAUSE THE ESS PORTAL CANNOT USE THE STAFF ROUTE.
 *
 * GET /org/expense-categories is gated `requireRole("org_admin","sub_admin")` +
 * `requirePermission("approve_expenses")`. An employee is neither, so the
 * employee portal's category dropdown was calling a URL that answered 403 — and
 * because a failed query leaves `data` undefined, the form rendered its EMPTY
 * state: "No categories found. Create a new category first." That message is a
 * lie here. Categories existed, the employee simply was not allowed to be told
 * about them, and the page told them to go create one instead — a page they
 * cannot reach. The same shape as the receipt-upload bug this module already
 * documents: a card wired to the staff service 403s silently inside the one
 * action the portal exists to enable.
 *
 * Read-only and derived from the SESSION's org, so an employee can see what they
 * may claim but cannot create, deactivate or edit a category — that stays with
 * staff. Active only: an inactive category cannot be filed against, so offering
 * it would produce a submission the server then refuses on the limit/active check.
 */
export async function myExpenseCategories(req, res) {
  const orgId = req.scopeOrgId ?? req.user?.organization;
  const items = await listCategories({ orgId, includeInactive: false });
  return ok(res, { items }, "Expense categories");
}

/**
 * The employee's own claims, and nothing else's.
 *
 * Derived from the session rather than from a parameter, because "list claims for
 * a colleague" is not a feature.
 */
export async function myExpenseClaims(req, res) {
  const orgId = req.scopeOrgId ?? req.user?.organization;
  const employee = await callerEmployee(orgId, req);
  if (!employee) {
    return ok(res, { items: [], total: 0, page: 1, limit: 20 }, "No claims");
  }

  const { page, limit, offset } = parsePagination(req.query);
  const result = await listClaims({
    orgId,
    employeeUuid: employee.uuid,
    status: req.query.status,
    page,
    limit,
    offset,
  });
  return ok(res, result, "My expense claims");
}

export async function submitMyExpenseClaim(req, res) {
  const orgId = req.scopeOrgId ?? req.user?.organization;
  const employee = await callerEmployee(orgId, req);
  if (!employee) {
    throw new ApiError(
      403,
      "Your account is not linked to an employee record, so it cannot file an expense claim",
    );
  }

  // employee_uuid is NOT read from the body. It is the caller's own row, always.
  // Accepting it would let anyone file a claim against a colleague and have the
  // company reimburse them.
  const claim = await createClaim({
    orgId,
    actorUuid: req.user?.uuid ?? null,
    employeeUuid: employee.uuid,
    categoryUuid: req.body?.category_uuid,
    amount: req.body?.amount,
    expenseDate: req.body?.expense_date,
    description: req.body?.description,
    paymentMode: req.body?.payment_mode,
  });

  /*
   * AUTO-APPROVAL, requested by the caller.
   *
   * Whether it is HONORED is not this function's decision and not the checkbox's.
   * `autoApproveClaim` applies the three rules - approve_expenses authority, no
   * self-approval, and the receipt requirement the manual review also enforces -
   * and returns a reason when it refuses.
   *
   * A REFUSAL IS NOT AN ERROR. The claim has already been filed by the time this
   * runs, and the whole point of the design is that it stays filed: an employee
   * who ticked a box they cannot act on should not lose their claim, they should
   * get a pending one. That is why the reason is surfaced as a warning on the
   * response rather than thrown, and why nothing here rolls anything back.
   */
  const autoApproveRefusal = await autoApproveClaim({
    orgId,
    actorUuid: req.user?.uuid ?? null,
    employeeUuid: employee.uuid,
    claimUuid: claim.uuid,
    categoryUuid: claim.category_uuid ?? req.body?.category_uuid,
    // Read from the request, never from the body. An account that cannot approve
    // claims must not be able to word itself into being able to by sending a flag.
    canApproveExpenses: Boolean(req.canApproveExpenses),
  });

  logAudit({
    ...getActorFromReq(req),
    action: "expense_claim.submit_self",
    entityType: ATTACHMENT_ENTITY.CLAIM,
    entityId: claim.uuid,
    details: {
      amount: claim.amount,
      expense_date: claim.expense_date,
      auto_approve_requested: Boolean(req.body?.auto_approve),
      auto_approve_refusal: autoApproveRefusal,
    },
    req,
  });

  return created(res, { claim, auto_approve_refusal: autoApproveRefusal }, "Expense claim submitted");
}

export async function myExpenseClaimDetail(req, res) {
  const orgId = req.scopeOrgId ?? req.user?.organization;
  const employee = await callerEmployee(orgId, req);
  if (!employee) throw new ApiError(403, "Your account is not linked to an employee record");

  // loadClaim already scopes by org; the ownership check on top is what stops an
  // employee opening a colleague's claim by uuid.
  const claim = await getClaim({ orgId, claimUuid: req.params.uuid });
  if (claim.employee_uuid !== employee.uuid) {
    throw new ApiError(404, "Expense claim not found");
  }
  assertUuid(req.params.uuid, "Claim UUID");
  return ok(res, { claim }, "Expense claim");
}

// ---------------------------------------------------------------------------
// Employee self-service: receipts on their OWN claim
// ---------------------------------------------------------------------------

/**
 * The caller's own claim, proven to be theirs.
 *
 * Returns the employee AND the claim together because every ESS receipt handler
 * needs both, and re-deriving the employee inside each one is how one of them
 * ends up skipping the ownership check. A 404 rather than a 403: a claim that is
 * not yours should be indistinguishable from one that does not exist.
 */
async function callersOwnClaim(orgId, req, claimUuid) {
  const employee = await callerEmployee(orgId, req);
  if (!employee) {
    throw new ApiError(403, "Your account is not linked to an employee record");
  }
  const claim = await getClaim({ orgId, claimUuid });
  if (claim.employee_uuid !== employee.uuid) {
    throw new ApiError(404, "Expense claim not found");
  }
  return { employee, claim };
}

export async function uploadMyExpenseReceipts(req, res) {
  const orgId = req.scopeOrgId ?? req.user?.organization;
  const { claim } = await callersOwnClaim(orgId, req, req.params.uuid);

  const rows = await attachReceipts({
    orgId,
    actorUuid: req.user?.uuid ?? null,
    claimUuid: claim.uuid,
    files: req.files ?? [],
    description: req.body?.description ?? null,
  });

  logAudit({
    ...getActorFromReq(req),
    action: "expense_claim.receipt.upload_self",
    entityType: ATTACHMENT_ENTITY.CLAIM,
    entityId: claim.uuid,
    details: { count: rows.length },
    req,
  });

  return ok(res, { items: rows }, "Receipts uploaded");
}

/**
 * Resolve one of the caller's own attachments.
 *
 * attachments.entity_uuid has no foreign key, so this walks from the attachment to
 * the claim and then proves the claim belongs to the caller. Deleting or reading
 * straight off the attachment would let an employee act on any receipt in the
 * tenant if they guessed a uuid.
 */
async function callersOwnAttachment(orgId, req, attachmentUuid) {
  const [rows] = await pool.query(
    `SELECT entity_type, entity_uuid FROM attachments
      WHERE uuid=? AND organization_id=? AND deleted_at IS NULL`,
    [attachmentUuid, orgId],
  );
  if (!rows.length) throw new ApiError(404, "Attachment not found");
  if (rows[0].entity_type !== ATTACHMENT_ENTITY.CLAIM) {
    throw new ApiError(400, "That file does not belong to an expense claim");
  }
  await callersOwnClaim(orgId, req, rows[0].entity_uuid);
  return attachmentUuid;
}

export async function removeMyExpenseReceipt(req, res) {
  const orgId = req.scopeOrgId ?? req.user?.organization;
  const attachmentUuid = await callersOwnAttachment(orgId, req, req.params.attachmentUuid);

  const result = await removeReceipt({
    orgId,
    actorUuid: req.user?.uuid ?? null,
    attachmentUuid,
  });

  logAudit({
    ...getActorFromReq(req),
    action: "expense_claim.receipt.remove_self",
    entityType: ATTACHMENT_ENTITY.CLAIM,
    entityId: result?.entity_uuid ?? null,
    details: { attachment_uuid: attachmentUuid },
    req,
  });

  return ok(res, result, "Receipt removed");
}

export async function downloadMyExpenseReceipt(req, res) {
  const orgId = req.scopeOrgId ?? req.user?.organization;
  await callersOwnAttachment(orgId, req, req.params.attachmentUuid);

  const resolved = await resolveReceipt({ orgId, attachmentUuid: req.params.attachmentUuid });
  res.setHeader("Content-Type", resolved.mime_type || "application/octet-stream");
  // file_name is attacker-influenced original-upload text, so anything that could
  // break out of the header is replaced before it goes in.
  const safeName = String(resolved.file_name || "receipt").replace(/[^\w.\- ]+/g, "_");
  res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
  return res.sendFile(resolved.absolutePath);
}