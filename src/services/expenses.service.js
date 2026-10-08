import { randomUUID } from "node:crypto";
import ApiError from "../utils/ApiError.js";
import { pool } from "../config/db.js";
import { assertUuid } from "../utils/publicResponse.js";
import { isoDate } from "../utils/dateRange.js";
import * as attachments from "./attachments.service.js";
import { logAudit } from "../utils/auditLog.js";

/**
 * Expense claims: an employee spends company money, and gets it back.
 *
 * Two tables. expense_categories is the org's policy - what may be claimed, up to
 * what, and whether a receipt is mandatory. expense_claims is the money.
 *
 * THE INVARIANT THIS MODULE EXISTS TO PROTECT: a claim is paid exactly once.
 *
 * Payroll reimburses approved claims that go through payroll, and a claim can also
 * be settled directly as a bank transfer. Two administrators, two clicks, one
 * expense paid twice is otherwise the default outcome, because the window between
 * "approved" and "paid" is long enough for it to happen. Three things prevent it:
 *
 *   - approval does not mark anything paid. There is a distinct, terminal `paid`
 *     state and only two ways into it.
 *   - every write into `paid` is guarded by the state it moves FROM: approval
 *     updates `WHERE status='pending'`, a manual settlement `WHERE status='approved'`,
 *     and a payroll run `WHERE status='approved'`. Two concurrent runs therefore
 *     cannot both win - the loser matches zero rows.
 *   - paid_via_salary_record_uuid names the record that consumed each claim, so a
 *     claim can be traced to the payslip that carried it and cannot be re-run.
 *
 * THERE IS NO `is_paid` COLUMN, and that is worth being explicit about. `status`
 * alone carries it: 'paid' IS the flag. An earlier draft of this module described
 * the guards in terms of `is_paid=0`, which reads like an extra safety net but was
 * never real - and a comment describing a column that does not exist is worse than
 * no comment, because it sends the next reader hunting for a second source of truth
 * that was never there.
 *
 * `paid` IS TERMINAL. Re-marking a paid claim would be the cheapest possible way
 * to pay someone twice, and there is no operational reason to want it.
 */

/** Attachment entity type. `expense_claim` is the name the attachments migration documents. */
export const ATTACHMENT_ENTITY = { CLAIM: "expense_claim" };
export const ATTACHMENT_CATEGORY = { RECEIPT: "expense_receipt" };

export const CLAIM_STATUSES = ["pending", "approved", "rejected", "paid"];
export const PAYMENT_MODES = ["payroll", "direct"];

/**
 * How far back a claim may be dated.
 *
 * A policy number, not a schema constraint, so it can be changed without a
 * migration. Ninety days is roughly a quarter: long enough that an employee
 * remembering last month's taxi can claim it, short enough that a claim cannot be
 * filed against a payroll period that closed last year.
 */
export const MAX_BACKDATE_DAYS = 90;

function money(n) {
  const v = Math.round(Number(n) * 100) / 100;
  // Normalise negative zero: Math.round(-0 * 100) / 100 is -0, which JSON
  // serialises as -0 and which Object.is treats as different from 0. An adjustment
  // of "nothing" should not reach the client signed.
  return v === 0 ? 0 : v;
}

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ""))) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime());
}

function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

function daysBetween(fromIso, toIso) {
  const a = new Date(`${fromIso}T00:00:00Z`).getTime();
  const b = new Date(`${toIso}T00:00:00Z`).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86400000);
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/**
 * List this org's categories.
 *
 * Scoped by organization_id, always. A global category list would be a tenant
 * leak on the cheapest query in the module.
 */
export async function listCategories({ orgId, includeInactive = false, conn = pool }) {
  const sql = includeInactive
    ? "SELECT * FROM expense_categories WHERE organization_id=? ORDER BY name"
    : "SELECT * FROM expense_categories WHERE organization_id=? AND is_active=1 ORDER BY name";
  const [rows] = await conn.query(sql, [orgId]);
  return rows;
}

