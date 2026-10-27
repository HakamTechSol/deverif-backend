import ApiError from "../../utils/ApiError.js";
import { pool } from "../../config/db.js";
import { ok, created } from "../../utils/response.js";
import { assertUuid } from "../../utils/publicResponse.js";
import { parsePagination, paginatedResponse } from "../../utils/pagination.js";
import { logAudit, getActorFromReq } from "../../utils/auditLog.js";
import {
  createExitRequest,
  getExitRequest,
  decideExitRequest,
  clearChecklistItem,
  getOutstandingAssets,
  calculateSettlement,
  saveSettlement,
  processSettlement,
  completeExit,
  getMyExit,
} from "../../services/offboarding.service.js";
import { isoDate } from "../../utils/dateRange.js";
import { sendOffboardingUpdateEmail } from "../../utils/mailer.js";

/**
 * HTTP surface for offboarding.
 *
 * Deliberately thin. The rules - one open exit per employee, no payment while an
 * asset is held, no completion while the checklist is open - live in the service
 * and are enforced in the database, because a rule that only exists in a
 * controller is a rule that a second caller, a script or a future endpoint will
 * quietly step around.
 *
 * The one thing done here rather than in the service is tenant scoping: every
 * query takes the organization from the session, never from the request body, so
 * a guessed exit uuid must 404 rather than return another tenant's termination.
 */

/** The employee's own employees row, or a 403 if they have none. */
async function callerEmployee(orgId, req) {
  assertUuid(req.user?.uuid, "User UUID");
  const [rows] = await pool.query(
    "SELECT uuid, full_name, email FROM employees WHERE linked_user_uuid=? AND organization_id=?",
    [req.user.uuid, orgId],
  );
  if (!rows.length) {
    // Staff with no employee record have nothing to resign from. Not an error
    // worth a 403 either - the page simply shows "you have no exit request".
    return null;
  }
  return rows[0];
}

/**
 * Every exit that still has clearance work open, across the organization.
 *
 * The one view a department lead actually opens: "what is waiting on us". Per-exit
 * checklists are useful for the exit in front of you; this answers the other
 * question, which is how many exits are in flight and who is holding each one up.
 */
export async function listExitChecklistPending(req, res) {
  const orgId = req.scopeOrgId;
  const [rows] = await pool.query(
    `SELECT er.uuid AS exit_request_uuid, er.employee_uuid, er.employee_name, er.designation,
            er.status, er.request_type, er.last_working_day,
            GROUP_CONCAT(DISTINCT c.department
              ORDER BY FIELD(c.department,'IT','Finance','Assets','HR') SEPARATOR ',') AS pending_departments,
            COUNT(*) AS pending_count,
            (SELECT COUNT(*) FROM offboarding_checklists c2
              WHERE c2.exit_request_uuid = er.uuid) AS total_count,
            (SELECT COUNT(*) FROM asset_assignments g
              WHERE g.employee_uuid = er.employee_uuid AND g.returned_at IS NULL
                AND g.organization_id = er.organization_id) AS assets_outstanding
       FROM offboarding_checklists c
       JOIN exit_requests er ON er.uuid = c.exit_request_uuid
      WHERE er.organization_id = ?
        AND er.status IN ('pending','approved')
        AND c.status = 'pending'
      GROUP BY er.uuid, er.employee_uuid, er.employee_name, er.designation,
               er.status, er.request_type, er.last_working_day
      ORDER BY er.last_working_day ASC, er.employee_name`,
    [orgId],
  );

  // last_working_day comes back as a Date at local midnight, so it is normalised
  // through the shared helper rather than toISOString(), which returns the day
  // before on a server east of UTC. A dashboard that sorts everyone one day early
  // makes a Friday exit look like it is due Thursday.
  const items = rows.map((r) => ({
    ...r,
    last_working_day: isoDate(r.last_working_day),
    pending_departments: String(r.pending_departments ?? "").split(",").filter(Boolean),
  }));

  return ok(res, { items, count: items.length }, "Clearances outstanding");
}

// ---------------------------------------------------------------------------
// Exit requests (staff)
// ---------------------------------------------------------------------------

