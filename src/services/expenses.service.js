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
 * One table. A claim is free text — an expense name, an amount, a date and an
 * optional receipt. There is no category policy table: the org cannot cap or
 * pre-approve what may be claimed, so review is the only gate.
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

async function inTransaction(conn, work) {
  if (conn !== pool) return work(conn);
  const transaction = await pool.getConnection();
  try {
    await transaction.beginTransaction();
    const result = await work(transaction);
    await transaction.commit();
    return result;
  } catch (error) {
    try {
      await transaction.rollback();
    } catch {
      // Preserve the business/SQL error that caused the rollback.
    }
    throw error;
  } finally {
    transaction.release();
  }
}

async function reimbursementPeriod(conn, orgId, employeeUuid, expenseDate) {
  const date = isoDate(expenseDate);
  let year = Number(date.slice(0, 4));
  let month = Number(date.slice(5, 7));
  while (year <= 2100) {
    await lockPayrollPeriod(conn, orgId, employeeUuid, year, month);
    const [existing] = await conn.query(
      `SELECT uuid FROM salary_records
        WHERE organization_id=? AND employee_uuid=? AND year=? AND month=?
        LIMIT 1`,
      [orgId, employeeUuid, year, month],
    );
    if (!existing.length) return { month, year };
    month += 1;
    if (month === 13) {
      month = 1;
      year += 1;
    }
  }
  throw new ApiError(409, "No eligible payroll period is available for this expense claim");
}

