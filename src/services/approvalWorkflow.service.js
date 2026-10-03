import { z } from "zod";
import { pool } from "../config/db.js";
import ApiError from "../utils/ApiError.js";
import { logAudit } from "../utils/auditLog.js";
import {
  createNotificationForOrgUsers,
  createNotificationForUsers,
} from "../controllers/notification.controller.js";

/**
 * Generic multi-step approval workflow.
 *
 * Six of the fourteen HR modules introduced by the expansion need a
 * submit → review → decide chain (Expense, Travel, Leave escalation, Recruitment
 * offers, Separation, Help Desk). Each of those modules keeps its OWN domain
 * table and points here through (entity_type, entity_uuid); this service never
 * writes to a domain table. That separation is deliberate — it means adding a
 * module cannot break another module's approval logic, and the audit trail lives
 * in one place instead of six status columns that drift apart.
 *
 * Invariants this file is responsible for:
 *
 *   - ONE in-flight approval per (organization, entity_type, entity_uuid). This
 *     is enforced by the `uk_approval_requests_one_live` unique index over the
 *     generated `live_entity_uuid` column, NOT only by the pre-check below: a
 *     check alone is racy, and two concurrent submits of the same expense would
 *     both pass it. The database is the authority; the check is only there to
 *     produce a readable 409 instead of a raw ER_DUP_ENTRY.
 *
 *   - TENANT ISOLATION. Every read is scoped by organization_id, including the
 *     "find my requests" queries. A caller who guesses another org's request
 *     uuid gets 404, never that org's data.
 *
 *   - REJECTION IS TERMINAL. An entity can be resubmitted after rejection
 *     (the unique index permits it, because `live_entity_uuid` is NULL once
 *     resolved), but a rejected request itself never reopens.
 *
 *   - HISTORY IS APPEND-ONLY. Every transition writes a row to
 *     approval_step_history. Nothing in this file updates or deletes one.
 */

/** MySQL duplicate-entry error, used to detect the live-approval race. */
const ER_DUP_ENTRY = 1062;

const startSchema = z.object({
  orgId: z.number().int().positive(),
  moduleKey: z.string().min(2).max(60),
  entityType: z.string().min(2).max(60),
  entityUuid: z.string().min(1).max(64),
  requestedByUuid: z.string().min(1).max(64),
  title: z.string().max(200).optional().nullable(),
  payload: z.record(z.unknown()).optional().nullable(),
});

const decideSchema = z.object({
  orgId: z.number().int().positive(),
  requestUuid: z.string().min(1).max(64),
  actorUuid: z.string().min(1).max(64),
  decision: z.enum(["approve", "reject"]),
  comments: z.string().max(2000).optional().nullable(),
});

const cancelSchema = z.object({
  orgId: z.number().int().positive(),
  requestUuid: z.string().min(1).max(64),
  actorUuid: z.string().min(1).max(64),
  reason: z.string().max(2000).optional().nullable(),
});

function validate(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first.path.join(".");
    throw new ApiError(400, `${path || "input"}: ${first.message}`);
  }
  return result.data;
}

/**
 * Which users may act on a given step.
 *
 * Returns [] when a step is configured but cannot be resolved to anybody. That
 * is treated as a hard error by the callers rather than quietly skipped: a step
 * with no approver would leave the approval pending forever with nothing
 * surfaced to the user, which is the worst possible outcome for a workflow.
 *
 * NOTE ON 'reporting_manager': the employees table has no reports_to column
 * today (that arrives with the Manpower module's org chart in Phase 5), so this
 * branch deliberately refuses instead of guessing. Wiring it to `promoted_by_uuid`
 * would be wrong — that records who promoted the employee, not who manages them.
 */
async function resolveApprovers(executor, { orgId, step }) {
  switch (step.approver_type) {
    case "org_admin":
    case "sub_admin": {
      const [rows] = await executor.query(
        `SELECT uuid FROM users
          WHERE organization=? AND org_role=? AND status='active' AND deleted_at IS NULL`,
        [orgId, step.approver_type]
      );
      return rows.map((r) => r.uuid);
    }
    case "specific_user":
      return step.approver_uuid ? [step.approver_uuid] : [];
    case "reporting_manager":
      throw new ApiError(
        501,
        "This workflow step is set to 'reporting manager', which requires the Organization Chart " +
          "(Manpower Management) to be configured first. Use an explicit approver instead."
      );
    default:
      return [];
  }
}