export async function listExitRequests(req, res) {
  const orgId = req.scopeOrgId;
  const { page, limit, offset } = parsePagination(req.query);

  const clauses = ["er.organization_id = ?"];
  const params = [orgId];

  const status = req.query.status ? String(req.query.status) : "";
  if (status) {
    if (!["pending", "approved", "rejected", "completed"].includes(status)) {
      throw new ApiError(400, "status must be one of: pending, approved, rejected, completed");
    }
    clauses.push("er.status = ?");
    params.push(status);
  }
  if (req.query.employee_uuid) {
    clauses.push("er.employee_uuid = ?");
    params.push(req.query.employee_uuid);
  }
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  if (search) {
    // Scoped to this org's own exit records so another tenant's employee name is
    // never discoverable by typing it here.
    clauses.push("(er.employee_name LIKE ? OR er.reason LIKE ?)");
    params.push(`%${search}%`, `%${search}%`);
  }

  const where = clauses.join(" AND ");

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM exit_requests er WHERE ${where}`,
    params,
  );
  const [rows] = await pool.query(
    `SELECT er.uuid, er.employee_uuid, er.employee_name, er.designation, er.request_type,
            er.last_working_day,
            GREATEST(DATEDIFF(er.last_working_day, DATE(er.created_at)), 0) AS days_until_last_working_day,
            er.status, er.reason,
            er.created_at, er.decided_at, er.completed_at,
            (SELECT COUNT(*) FROM offboarding_checklists c
              WHERE c.exit_request_uuid = er.uuid AND c.status = 'pending') AS clearance_pending,
            (SELECT COUNT(*) FROM offboarding_checklists c
              WHERE c.exit_request_uuid = er.uuid) AS clearance_total,
            (SELECT COUNT(*) FROM asset_assignments g
              WHERE g.employee_uuid = er.employee_uuid AND g.returned_at IS NULL
                AND g.organization_id = er.organization_id) AS assets_outstanding,
            (SELECT fs.status FROM final_settlements fs
              WHERE fs.exit_request_uuid = er.uuid) AS settlement_status,
            (SELECT fs.net_fnf_amount FROM final_settlements fs
              WHERE fs.exit_request_uuid = er.uuid) AS net_fnf_amount
       FROM exit_requests er
      WHERE ${where}
      ORDER BY er.created_at DESC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  return ok(res, paginatedResponse(rows, total, page, limit), "Exit requests");
}

export async function getExitRequestDetail(req, res) {
  const detail = await getExitRequest({ orgId: req.scopeOrgId, exitUuid: req.params.uuid });
  return ok(res, { exit_request: detail }, "Exit request");
}

export async function submitExitRequest(req, res) {
  const orgId = req.scopeOrgId;
  const { employee_uuid, request_type, last_working_day, reason, hr_notes } =
    req.body || {};

  if (request_type !== "termination") {
    throw new ApiError(403, "Org Admins can submit termination requests only. Employees must submit their own resignation.");
  }

  const result = await createExitRequest({
    orgId,
    actorUuid: req.user?.uuid ?? null,
    employeeUuid: employee_uuid,
    requestType: request_type,
    lastWorkingDay: last_working_day,
    reason,
    hrNotes: hr_notes,
    // Always starts pending. An approved exit created in one step would skip the
    // review that exists to catch a mistake before it becomes a termination.
    status: "pending",
  });

  logAudit({
    ...getActorFromReq(req),
    action: "exit_request.create",
    entityType: "exit_request",
    entityId: result.uuid,
    details: { employee_uuid: result.employeeUuid, request_type, last_working_day },
    req,
  });

  const detail = await getExitRequest({ orgId, exitUuid: result.uuid });
  let emailWarning = null;
  try {
    await sendOffboardingUpdateEmail({
      to: result.employeeEmail,
      employeeName: result.employeeName,
      requestType: detail.request_type,
      status: detail.status,
      lastWorkingDay: detail.last_working_day,
      daysUntilLastWorkingDay: detail.days_until_last_working_day,
      reason: detail.reason,
    });
  } catch (error) {
    emailWarning = result.employeeEmail
      ? "Exit request saved, but its email could not be delivered. Check the employee email and mail settings."
      : "Exit request saved, but this employee has no email address on file.";
    console.error("Failed to send offboarding email:", error.message);
  }
  return created(res, { exit_request: detail, _email_warning: emailWarning }, "Exit request submitted");
}