async function lockPayrollPeriod(conn, orgId, employeeUuid, year, month) {
  await conn.query(
    `INSERT INTO expense_payroll_period_locks (organization_id, employee_uuid, year, month)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE employee_uuid=VALUES(employee_uuid)`,
    [orgId, employeeUuid, year, month],
  );
  await conn.query(
    `SELECT employee_uuid FROM expense_payroll_period_locks
      WHERE organization_id=? AND employee_uuid=? AND year=? AND month=?
      FOR UPDATE`,
    [orgId, employeeUuid, year, month],
  );
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
export async function loadClaim({ orgId, claimUuid, conn = pool, forUpdate = false }) {
  assertUuid(claimUuid, "Claim UUID");
  const [rows] = await conn.query(`SELECT * FROM expense_claims WHERE uuid=? AND organization_id=?${forUpdate ? " FOR UPDATE" : ""}`, [
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
 * The employee supplies the expense name, amount and date. There is no policy
 * table to check against: a receipt is optional and nothing here caps the amount.
 */
export async function createClaim({
  orgId,
  actorUuid,
  employeeUuid,
  employeeName,
  expenseName,
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

  if (!expenseName || !String(expenseName).trim()) throw new ApiError(400, "expense_name is required");
  if (String(expenseName).trim().length > 160) throw new ApiError(400, "expense_name must be 160 characters or fewer");

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

  const employee = employeeUuid
    ? await employeeOnRoster(orgId, employeeUuid, conn)
    : null;
  const claimantName = employee?.full_name ?? String(employeeName ?? "").trim();
  if (!claimantName) throw new ApiError(400, "A claimant name is required");
  if (!employee && paymentMode !== "direct") {
    throw new ApiError(400, "Claims without an employee record must use direct payment");
  }
  const uuid = randomUUID();

  await conn.query(
    `INSERT INTO expense_claims
       (uuid, organization_id, employee_uuid, employee_name, expense_name, amount,
        expense_date, description, status, payment_mode, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NOW(), NOW())`,
    [
      uuid,
      orgId,
      employee?.uuid ?? null,
      claimantName,
      String(expenseName ?? "").trim(),
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

/**
 * Drop the retired `category_uuid` column from a claim row.
 *
 * The column survives as a nullable historical identifier (the migration keeps it
 * for auditability), but the category system is gone: returning it would advertise
 * a field no client can use and imply a policy that no longer exists.
 */
function withoutLegacyCategory(row) {
  const copy = { ...row };
  delete copy.category_uuid;
  return copy;
}

/** One claim with its receipts. */
export async function getClaim({ orgId, claimUuid, conn = pool }) {
  const claim = await loadClaim({ orgId, claimUuid, conn });
  const receipts = await attachments.listAttachments({
    orgId,
    entityType: ATTACHMENT_ENTITY.CLAIM,
    entityUuid: claim.uuid,
  });

  return {
    ...withoutLegacyCategory(claim),
    // Read through the shared helper, never toISOString(): mysql2 builds a DATE at
    // local midnight, so a claim dated the 1st arrives as the last day of the
    // previous month on any server east of UTC - and an expense filed on the 1st
    // would then be bucketed into the wrong payroll month.
    expense_date: isoDate(claim.expense_date),
    amount: money(claim.amount),
    expense_name: claim.expense_name || "Expense",
    receipts,
    receipt_count: receipts.length,
  };
}

/** Paginated claims for the org, optionally filtered. */
export async function listClaims(
  { orgId, status, employeeUuid, createdByUuid, month, fromDate, toDate, page, limit, offset, scopeFilter, conn = pool },
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
  if (employeeUuid && createdByUuid) {
    assertUuid(employeeUuid, "Employee UUID");
    clauses.push("(c.employee_uuid = ? OR c.created_by = ?)");
    params.push(employeeUuid, createdByUuid);
  } else if (employeeUuid) {
    assertUuid(employeeUuid, "Employee UUID");
    clauses.push("c.employee_uuid = ?");
    params.push(employeeUuid);
  } else if (createdByUuid) {
    clauses.push("c.created_by = ?");
    params.push(createdByUuid);
  }
  if (scopeFilter) {
    clauses.push(scopeFilter.sql);
    params.push(...scopeFilter.params);
  }
  if (month) {
    if (!/^\\d{4}-(0[1-9]|1[0-2])$/.test(String(month))) throw new ApiError(400, "month must use YYYY-MM format");
    clauses.push("c.expense_date >= ? AND c.expense_date < DATE_ADD(?, INTERVAL 1 MONTH)");
    params.push(`${month}-01`, `${month}-01`);
  }
  if (fromDate) {
    if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(String(fromDate))) throw new ApiError(400, "from_date must use YYYY-MM-DD format");
    clauses.push("c.expense_date >= ?");
    params.push(fromDate);
  }
  if (toDate) {
    if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(String(toDate))) throw new ApiError(400, "to_date must use YYYY-MM-DD format");
    clauses.push("c.expense_date <= ?");
    params.push(toDate);
  }
  if (fromDate && toDate && fromDate > toDate) throw new ApiError(400, "from_date cannot be after to_date");

  const where = clauses.join(" AND ");
  const [[{ total }]] = await conn.query(`SELECT COUNT(*) AS total FROM expense_claims c LEFT JOIN employees e ON e.uuid=c.employee_uuid WHERE ${where}`, params);
  const [rows] = await conn.query(
    `SELECT c.*,
            (SELECT COUNT(*) FROM attachments a
              WHERE a.entity_type='expense_claim' AND a.entity_uuid=c.uuid AND a.deleted_at IS NULL
            ) AS receipt_count
       FROM expense_claims c
       LEFT JOIN employees e ON e.uuid=c.employee_uuid
      WHERE ${where}
      ORDER BY c.expense_date DESC, c.id DESC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  return {
    items: rows.map((r) => ({
      ...withoutLegacyCategory(r),
      expense_date: isoDate(r.expense_date),
      amount: money(r.amount),
      receipt_count: Number(r.receipt_count ?? 0),
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
 * a failure produces is a claim with no receipt - which is an allowed state, since
 * receipts are optional here. Passing a `conn` anyway
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

export async function approveOwnClaim({ orgId, actorUuid, claimUuid, conn = pool }) {
  if (conn === pool) {
    return inTransaction(pool, (tx) => approveOwnClaim({ orgId, actorUuid, claimUuid, conn: tx }));
  }
  const claim = await loadClaim({ orgId, claimUuid, conn, forUpdate: true });
  if (claim.status !== "pending") throw new ApiError(409, `This claim was already ${claim.status}`);
  const period = claim.payment_mode === "payroll"
    ? await reimbursementPeriod(conn, orgId, claim.employee_uuid, claim.expense_date)
    : null;
  const [result] = await conn.query(
    `UPDATE expense_claims
        SET status='approved', auto_approved=1, auto_approved_by_uuid=?,
            reviewed_by_uuid=?, reviewed_at=NOW(), rejection_reason=NULL,
            reimbursement_month=?, reimbursement_year=?, updated_at=NOW()
      WHERE uuid=? AND organization_id=? AND status='pending'`,
    [
      actorUuid ?? null,
      actorUuid ?? null,
      period?.month ?? null,
      period?.year ?? null,
      claimUuid,
      orgId,
    ],
  );
  if (result.affectedRows !== 1) throw new ApiError(409, "This claim was reviewed concurrently");
  return getClaim({ orgId, claimUuid, conn });
}

/**
 * Approve or reject a claim.
 *
 * Receipts are optional, so nothing here blocks an approval for a missing one.
 * The reviewer chooses how an approved claim will be paid: `payroll` hands it to
 * the next payroll run, `direct` leaves it for a manual transfer.
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
  if (conn === pool) {
    return inTransaction(pool, (tx) =>
      reviewClaim({
        orgId,
        actorUuid,
        claimUuid,
        decision,
        rejectionReason,
        paymentMode,
        conn: tx,
      }),
    );
  }
  if (!["approved", "rejected"].includes(decision)) {
    throw new ApiError(400, "decision must be approved or rejected");
  }

  const claim = await loadClaim({ orgId, claimUuid, conn, forUpdate: true });
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

  if (decision === "rejected" && !String(rejectionReason ?? "").trim()) {
    // An unexplained rejection is not actionable by the employee, who then has to
    // ask HR what was wrong rather than being told.
    throw new ApiError(400, "A rejection needs a reason the employee can act on");
  }

  // The status='pending' in the WHERE is the real guard against a double decision,
  // and it is load-bearing under concurrency: two reviewers clicking approve at the
  // same moment both pass the `claim.status !== 'pending'` check above, and the
  // second UPDATE then matches zero rows. The lock and affectedRows check turn that
  // losing request into a 409 rather than returning a success-shaped response.
  //
  // No ER_DUP_ENTRY handler: this one really was only the retired same-day guard,
  // and it is gone from the schema.
  const period = decision === "approved" && mode === "payroll"
    ? await reimbursementPeriod(conn, orgId, claim.employee_uuid, claim.expense_date)
    : null;
  const [result] = await conn.query(
    `UPDATE expense_claims
        SET status=?, payment_mode=?, reviewed_by_uuid=?, reviewed_at=NOW(),
            rejection_reason=?, auto_approved=0, auto_approved_by_uuid=NULL,
            reimbursement_month=?, reimbursement_year=?, updated_at=NOW()
      WHERE uuid=? AND organization_id=? AND status='pending'`,
    [
      decision,
      mode,
      actorUuid ?? null,
      decision === "rejected" ? String(rejectionReason).trim() : null,
      period?.month ?? null,
      period?.year ?? null,
      claimUuid,
      orgId,
    ],
  );
  if (result.affectedRows !== 1) throw new ApiError(409, "This claim was reviewed concurrently");

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
  if (conn === pool) {
    return inTransaction(pool, (tx) =>
      markClaimPaid({ orgId, actorUuid, claimUuid, paymentReference, conn: tx }),
    );
  }
  const claim = await loadClaim({ orgId, claimUuid, conn, forUpdate: true });

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

  const [result] = await conn.query(
    `UPDATE expense_claims
        SET status='paid', paid_at=NOW(), payment_reference=?, updated_at=NOW()
      WHERE uuid=? AND organization_id=? AND status='approved'`,
    [paymentReference ? String(paymentReference).trim() : null, claimUuid, orgId],
  );
  if (result.affectedRows !== 1) throw new ApiError(409, "This claim was paid concurrently");
  await conn.query(
    `INSERT INTO expense_claim_payments
       (uuid, organization_id, claim_uuid, employee_uuid, payment_mode, amount,
        payment_reference, paid_at, performed_by_uuid)
     VALUES (?, ?, ?, ?, 'direct', ?, ?, NOW(), ?)`,
    [
      randomUUID(),
      orgId,
      claim.uuid,
      claim.employee_uuid,
      claim.amount,
      paymentReference ? String(paymentReference).trim() : null,
      actorUuid ?? null,
    ],
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
 * Approved, unpaid, payroll-mode claims eligible by this period.
 *
 * The one query payroll reads. Scoped three ways on purpose:
 *
 *   status = 'approved'  a claim already consumed by a previous run is 'paid' and
 *                        cannot be picked up again, which is what makes a
 *                        regenerated payroll period safe rather than a second
 *                        disbursement
 *   payment_mode         a direct claim is settled by bank transfer and must never
 *                        appear on a payslip, or it gets paid twice
 *   reimbursement period is assigned when approved, after checking whether its
 *                        expense period already has payroll. Any older unpaid
 *                        claim carries forward rather than being stranded by a
 *                        previously processed payroll.
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
  if (conn !== pool) await lockPayrollPeriod(conn, orgId, employeeUuid, y, m);

  const [rows] = await conn.query(
    `SELECT c.uuid, c.amount, c.expense_date, c.description, c.payment_mode, c.expense_name
       FROM expense_claims c
      WHERE c.organization_id = ?
        AND c.employee_uuid = ?
        AND c.status = 'approved'
        AND c.payment_mode = 'payroll'
        AND (
          COALESCE(c.reimbursement_year, c.expense_year) < ?
          OR (
            COALESCE(c.reimbursement_year, c.expense_year) = ?
            AND COALESCE(c.reimbursement_month, c.expense_month) <= ?
          )
        )
      ORDER BY c.expense_date ASC`,
    [orgId, employeeUuid, y, y, m],
  );

  return rows.map((r) => ({
    uuid: r.uuid,
    amount: money(r.amount),
    expense_date: isoDate(r.expense_date),
    description: r.description,
    expense_name: r.expense_name,
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
        ? `Expense reimbursement — ${claims[0].expense_name ?? "claim"}`
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

export async function assertNoExpensePaymentsForSalaryRecords({ conn, salaryRecordUuids }) {
  const ids = (salaryRecordUuids ?? []).filter(Boolean);
  if (!ids.length) return;
  const placeholders = ids.map(() => "?").join(",");
  const [rows] = await conn.query(
    `SELECT claim_uuid FROM expense_claim_payments
      WHERE salary_record_uuid IN (${placeholders}) LIMIT 1`,
    ids,
  );
  if (rows.length) {
    throw new ApiError(
      409,
      "This payroll contains paid expense reimbursements and cannot be deleted or regenerated; preserve its payment history.",
    );
  }
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
export async function markClaimsPaidByPayroll({
  conn,
  orgId,
  salaryRecordUuid,
  claims,
  now = null,
  performedByUuid = null,
}) {
  for (const claim of claims ?? []) {
    // Scoped by organization_id even though every claim here came from an
    // org-scoped read a few lines earlier. The read and the write are not the same
    // guarantee: an UPDATE that matches only on uuid would still move a row that
    // had been re-pointed at another tenant between the two, and this is the one
    // statement in the module that turns a claim into money. Defence in depth on a
    // money path costs nothing; a wrong-tenant disbursement costs a payroll.
    const lockedClaim = await loadClaim({
      orgId,
      claimUuid: claim.uuid,
      conn,
      forUpdate: true,
    });
    if (lockedClaim.status !== "approved" || lockedClaim.payment_mode !== "payroll") {
      throw new ApiError(409, `Expense claim ${claim.uuid} is no longer eligible for payroll`);
    }
    const [salaryRecords] = await conn.query(
      `SELECT uuid FROM salary_records
        WHERE uuid=? AND organization_id=? AND employee_uuid=?
        FOR UPDATE`,
      [salaryRecordUuid, orgId, lockedClaim.employee_uuid],
    );
    if (!salaryRecords.length) {
      throw new ApiError(409, "The payroll record does not belong to this claim's organization and employee");
    }
    const [result] = await conn.query(
      `UPDATE expense_claims
          SET status='paid', paid_at=COALESCE(?, NOW()),
              paid_via_salary_record_uuid=?, updated_at=NOW()
        WHERE uuid=? AND organization_id=? AND status='approved'`,
      [now, salaryRecordUuid, claim.uuid, orgId],
    );
    if (result.affectedRows !== 1) throw new ApiError(409, `Expense claim ${claim.uuid} was paid concurrently`);
    await conn.query(
      `INSERT INTO expense_claim_payments
         (uuid, organization_id, claim_uuid, employee_uuid, salary_record_uuid,
          payment_mode, amount, paid_at, performed_by_uuid)
       VALUES (?, ?, ?, ?, ?, 'payroll', ?, COALESCE(?, NOW()), ?)`,
      [
        randomUUID(),
        orgId,
        lockedClaim.uuid,
        lockedClaim.employee_uuid,
        salaryRecordUuid,
        lockedClaim.amount,
        now,
        performedByUuid,
      ],
    );
  }
}