export async function createCategory({
  orgId,
  actorId,
  name,
  description,
  maxLimitPerClaim,
  requiresReceipt,
  conn = pool,
}) {
  if (!name || !String(name).trim()) throw new ApiError(400, "name is required");

  let limit = null;
  if (maxLimitPerClaim !== undefined && maxLimitPerClaim !== null && maxLimitPerClaim !== "") {
    limit = money(maxLimitPerClaim);
    if (!Number.isFinite(limit) || limit <= 0) {
      // 0 is refused rather than stored, because a zero ceiling reads as "nothing
      // may be claimed" and an org that wants that has no category at all. NULL is
      // how you say "no limit".
      throw new ApiError(400, "max_limit_per_claim must be a positive amount, or omitted for no limit");
    }
  }

  const uuid = randomUUID();
  try {
    await conn.query(
      `INSERT INTO expense_categories
         (uuid, organization_id, name, description, max_limit_per_claim, requires_receipt, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        uuid,
        orgId,
        String(name).trim(),
        description ? String(description).trim() : null,
        limit,
        requiresReceipt ? 1 : 0,
        actorId ?? null,
      ],
    );
  } catch (e) {
    if (e.code === "ER_DUP_ENTRY") {
      throw new ApiError(409, "An expense category with this name already exists for the organization");
    }
    throw e;
  }
  const [rows] = await conn.query("SELECT * FROM expense_categories WHERE uuid=? AND organization_id=?", [
    uuid,
    orgId,
  ]);
  return rows[0];
}

/** Load a category, proving it belongs to THIS organization. */
export async function loadCategory({ orgId, categoryUuid, conn = pool, requireActive = true }) {
  assertUuid(categoryUuid, "Category UUID");
  const [rows] = await conn.query(
    `SELECT * FROM expense_categories WHERE uuid=? AND organization_id=?${requireActive ? " AND is_active=1" : ""}`,
    [categoryUuid, orgId],
  );
  if (!rows.length) throw new ApiError(404, "Expense category not found in this organization");
  return rows[0];
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

/**
 * Load a claim scoped to the organization.
 *
 * Every path goes through here. attachments.entity_uuid has NO foreign key -
 * it points at a different table per entity_type - so nothing in the database
 * stops an attachment being attached to another organization's claim. This
 * function is the enforcement point.
 */
export async function loadClaim({ orgId, claimUuid, conn = pool }) {
  assertUuid(claimUuid, "Claim UUID");
  const [rows] = await conn.query("SELECT * FROM expense_claims WHERE uuid=? AND organization_id=?", [
    claimUuid,
    orgId,
  ]);
  if (!rows.length) throw new ApiError(404, "Expense claim not found");
  return rows[0];
}

/** The employee must exist, belong to this org, and still be on the roster. */
export async function employeeOnRoster(orgId, employeeUuid, conn = pool) {
  assertUuid(employeeUuid, "Employee UUID");
  // `status` MUST be in this list. It was not, which made the leaver check below
  // permanently false: the row was found, `employee.status` was undefined, and
  // every former employee could file claims against an organization they had left.
  // A guard that reads a column the query never asked for is a guard that cannot
  // fail, which is the same defect the retired same-day index had - caught here by
  // an assertion that the ex-employee path rejects, not by reading the code.
  const [rows] = await conn.query(
    "SELECT uuid, full_name, status FROM employees WHERE uuid=? AND organization_id=?",
    [employeeUuid, orgId],
  );
  if (!rows.length) throw new ApiError(404, "Employee not found in this organization");
  const employee = rows[0];
  if (employee.status === "ex_employee") {
    throw new ApiError(409, "This employee has left the organization, so they cannot file a claim");
  }
  return employee;
}

/**
 * File a claim.
 *
 * The category's limit is checked HERE as well as at review, so the employee is
 * told the claim is too large before they have typed the description, rather than
 * after HR has spent time on it. It is checked at BOTH ends deliberately: the
 * limit can be lowered between submission and review, and a limit that was only
 * enforced on submission would let a claim through that the policy no longer
 * allows.
 */
export async function createClaim({
  orgId,
  actorUuid,
  employeeUuid,
  categoryUuid,
  amount,
  expenseDate,
  description,
  paymentMode = "payroll",
  conn = pool,
}) {
  if (!PAYMENT_MODES.includes(paymentMode)) {
    throw new ApiError(400, "payment_mode must be payroll or direct");
  }
  if (!isValidDate(expenseDate)) throw new ApiError(400, "expense_date must be a valid YYYY-MM-DD date");

  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) {
    throw new ApiError(400, "amount must be a positive number");
  }

  // A future expense is a typo or an attempt to claim a period that has not
  // happened yet - which, if it slipped through, would be reimbursed on a payroll
  // nobody has run.
  if (daysBetween(expenseDate, isoToday()) < 0) {
    throw new ApiError(400, "expense_date cannot be in the future");
  }
  const backdated = daysBetween(expenseDate, isoToday());
  if (backdated > MAX_BACKDATE_DAYS) {
    throw new ApiError(
      400,
      `expense_date cannot be more than ${MAX_BACKDATE_DAYS} days ago`,
    );
  }

  const category = await loadCategory({ orgId, categoryUuid, conn });
  if (category.max_limit_per_claim !== null && value > Number(category.max_limit_per_claim)) {
    throw new ApiError(
      400,
      `This claim exceeds the ${category.name} limit of ${money(category.max_limit_per_claim)} per claim`,
    );
  }

  const employee = await employeeOnRoster(orgId, employeeUuid, conn);
  const uuid = randomUUID();

  await conn.query(
    `INSERT INTO expense_claims
       (uuid, organization_id, employee_uuid, employee_name, category_uuid, amount,
        expense_date, description, status, payment_mode, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NOW(), NOW())`,
    [
      uuid,
      orgId,
      employee.uuid,
      employee.full_name,
      category.uuid,
      money(value),
      expenseDate,
      description ? String(description).trim() : null,
      paymentMode,
      actorUuid ?? null,
    ],
  );

  // Deliberately no duplicate handling here. This catch block used to translate
  // ER_DUP_ENTRY into "an approved, unpaid claim already exists for this employee
  // on that date and payment mode" - true when the one-claim-per-day guard was
  // still in force, but the guard was retired by 20261114 and is now GONE from the
  // schema. Left in place it would have kept returning a message describing a
  // policy that no longer exists, on the one trigger it can now only reach via a
  // randomUUID collision. Two legitimate same-day claims are allowed, so there is
  // nothing here to catch.

  return getClaim({ orgId, claimUuid: uuid, conn });
}

/** One claim with its category name and its receipts. */
export async function getClaim({ orgId, claimUuid, conn = pool }) {
  const claim = await loadClaim({ orgId, claimUuid, conn });
  const [categoryRows] = await conn.query(
    "SELECT name, requires_receipt, max_limit_per_claim FROM expense_categories WHERE uuid=?",
    [claim.category_uuid],
  );
  const receipts = await attachments.listAttachments({
    orgId,
    entityType: ATTACHMENT_ENTITY.CLAIM,
    entityUuid: claim.uuid,
  });

  const requiresReceipt = Boolean(Number(categoryRows[0]?.requires_receipt));

  return {
    ...claim,
    // Read through the shared helper, never toISOString(): mysql2 builds a DATE at
    // local midnight, so a claim dated the 1st arrives as the last day of the
    // previous month on any server east of UTC - and an expense filed on the 1st
    // would then be bucketed into the wrong payroll month.
    expense_date: isoDate(claim.expense_date),
    amount: money(claim.amount),
    category_name: categoryRows[0]?.name ?? null,
    category_requires_receipt: requiresReceipt,
    category_max_limit: categoryRows[0]?.max_limit_per_claim ?? null,
    receipts,
    receipt_count: receipts.length,
    /**
     * Whether this claim is READY to approve.
     *
     * A category that requires a receipt cannot be approved without one, and the
     * answer belongs on the record rather than in the reviewer's head - "attach a
     * receipt or it will be rejected" is enforced by a flag the UI can show, not
     * by everyone remembering.
     */
    receipt_satisfied: !requiresReceipt || receipts.length > 0,
  };
}

/** Paginated claims for the org, optionally filtered. */
export async function listClaims(
  { orgId, status, employeeUuid, categoryUuid, page, limit, offset, conn = pool },
) {
  const clauses = ["c.organization_id = ?"];
  const params = [orgId];

  if (status) {
    if (!CLAIM_STATUSES.includes(status)) {
      throw new ApiError(400, `status must be one of: ${CLAIM_STATUSES.join(", ")}`);
    }
    clauses.push("c.status = ?");
    params.push(status);
  }
  if (employeeUuid) {
    clauses.push("c.employee_uuid = ?");
    params.push(employeeUuid);
  }
  if (categoryUuid) {
    clauses.push("c.category_uuid = ?");
    params.push(categoryUuid);
  }

  const where = clauses.join(" AND ");
  const [[{ total }]] = await conn.query(`SELECT COUNT(*) AS total FROM expense_claims c WHERE ${where}`, params);
  const [rows] = await conn.query(
    `SELECT c.*, cat.name AS category_name, cat.requires_receipt AS category_requires_receipt,
            (SELECT COUNT(*) FROM attachments a
              WHERE a.entity_type='expense_claim' AND a.entity_uuid=c.uuid AND a.deleted_at IS NULL
            ) AS receipt_count
       FROM expense_claims c
       LEFT JOIN expense_categories cat ON cat.uuid = c.category_uuid
      WHERE ${where}
      ORDER BY c.expense_date DESC, c.id DESC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  return {
    items: rows.map((r) => ({
      ...r,
      expense_date: isoDate(r.expense_date),
      amount: money(r.amount),
      receipt_count: Number(r.receipt_count ?? 0),
      category_requires_receipt: Boolean(Number(r.category_requires_receipt)),
      receipt_satisfied:
        !Number(r.category_requires_receipt) || Number(r.receipt_count ?? 0) > 0,
    })),
    total: Number(total),
    page,
    limit,
  };
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

/**
 * Attach receipts to a claim.
 *
 * The claim is verified to exist in THIS org first: attachments.entity_uuid has
 * no foreign key, so without that check an upload against a guessed uuid would
 * create a file row belonging to nobody and fail much later, if at all.
 *
 * NOTE ON TRANSACTIONS. The attachments service takes no connection and always
 * writes on the pool, so this row is not part of any transaction the caller may be
 * running. That is acceptable here and is not a shortcut: an attachment and a claim
 * are independent records with no cross-table invariant between them, so the worst
 * a failure produces is a claim with no receipt - which is precisely the state the
 * requires_receipt approval guard already exists to catch. Passing a `conn` anyway
 * would be worse than useless: the zod schema is non-strict, so it would be
 * silently stripped and the code would appear transaction-safe while not being.
 */
export async function attachReceipts({
  orgId,
  actorUuid,
  claimUuid,
  files,
  description,
}) {
  const claim = await loadClaim({ orgId, claimUuid });
  if (claim.status === "rejected") {
    throw new ApiError(409, "A rejected claim cannot have receipts added to it");
  }
  const rows = await attachments.createAttachments({
    orgId,
    entityType: ATTACHMENT_ENTITY.CLAIM,
    entityUuid: claim.uuid,
    uploadedByUuid: actorUuid ?? null,
    category: ATTACHMENT_CATEGORY.RECEIPT,
    description: description ?? null,
    files,
  });
  logAudit({
    actorType: "user",
    actorId: actorUuid ?? null,
    action: "expense_claim.attachment.add",
    entityType: ATTACHMENT_ENTITY.CLAIM,
    entityId: claim.uuid,
    details: { count: rows.length },
  });
  return rows;
}

/**
 * Remove one of the claim's receipts.
 *
 * The entity_type check is not optional. removeAttachment scopes by organization
 * only, so without this an expense claim's receipt would be deletable through
 * /org/asset-attachments/:uuid - one module's routes reaching another module's
 * files. assets.service.js guards the same way and tests pin it.
 */
export async function removeReceipt({ orgId, actorUuid, attachmentUuid, conn = pool }) {
  const [rows] = await conn.query(
    `SELECT uuid, entity_type, entity_uuid FROM attachments
      WHERE uuid=? AND organization_id=? AND deleted_at IS NULL`,
    [attachmentUuid, orgId],
  );
  if (!rows.length) throw new ApiError(404, "Attachment not found");
  if (rows[0].entity_type !== ATTACHMENT_ENTITY.CLAIM) {
    throw new ApiError(400, "That file does not belong to an expense claim");
  }
  // Confirms the owning claim is visible in this organization.
  await loadClaim({ orgId, claimUuid: rows[0].entity_uuid, conn });
  return attachments.removeAttachment({ orgId, attachmentUuid, actorUuid });
}

/**
 * Resolve a receipt for download.
 *
 * No connection: the attachments service does not accept one, and pretending
 * otherwise would have the zod schema strip the extra key and leave the code
 * looking transaction-safe without being. Tenancy is enforced inside
 * resolveForDownload by the organization_id on its single SELECT, and ownership by
 * the entity_type check in removeReceipt's caller path.
 */
export function resolveReceipt({ orgId, attachmentUuid }) {
  return attachments.resolveForDownload({ orgId, attachmentUuid });
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

/**
 * Approve or reject a claim.
 *
 * Approval refuses a claim whose category requires a receipt and has none. That
 * refusal is the reason the attachments integration exists at all: without it a
 * receipt is optional decoration, and "we required a receipt" is unenforceable.
 *
 * It also re-checks the category limit. The limit is enforced at submission too,
 * but a category can be tightened between the two, and approving against a stale
 * policy is how an org ends up reimbursing what its own rules now forbid.
 */
export async function reviewClaim({
  orgId,
  actorUuid,
  claimUuid,
  decision,
  rejectionReason,
  paymentMode,
  conn = pool,
}) {
  if (!["approved", "rejected"].includes(decision)) {
    throw new ApiError(400, "decision must be approved or rejected");
  }

  const claim = await loadClaim({ orgId, claimUuid, conn });
  if (claim.status !== "pending") {
    // Re-deciding is how an approved claim quietly becomes a rejected one with
    // nothing in the record to say it was ever approved.
    throw new ApiError(409, `This claim was already ${claim.status}`);
  }

  let mode = claim.payment_mode;
  if (paymentMode !== undefined) {
    if (!PAYMENT_MODES.includes(paymentMode)) {
      throw new ApiError(400, "payment_mode must be payroll or direct");
    }
    mode = paymentMode;
  }

  if (decision === "rejected" && !rejectionReason) {
    // An unexplained rejection is not actionable by the employee, who then has to
    // ask HR what was wrong rather than being told.
    throw new ApiError(400, "A rejection needs a reason the employee can act on");
  }

  if (decision === "approved") {
    const category = await loadCategory({ orgId, categoryUuid: claim.category_uuid, conn });
    // Written as a plain null test to match the submission-side check. The previous
    // `Number(limit) !== null` guard was always true - Number(null) is 0, not null -
    // so it read as a deliberate special case while being a no-op.
    if (category.max_limit_per_claim !== null && Number(claim.amount) > Number(category.max_limit_per_claim)) {
      throw new ApiError(
        409,
        `This claim of ${money(claim.amount)} exceeds the current ${category.name} limit of ${money(
          category.max_limit_per_claim,
        )}`,
      );
    }

    if (Number(category.requires_receipt)) {
      const [receipts] = await conn.query(
        `SELECT COUNT(*) AS n FROM attachments
          WHERE organization_id=? AND entity_type=? AND entity_uuid=? AND deleted_at IS NULL`,
        [orgId, ATTACHMENT_ENTITY.CLAIM, claim.uuid],
      );
      if (Number(receipts[0].n) === 0) {
        throw new ApiError(
          409,
          `${category.name} claims require a receipt, and this one has none attached`,
        );
      }
    }
  }

  // The status='pending' in the WHERE is the real guard against a double decision,
  // and it is load-bearing under concurrency: two reviewers clicking approve at the
  // same moment both pass the `claim.status !== 'pending'` check above, and the
  // second UPDATE then matches zero rows. Nothing inspects affectedRows here, so a
  // losing request returns the winner's already-approved claim instead of an error
  // - acceptable, because both reviewers wanted the same outcome. It would NOT be
  // acceptable if one wanted to approve and the other to reject; that case is
  // covered because the loser's getClaim re-reads the row rather than trusting its
  // own decision.
  //
  // No ER_DUP_ENTRY handler: this one really was only the retired same-day guard,
  // and it is gone from the schema.
  await conn.query(
    `UPDATE expense_claims
        SET status=?, payment_mode=?, reviewed_by_uuid=?, reviewed_at=NOW(),
            rejection_reason=?, updated_at=NOW()
      WHERE uuid=? AND organization_id=? AND status='pending'`,
    [
      decision,
      mode,
      actorUuid ?? null,
      decision === "rejected" ? String(rejectionReason).trim() : null,
      claimUuid,
      orgId,
    ],
  );

  return getClaim({ orgId, claimUuid, conn });
}

/**
 * Mark a DIRECT claim paid.
 *
 * Only for payment_mode='direct'. A payroll-mode claim is paid by the payroll run
 * itself, which is the whole point: letting an administrator mark one paid by hand
 * means it can be paid twice - once here and once on the next payroll run.
 */
export async function markClaimPaid({
  orgId,
  actorUuid,
  claimUuid,
  paymentReference,
  conn = pool,
}) {
  const claim = await loadClaim({ orgId, claimUuid, conn });

  if (claim.status === "paid") throw new ApiError(409, "This claim has already been paid");
  if (claim.status !== "approved") {
    throw new ApiError(409, "Only an approved claim can be marked paid");
  }
  if (claim.payment_mode !== "direct") {
    throw new ApiError(
      409,
      "This claim is set to be paid through payroll. Change its payment mode, or let the payroll run pay it",
    );
  }

  await conn.query(
    `UPDATE expense_claims
        SET status='paid', paid_at=NOW(), payment_reference=?, updated_at=NOW()
      WHERE uuid=? AND organization_id=? AND status='approved'`,
    [paymentReference ? String(paymentReference).trim() : null, claimUuid, orgId],
  );

  return getClaim({ orgId, claimUuid, conn });
}

/**
 * Move several APPROVED direct claims to paid in one call.
 *
 * A bulk endpoint that is not careful about which claims it touches is how a
 * payroll run's claims get "helpfully" marked paid and then paid again, so this
 * routes every claim through markClaimPaid rather than issuing one blanket
 * UPDATE, and therefore inherits its refusal of anything that is not both
 * approved AND direct.
 *
 * A refused claim is COLLECTED AND REPORTED rather than thrown. Partial success is
 * the normal outcome of a bulk action - one claim is already settled, one belongs
 * to payroll, one is still pending - and a handler that threw on the first of those
 * would leave the caller with no idea how far it got, or whether the rest of the
 * batch ran. The response always carries both lists so a settled batch can never be
 * mistaken for a complete one.
 */
export async function bulkMarkClaimsPaid({ orgId, actorUuid, claimUuids, paymentReference, conn = pool }) {
  const ids = (Array.isArray(claimUuids) ? claimUuids : []).filter(Boolean);
  if (!ids.length) throw new ApiError(400, "claim_uuids is required");
  if (ids.length > 100) throw new ApiError(400, "At most 100 claims can be settled at once");

  const results = { paid: [], refused: [] };
  for (const id of ids) {
    try {
      await markClaimPaid({ orgId, actorUuid, claimUuid: id, paymentReference, conn });
      results.paid.push(id);
    } catch (e) {
      results.refused.push({ uuid: id, reason: e.message });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Payroll integration
// ---------------------------------------------------------------------------

/**
 * Approved, unpaid, payroll-mode claims dated inside a period.
 *
 * The one query payroll reads. Scoped three ways on purpose:
 *
 *   status = 'approved'  a claim already consumed by a previous run is 'paid' and
 *                        cannot be picked up again, which is what makes a
 *                        regenerated payroll period safe rather than a second
 *                        disbursement
 *   payment_mode         a direct claim is settled by bank transfer and must never
 *                        appear on a payslip, or it gets paid twice
 *   expense_date         bucketed by the date the money was SPENT, not by when the
 *                        claim was filed - claiming in March for a February taxi
 *                        belongs in February's payroll
 *
 * Takes a connection so payroll can read and write in one transaction. Reading on
 * the pool and writing on a transaction is how a claim ends up marked paid against a
 * payroll that then rolls back.
 */
export async function getApprovedClaimsForPeriod({
  orgId,
  employeeUuid,
  month,
  year,
  conn = pool,
}) {
  assertUuid(employeeUuid, "Employee UUID");
  const m = Number(month);
  const y = Number(year);
  if (!Number.isInteger(m) || m < 1 || m > 12) throw new ApiError(400, "month must be between 1 and 12");

  const [rows] = await conn.query(
    `SELECT c.uuid, c.amount, c.expense_date, c.description, c.payment_mode,
            cat.name AS category_name
       FROM expense_claims c
       LEFT JOIN expense_categories cat ON cat.uuid = c.category_uuid
      WHERE c.organization_id = ?
        AND c.employee_uuid = ?
        AND c.status = 'approved'
        AND c.payment_mode = 'payroll'
        AND c.expense_year = ?
        AND c.expense_month = ?
      ORDER BY c.expense_date ASC`,
    [orgId, employeeUuid, y, m],
  );

  return rows.map((r) => ({
    uuid: r.uuid,
    amount: money(r.amount),
    expense_date: isoDate(r.expense_date),
    description: r.description,
    category_name: r.category_name,
  }));
}

/**
 * Turn approved claims into a payslip line.
 *
 * Separate from getApprovedClaimsForPeriod so the read can be reused by a preview
 * that writes nothing, and so the arithmetic is stated once. Returns null rather
 * than a zero line when there is nothing to reimburse - a Rs 0.00 reimbursement
 * row on every payslip is noise that teaches people to ignore the lines that
 * matter.
 */
export function expenseReimbursementLine(claims) {
  const total = money((claims ?? []).reduce((sum, c) => sum + Number(c.amount), 0));
  if (total <= 0) return null;
  return {
    label:
      claims.length === 1
        ? `Expense reimbursement — ${claims[0].category_name ?? "claim"}`
        : `Expense reimbursement (${claims.length} claims)`,
    type: "earning",
    source: "auto_expense",
    amount: total,
    basis_value: claims.length,
    basis_unit: "claims",
    // Which claims, so a payslip can be reconciled against them and so an auditor
    // can find the receipts from the line.
    claim_uuids: claims.map((c) => c.uuid),
  };
}

/**
 * Move claims from a deleted salary record onto its replacement.
 *
 * Called when a payroll period is regenerated. The old salary_record is deleted and
 * a new one written, but the claims it disbursed are NOT released - see the reasoning
 * in generatePayroll, where releasing them would risk a second disbursement. So
 * paid_via_salary_record_uuid is repointed instead.
 *
 * Without this, every claim reimbursed by a regenerated period would name a
 * salary_record uuid that no longer exists, and the one piece of evidence tying a
 * reimbursement to the payslip that carried it would resolve to nothing.
 *
 * The WHERE is pinned to status='paid' as well as the old record uuids: this must
 * never touch a claim that is merely approved, so that a bug in the caller cannot
 * mark an unpaid claim as paid by naming the wrong record.
 */
export async function repointClaimsPaidByPayroll({ conn, orgId, salaryRecordUuid, previousRecordUuids }) {
  const ids = (previousRecordUuids ?? []).filter(Boolean);
  if (!ids.length) return 0;

  const placeholders = ids.map(() => "?").join(",");
  const [result] = await conn.query(
    `UPDATE expense_claims
        SET paid_via_salary_record_uuid=?, updated_at=NOW()
      WHERE organization_id=? AND status='paid' AND paid_via_salary_record_uuid IN (${placeholders})`,
    [salaryRecordUuid, orgId, ...ids]
  );
  return result.affectedRows;
}

/**
 * Mark the claims a payroll run consumed as paid.
 *
 * MUST be called on the same connection and inside the same transaction as the
 * salary_record INSERT. If the payroll rolls back after this runs, the claims
 * would be marked paid for money that was never disbursed - and being 'paid' is
 * exactly what stops them being picked up by the next run, so the reimbursement
 * would be lost silently and appear on no payslip.
 */
export async function markClaimsPaidByPayroll({ conn, orgId, salaryRecordUuid, claims, now = null }) {
  for (const claim of claims ?? []) {
    // Scoped by organization_id even though every claim here came from an
    // org-scoped read a few lines earlier. The read and the write are not the same
    // guarantee: an UPDATE that matches only on uuid would still move a row that
    // had been re-pointed at another tenant between the two, and this is the one
    // statement in the module that turns a claim into money. Defence in depth on a
    // money path costs nothing; a wrong-tenant disbursement costs a payroll.
    await conn.query(
      `UPDATE expense_claims
          SET status='paid', paid_at=COALESCE(?, NOW()),
              paid_via_salary_record_uuid=?, updated_at=NOW()
        WHERE uuid=? AND organization_id=? AND status='approved'`,
      [now, salaryRecordUuid, claim.uuid, orgId],
    );
  }
}