export async function reviewExitRequest(req, res) {
  const orgId = req.scopeOrgId;
  const { decision, last_working_day, decision_notes } = req.body || {};

  const detail = await decideExitRequest({
    orgId,
    actorUuid: req.user?.uuid ?? null,
    exitUuid: req.params.uuid,
    decision,
    lastWorkingDay: last_working_day,
    // The body is snake_case and the service takes camelCase, so the rename is
    // explicit. Written as a bare `decisionNotes` this was a ReferenceError at
    // runtime: `node --check` passes it, the unit tests never reach this handler,
    // and the request answers 500 with a masked body while the service works
    // perfectly when called directly.
    decisionNotes: decision_notes,
  });

  logAudit({
    ...getActorFromReq(req),
    action: `exit_request.${decision}`,
    entityType: "exit_request",
    entityId: req.params.uuid,
    details: {
      last_working_day: detail.last_working_day,
      days_until_last_working_day: detail.days_until_last_working_day,
    },
    req,
  });

  let emailWarning = null;
  try {
    const [[employee]] = await pool.query(
      "SELECT email FROM employees WHERE uuid=? AND organization_id=?",
      [detail.employee_uuid, orgId],
    );
    await sendOffboardingUpdateEmail({
      to: employee?.email,
      employeeName: detail.employee_name,
      requestType: detail.request_type,
      status: detail.status,
      lastWorkingDay: detail.last_working_day,
      daysUntilLastWorkingDay: detail.days_until_last_working_day,
      reason: detail.reason,
    });
  } catch (error) {
    emailWarning = "Exit request was saved, but the employee email could not be delivered.";
    console.error("Failed to send offboarding decision email:", error.message);
  }

  return ok(res, { exit_request: detail, _email_warning: emailWarning }, `Exit request ${decision}`);
}

export async function clearExitChecklistItem(req, res) {
  const detail = await clearChecklistItem({
    orgId: req.scopeOrgId,
    actorUuid: req.user?.uuid ?? null,
    exitUuid: req.params.uuid,
    checklistUuid: req.params.checklistUuid,
    notes: req.body?.notes,
  });
  return ok(res, { exit_request: detail }, "Clearance task cleared");
}

export async function listExitAssets(req, res) {
  const orgId = req.scopeOrgId;
  const detail = await getExitRequest({ orgId, exitUuid: req.params.uuid });
  const assets = await getOutstandingAssets({ orgId, employeeUuid: detail.employee_uuid });
  return ok(res, assets, "Assets outstanding");
}

// ---------------------------------------------------------------------------
// Final settlement
// ---------------------------------------------------------------------------

/**
 * A preview, not a write.
 *
 * FnF is derived from leave allocations, salary history and open asset
 * assignments, so it has to be inspectable before it is committed - and the
 * figures move as clearance progresses, which is exactly when someone wants to
 * see them again.
 */
export async function previewSettlement(req, res) {
  const calc = await calculateSettlement({ orgId: req.scopeOrgId, exitUuid: req.params.uuid });
  return ok(res, calc, "Settlement preview");
}

export async function draftSettlement(req, res) {
  const orgId = req.scopeOrgId;
  const settlement = await saveSettlement({
    orgId,
    actorUuid: req.user?.uuid ?? null,
    exitUuid: req.params.uuid,
    notes: req.body?.notes,
  });

  logAudit({
    ...getActorFromReq(req),
    action: "exit_settlement.draft",
    entityType: "exit_settlement",
    entityId: settlement.uuid,
    details: {
      net_fnf_amount: settlement.net_fnf_amount,
      leave_encashment: settlement.leave?.amount,
      asset_deductions: settlement.assets?.applied,
    },
    req,
  });

  return created(res, { settlement }, "Settlement drafted");
}