async function loadSteps(executor, workflowId) {
  const [rows] = await executor.query(
    `SELECT id, uuid, step_order, name, approver_type, approver_uuid, required_approvals
       FROM workflow_steps
      WHERE workflow_id=?
      ORDER BY step_order ASC`,
    [workflowId]
  );
  return rows;
}

/**
 * Load the workflow configured for (org, module, entity_type), creating a
 * sensible single-step default the first time an organization uses a module.
 *
 * The default is PERSISTED rather than synthesised in memory because
 * approval_requests.workflow_id is NOT NULL: an approval has to point at the
 * exact chain that approved it, even when that chain was the fallback. The
 * unique key on workflow_definitions makes the insert race-safe — a concurrent
 * second call loses on duplicate entry and simply re-reads the winner's row.
 */
async function resolveWorkflow(executor, { orgId, moduleKey, entityType, actorUuid }) {
  const [existing] = await executor.query(
    `SELECT id, uuid, name FROM workflow_definitions
      WHERE organization_id=? AND module_key=? AND entity_type=? AND is_active=1
      LIMIT 1`,
    [orgId, moduleKey, entityType]
  );
  if (existing.length) return existing[0];

  try {
    const [inserted] = await executor.query(
      `INSERT INTO workflow_definitions
         (uuid, organization_id, module_key, entity_type, name, is_default, created_by_uuid)
       VALUES (UUID(), ?, ?, ?, ?, 1, ?)`,
      [
        orgId,
        moduleKey,
        entityType,
        `Default ${entityType.replace(/_/g, " ")} approval`,
        actorUuid ?? null,
      ]
    );
    const definitionId = inserted.insertId;

    await executor.query(
      `INSERT INTO workflow_steps (uuid, workflow_id, step_order, name, approver_type)
       VALUES (UUID(), ?, 1, 'Organization Admin', 'org_admin')`,
      [definitionId]
    );

    return { id: definitionId, name: "Default approval" };
  } catch (err) {
    // Another concurrent request created the same definition first.
    if (err?.errno === ER_DUP_ENTRY) {
      const [raced] = await executor.query(
        `SELECT id, uuid, name FROM workflow_definitions
          WHERE organization_id=? AND module_key=? AND entity_type=? AND is_active=1
          LIMIT 1`,
        [orgId, moduleKey, entityType]
      );
      if (raced.length) return raced[0];
    }
    throw err;
  }
}

async function recordHistory(executor, { requestUuid, step, approverUuid, approverName, decision, comments }) {
  await executor.query(
    `INSERT INTO approval_step_history
       (uuid, approval_request_uuid, step_id, step_order, step_name,
        approver_uuid, approver_name, decision, comments)
     VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      requestUuid,
      step?.id ?? null,
      step?.step_order ?? 0,
      step?.name ?? "Approval",
      approverUuid ?? null,
      approverName ?? null,
      decision,
      comments ?? null,
    ]
  );
}

function audit(actor, action, entityType, entityId, details = {}) {
  logAudit({
    actorType: actor?.actorType ?? "user",
    actorId: actor?.actorId ?? null,
    actorName: actor?.actorName ?? null,
    actorRole: actor?.actorRole ?? null,
    action,
    entityType,
    entityId,
    details,
  });
}

/**
 * Open an approval for an entity.
 *
 * Idempotency note: calling this twice for the same entity throws 409 rather
 * than silently opening a second chain. Callers that legitimately retry after a
 * rejection get a fresh chain because the rejected one no longer holds the
 * unique key.
 */
export async function startApproval(input) {
  const data = validate(startSchema, input);
  const { orgId, moduleKey, entityType, entityUuid, requestedByUuid, title, payload } = data;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Friendly pre-check. The unique index below is what actually guarantees
    // this; this exists only to return a readable message.
    const [inFlight] = await conn.query(
      `SELECT uuid FROM approval_requests
        WHERE organization_id=? AND entity_type=? AND entity_uuid=? AND status='pending'`,
      [orgId, entityType, entityUuid]
    );
    if (inFlight.length) {
      throw new ApiError(409, "This item is already awaiting approval");
    }

    const workflow = await resolveWorkflow(conn, {
      orgId,
      moduleKey,
      entityType,
      actorUuid: requestedByUuid,
    });
    const steps = await loadSteps(conn, workflow.id);
    if (!steps.length) {
      throw new ApiError(500, `Workflow "${workflow.name}" has no steps configured`);
    }

    const firstStep = steps[0];
    const approvers = await resolveApprovers(conn, { orgId, step: firstStep });
    if (!approvers.length) {
      throw new ApiError(
        409,
        `Workflow step "${firstStep.name}" has no approver. Assign an approver before submitting.`
      );
    }

    let inserted;
    try {
      [inserted] = await conn.query(
        `INSERT INTO approval_requests
           (uuid, organization_id, workflow_id, module_key, entity_type, entity_uuid,
            current_step_order, status, title, payload, requested_by_uuid)
         VALUES (UUID(), ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        [
          orgId,
          workflow.id,
          moduleKey,
          entityType,
          entityUuid,
          firstStep.step_order,
          title ?? null,
          payload ? JSON.stringify(payload) : null,
          requestedByUuid,
        ]
      );
    } catch (err) {
      // Lost the race against a concurrent submit of the same entity.
      if (err?.errno === ER_DUP_ENTRY) {
        throw new ApiError(409, "This item is already awaiting approval");
      }
      throw err;
    }

    const [created] = await conn.query(
      `SELECT uuid, current_step_order, requested_at FROM approval_requests WHERE id=?`,
      [inserted.insertId]
    );
    const requestUuid = created[0].uuid;

    await recordHistory(conn, {
      requestUuid,
      step: firstStep,
      decision: "pending",
    });

    await conn.commit();

    await createNotificationForUsers({
      userIds: approvers,
      type: "approval_pending",
      title: "Approval required",
      message: title || `A new ${entityType.replace(/_/g, " ")} is waiting for your approval`,
      referenceId: requestUuid,
    });

    audit(
      { actorType: "user", actorId: requestedByUuid, actorName: null, actorRole: null },
      "approval.start",
      entityType,
      entityUuid,
      { moduleKey, workflowId: workflow.id, step: firstStep.name }
    );

    return {
      approvalRequestUuid: requestUuid,
      status: "pending",
      currentStep: firstStep.name,
      currentStepOrder: firstStep.step_order,
      approverCount: approvers.length,
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Approve or reject the approval currently sitting on its active step.
 *
 * Approval advances one step at a time; the final step resolves the whole
 * request to 'approved'. Rejection is terminal at any step.
 */
export async function decideApproval(input) {
  const data = validate(decideSchema, input);
  const { orgId, requestUuid, actorUuid, decision, comments } = data;

  const conn = await pool.getConnection();
  let resolved = null;
  try {
    await conn.beginTransaction();

    // FOR UPDATE: two approvers clicking at once must serialise, or both could
    // read the same current_step_order and double-advance the chain.
    const [requests] = await conn.query(
      `SELECT id, uuid, entity_type, entity_uuid, module_key, current_step_order,
              status, requested_by_uuid, workflow_id
         FROM approval_requests
        WHERE uuid=? AND organization_id=?
        FOR UPDATE`,
      [requestUuid, orgId]
    );
    if (!requests.length) throw new ApiError(404, "Approval request not found");
    const request = requests[0];

    if (request.status !== "pending") {
      throw new ApiError(409, `This approval was already ${request.status}`);
    }

    const steps = await loadSteps(conn, request.workflow_id);
    const stepIndex = steps.findIndex((s) => s.step_order === request.current_step_order);
    const step = steps[stepIndex];
    if (!step) throw new ApiError(500, "Approval workflow is misconfigured: current step not found");

    const approvers = await resolveApprovers(conn, { orgId, step });
    if (!approvers.includes(actorUuid)) {
      throw new ApiError(403, "You are not an approver for this step");
    }

    const [actorRows] = await conn.query("SELECT full_name FROM users WHERE uuid=?", [actorUuid]);
    const actorName = actorRows[0]?.full_name ?? null;

    if (decision === "reject") {
      await conn.query(
        `UPDATE approval_requests
            SET status='rejected', resolved_at=NOW(), resolved_by_uuid=?, outcome_notes=?
          WHERE id=?`,
        [actorUuid, comments ?? null, request.id]
      );
      await recordHistory(conn, {
        requestUuid,
        step,
        approverUuid: actorUuid,
        approverName: actorName,
        decision: "rejected",
        comments,
      });
      resolved = { status: "rejected", finalStep: true };
    } else {
      const nextStep = steps[stepIndex + 1];
      if (!nextStep) {
        await conn.query(
          `UPDATE approval_requests
              SET status='approved', resolved_at=NOW(), resolved_by_uuid=?, outcome_notes=?
            WHERE id=?`,
          [actorUuid, comments ?? null, request.id]
        );
        await recordHistory(conn, {
          requestUuid,
          step,
          approverUuid: actorUuid,
          approverName: actorName,
          decision: "approved",
          comments,
        });
        resolved = { status: "approved", finalStep: true };
      } else {
        const nextApprovers = await resolveApprovers(conn, { orgId, step: nextStep });
        if (!nextApprovers.length) {
          throw new ApiError(
            409,
            `Next workflow step "${nextStep.name}" has no approver. Assign an approver first.`
          );
        }
        await conn.query("UPDATE approval_requests SET current_step_order=? WHERE id=?", [
          nextStep.step_order,
          request.id,
        ]);
        await recordHistory(conn, {
          requestUuid,
          step,
          approverUuid: actorUuid,
          approverName: actorName,
          decision: "approved",
          comments,
        });
        await recordHistory(conn, { requestUuid, step: nextStep, decision: "pending" });
        resolved = {
          status: "pending",
          finalStep: false,
          nextStep: nextStep.name,
          // Captured inside the transaction on purpose. Re-resolving the next
          // approvers after commit would query outside it and could race a
          // step definition that changed in between, notifying the wrong people.
          nextApprovers,
        };
      }
    }

    await conn.commit();

    // ---- Notifications, after commit so a failed notify cannot roll back ----
    if (resolved.finalStep) {
      await createNotificationForUsers({
        userIds: [request.requested_by_uuid],
        type: `approval_${resolved.status}`,
        title: `Approval ${resolved.status}`,
        message: `Your ${request.entity_type.replace(/_/g, " ")} was ${resolved.status}`,
        referenceId: requestUuid,
      });
    } else {
      await createNotificationForUsers({
        userIds: resolved.nextApprovers,
        type: "approval_pending",
        title: "Approval required",
        message: `A ${request.entity_type.replace(/_/g, " ")} is waiting for your approval`,
        referenceId: requestUuid,
      });
    }

    audit(
      { actorType: "user", actorId: actorUuid, actorName, actorRole: null },
      `approval.${decision}`,
      request.entity_type,
      request.entity_uuid,
      { step: step.name, finalStep: resolved.finalStep, status: resolved.status }
    );

    return { status: resolved.status, finalStep: resolved.finalStep, nextStep: resolved.nextStep ?? null };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Withdraw an approval. Allowed for the requester or an org admin — NOT for a
 * step approver, because an approver's recourse on something they dislike is to
 * reject it (which is recorded), not to erase it.
 */
export async function cancelApproval(input) {
  const data = validate(cancelSchema, input);
  const { orgId, requestUuid, actorUuid, reason } = data;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [requests] = await conn.query(
      `SELECT id, uuid, entity_type, entity_uuid, current_step_order, status,
              requested_by_uuid, workflow_id
         FROM approval_requests
        WHERE uuid=? AND organization_id=?
        FOR UPDATE`,
      [requestUuid, orgId]
    );
    if (!requests.length) throw new ApiError(404, "Approval request not found");
    const request = requests[0];

    if (request.status !== "pending") {
      throw new ApiError(409, `This approval was already ${request.status}`);
    }

    const [actorRows] = await conn.query(
      "SELECT org_role, full_name FROM users WHERE uuid=? AND organization=?",
      [actorUuid, orgId]
    );
    const actor = actorRows[0];
    if (!actor) throw new ApiError(404, "User not found in this organization");

    const isRequester = request.requested_by_uuid === actorUuid;
    const isOrgAdmin = actor.org_role === "org_admin";
    if (!isRequester && !isOrgAdmin) {
      throw new ApiError(403, "Only the requester or an organization admin can cancel this approval");
    }

    const steps = await loadSteps(conn, request.workflow_id);
    const step = steps.find((s) => s.step_order === request.current_step_order);

    await conn.query(
      `UPDATE approval_requests
          SET status='cancelled', resolved_at=NOW(), resolved_by_uuid=?, outcome_notes=?
        WHERE id=?`,
      [actorUuid, reason ?? null, request.id]
    );
    await recordHistory(conn, {
      requestUuid,
      step,
      approverUuid: actorUuid,
      approverName: actor.full_name,
      decision: "cancelled",
      comments: reason,
    });

    await conn.commit();

    audit(
      { actorType: "user", actorId: actorUuid, actorName: actor.full_name, actorRole: actor.org_role },
      "approval.cancel",
      request.entity_type,
      request.entity_uuid,
      { byRequester: isRequester }
    );

    return { status: "cancelled" };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/** Current state + full history for one entity. Returns null when never submitted. */
export async function getApprovalStatus({ orgId, entityType, entityUuid }) {
  const [requests] = await pool.query(
    `SELECT ar.*, (SELECT COUNT(*) FROM approval_step_history h
                    WHERE h.approval_request_uuid = ar.uuid) AS history_count
       FROM approval_requests ar
      WHERE ar.organization_id=? AND ar.entity_type=? AND ar.entity_uuid=?
      ORDER BY ar.requested_at DESC
      LIMIT 1`,
    [orgId, entityType, entityUuid]
  );
  if (!requests.length) return null;

  const [history] = await pool.query(
    `SELECT uuid, step_order, step_name, approver_uuid, approver_name,
            decision, comments, acted_at
       FROM approval_step_history
      WHERE approval_request_uuid=?
      ORDER BY acted_at ASC, step_order ASC`,
    [requests[0].uuid]
  );

  const currentStepOrder = requests[0].current_step_order;
  let currentStepName = null;
  if (currentStepOrder != null) {
    const [stepRows] = await pool.query(
      `SELECT name FROM workflow_steps WHERE workflow_id=? AND step_order=?`,
      [requests[0].workflow_id, currentStepOrder]
    );
    currentStepName = stepRows[0]?.name ?? null;
  }

  return { ...requests[0], current_step_name: currentStepName, history };
}

/**
 * The "my approvals" queue: every pending request in the org whose ACTIVE step
 * this user can act on. Org admins see org_admin steps, sub-admins see
 * sub_admin steps, and a specifically-named user sees their own step.
 *
 * Scoped by organization_id unconditionally — a user from another org passing a
 * different org id here gets that org's queue, because the caller is trusted to
 * supply req.scopeOrgId. Route handlers must never pass a body-supplied id.
 */
export async function getPendingApprovalsFor({ orgId, userUuid }) {
  const [userRows] = await pool.query(
    "SELECT uuid, org_role FROM users WHERE uuid=? AND organization=? AND status='active'",
    [userUuid, orgId]
  );
  if (!userRows.length) throw new ApiError(404, "User not found in this organization");
  const user = userRows[0];

  const [steps] = await pool.query(
    `SELECT ws.id, ws.uuid, ws.step_order, ws.name, ws.approver_type, ws.approver_uuid
       FROM workflow_steps ws
       JOIN workflow_definitions wd ON wd.id = ws.workflow_id
      WHERE wd.organization_id=? AND wd.is_active=1`,
    [orgId]
  );

  const eligibleStepIds = new Set();
  for (const step of steps) {
    if (step.approver_type === "org_admin" && user.org_role === "org_admin") {
      eligibleStepIds.add(step.id);
    } else if (step.approver_type === "sub_admin" && user.org_role === "sub_admin") {
      eligibleStepIds.add(step.id);
    } else if (step.approver_type === "specific_user" && step.approver_uuid === userUuid) {
      eligibleStepIds.add(step.id);
    }
  }
  if (!eligibleStepIds.size) return [];

  const placeholders = [...eligibleStepIds].map(() => "?").join(",");
  const [rows] = await pool.query(
    `SELECT ar.uuid, ar.title, ar.entity_type, ar.entity_uuid, ar.module_key,
            ar.current_step_order, ar.requested_at,
            ws.name AS step_name, ws.id AS step_id,
            u.full_name AS requested_by_name
       FROM approval_requests ar
       JOIN workflow_steps ws
         ON ws.workflow_id = ar.workflow_id AND ws.step_order = ar.current_step_order
       LEFT JOIN users u ON u.uuid = ar.requested_by_uuid
      WHERE ar.organization_id=? AND ar.status='pending' AND ws.id IN (${placeholders})
      ORDER BY ar.requested_at ASC`,
    [orgId, ...eligibleStepIds]
  );
  return rows;
}

/** Workflow definitions configured for an organization, with their steps. */
export async function listWorkflows({ orgId }) {
  const [definitions] = await pool.query(
    `SELECT uuid, module_key, entity_type, name, description, is_active, is_default, created_at
       FROM workflow_definitions
      WHERE organization_id=?
      ORDER BY module_key, entity_type`,
    [orgId]
  );
  if (!definitions.length) return [];

  const [steps] = await pool.query(
    `SELECT ws.workflow_id, ws.uuid, ws.step_order, ws.name, ws.approver_type,
            ws.approver_uuid, ws.required_approvals, u.full_name AS approver_name
       FROM workflow_steps ws
       JOIN workflow_definitions wd ON wd.id = ws.workflow_id
       LEFT JOIN users u ON u.uuid = ws.approver_uuid
      WHERE wd.organization_id=?
      ORDER BY ws.step_order ASC`,
    [orgId]
  );

  return definitions.map((definition) => ({
    ...definition,
    steps: steps.filter((s) => s.workflow_id === definition.id),
  }));
}