export async function advanceSettlement(req, res) {
  const orgId = req.scopeOrgId;
  const target = req.body?.target === "paid" ? "paid" : "processed";

  const settlement = await processSettlement({
    orgId,
    actorUuid: req.user?.uuid ?? null,
    exitUuid: req.params.uuid,
    target,
    paymentReference: req.body?.payment_reference,
  });

  logAudit({
    ...getActorFromReq(req),
    action: `exit_settlement.${target}`,
    entityType: "exit_settlement",
    entityId: settlement.uuid,
    details: { net_fnf_amount: settlement.net_fnf_amount, payment_reference: settlement.payment_reference },
    req,
  });

  return ok(res, { settlement }, `Settlement ${target}`);
}

export async function completeExitRequest(req, res) {
  const orgId = req.scopeOrgId;
  const detail = await completeExit({
    orgId,
    actorUuid: req.user?.uuid ?? null,
    exitUuid: req.params.uuid,
    hrNotes: req.body?.hr_notes,
  });

  logAudit({
    ...getActorFromReq(req),
    action: "exit_request.complete",
    entityType: "exit_request",
    entityId: req.params.uuid,
    details: { employee_uuid: detail.employee_uuid, employee_name: detail.employee_name },
    req,
  });

  return ok(res, { exit_request: detail }, "Exit completed");
}

// ---------------------------------------------------------------------------
// Employee self-service
// ---------------------------------------------------------------------------

/**
 * The employee's own exit view.
 *
 * Read-only. An employee sees their request, their clearance progress and their
 * settlement total - not the asset deduction arithmetic, which the service
 * withholds deliberately.
 */
export async function myExit(req, res) {
  const orgId = req.scopeOrgId ?? req.user?.organization;
  const employee = await callerEmployee(orgId, req);
  if (!employee) {
    // Same shape as a real response, including on_roster: a client branching on
    // `exit_request === null` alone would render the resignation form for an
    // account that cannot file one.
    return ok(
      res,
      {
        on_roster: false,
        employee_status: null,
        exit_request: null,
        checklist: [],
        checklistSummary: null,
        settlement: null,
        outstanding_assets: 0,
      },
      "No exit request",
    );
  }
  return ok(res, await getMyExit({ orgId, employeeUuid: employee.uuid }), "My exit");
}

/**
 * An employee submits their OWN resignation.
 *
 * Two restrictions, both load-bearing. The employee is derived from the session
 * rather than accepted from the body, because "submit a resignation for someone
 * else" is not a feature. And request_type is hardcoded to 'resignation' - an
 * employee cannot file a termination against themselves, which would otherwise be
 * a way to have their own employment ended by an API call.
 *
 * The last working day is the sole date input; its distance from the request date
 * is calculated and returned to the employee.
 */
export async function submitMyResignation(req, res) {
  const orgId = req.scopeOrgId ?? req.user?.organization;
  const employee = await callerEmployee(orgId, req);
  if (!employee) {
    throw new ApiError(403, "Your account is not linked to an employee record, so it cannot file a resignation");
  }

  const result = await createExitRequest({
    orgId,
    actorUuid: req.user?.uuid ?? null,
    employeeUuid: employee.uuid,
    requestType: "resignation",
    submittedByEmployee: true,
    lastWorkingDay: req.body?.last_working_day,
    reason: req.body?.reason,
    hrNotes: null,
    status: "pending",
  });

  logAudit({
    ...getActorFromReq(req),
    action: "exit_request.submit_self",
    entityType: "exit_request",
    entityId: result.uuid,
    details: { employee_uuid: employee.uuid, last_working_day: req.body?.last_working_day },
    req,
  });

  const detail = await getExitRequest({ orgId, exitUuid: result.uuid });
  let emailWarning = null;
  try {
    await sendOffboardingUpdateEmail({
      to: employee.email,
      employeeName: employee.full_name,
      requestType: detail.request_type,
      status: detail.status,
      lastWorkingDay: detail.last_working_day,
      daysUntilLastWorkingDay: detail.days_until_last_working_day,
      reason: detail.reason,
    });
  } catch (error) {
    emailWarning = employee.email
      ? "Resignation saved, but its confirmation email could not be delivered. Check mail settings."
      : "Resignation saved, but no email address is on file for this employee.";
    console.error("Failed to send resignation email:", error.message);
  }
  return created(res, { exit_request: detail, _email_warning: emailWarning }, "Resignation submitted");
}
