import { describe, it, expect, vi, beforeEach } from "vitest";

// Multi-step approval engine.
//
// The security-relevant parts are asserted first and loudest:
//   1. TENANT ISOLATION  — a request uuid belonging to another organization must
//      404, never leak. Every read in the service is scoped by organization_id
//      and these tests exist to keep it that way.
//   2. AUTHORISATION     — a user who is not the current step's approver gets
//      403, even when they are an admin of the same org.
//   3. THE STATE MACHINE — approval advances exactly one step, the final step
//      resolves the chain, and rejection is terminal at every step.
//
// The service is exercised through a mocked transaction connection whose
// query() is routed by SQL substring. Longest pattern wins, so a broad pattern
// like "FROM approval_requests" cannot shadow a specific one like
// "SELECT uuid FROM approval_requests" — an ambiguity that silently returned the
// wrong rows when this file was first written.

vi.mock("../src/config/db.js", () => ({ pool: { query: vi.fn(), getConnection: vi.fn() } }));
vi.mock("../src/utils/auditLog.js", () => ({ logAudit: vi.fn() }));
vi.mock("../src/controllers/notification.controller.js", () => ({
  createNotificationForOrgUsers: vi.fn().mockResolvedValue(undefined),
  createNotificationForUsers: vi.fn().mockResolvedValue(undefined),
}));

import { pool } from "../src/config/db.js";
import { logAudit } from "../src/utils/auditLog.js";
import { createNotificationForUsers } from "../src/controllers/notification.controller.js";
import {
  startApproval,
  decideApproval,
  cancelApproval,
  getApprovalStatus,
  getPendingApprovalsFor,
  listWorkflows,
} from "../src/services/approvalWorkflow.service.js";

const ORG = 2;
const OTHER_ORG = 99;
const REQUESTER = "11111111-1111-4111-8111-111111111111";
const ORG_ADMIN = "22222222-2222-4222-8222-222222222222";
const SUB_ADMIN = "33333333-3333-4333-8333-333333333333";
const ENTITY = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const REQ_UUID = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const WF_ID = 7;

const startInput = () => ({
  orgId: ORG,
  moduleKey: "expense_management",
  entityType: "expense_claim",
  entityUuid: ENTITY,
  requestedByUuid: REQUESTER,
  title: "Taxi fare",
});

const decideInput = () => ({
  orgId: ORG,
  requestUuid: REQ_UUID,
  actorUuid: ORG_ADMIN,
  decision: "approve",
});

/** `count` sequential steps, all approvable by an org_admin. */
const stepRows = (count) =>
  Array.from({ length: count }, (_, i) => ({
    id: WF_ID * 10 + i,
    uuid: `step-${i + 1}`,
    step_order: i + 1,
    name: `Step ${i + 1}`,
    approver_type: "org_admin",
    approver_uuid: null,
    required_approvals: 1,
  }));

const pendingRequest = (overrides = {}) => ({
  id: 1,
  uuid: REQ_UUID,
  entity_type: "expense_claim",
  entity_uuid: ENTITY,
  module_key: "expense_management",
  current_step_order: 1,
  status: "pending",
  requested_by_uuid: REQUESTER,
  workflow_id: WF_ID,
  ...overrides,
});

/**
 * Build a transaction connection whose query() resolves by longest-pattern-wins.
 * @param {Array<[string, any]>} routes  [sqlSubstring, rows | () => rows]
 */
function fakeConn(routes) {
  const conn = {
    query: vi.fn(async (sql) => {
      const text = String(sql);
      let best;
      let bestLen = -1;
      for (const [pattern, value] of routes) {
        if (text.includes(pattern) && pattern.length > bestLen) {
          best = value;
          bestLen = pattern.length;
        }
      }
      if (best === undefined) return [[], []];
      return [typeof best === "function" ? best() : best, []];
    }),
    beginTransaction: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
    rollback: vi.fn(async () => {}),
    release: vi.fn(),
  };
  pool.getConnection.mockResolvedValue(conn);
  return conn;
}

const sqlOf = (conn) => conn.query.mock.calls.map(([sql]) => String(sql));

beforeEach(() => {
  vi.clearAllMocks();
  pool.query.mockReset();
  pool.getConnection.mockReset();
  logAudit.mockReset();
  createNotificationForUsers.mockReset();
  createNotificationForUsers.mockResolvedValue(undefined);
});

describe("startApproval — one in-flight approval per entity", () => {
  const happyRoutes = (definitionRows, stepList) => [
    ["SELECT uuid FROM approval_requests", []],
    ["SELECT id, uuid, name FROM workflow_definitions", definitionRows],
    ["SELECT id, uuid, step_order", stepList],
    ["SELECT uuid FROM users", [{ uuid: ORG_ADMIN }, { uuid: SUB_ADMIN }]],
    ["SELECT uuid, current_step_order", [{ uuid: REQ_UUID, current_step_order: 1 }]],
  ];

  it("opens a chain at the first step and notifies its approvers", async () => {
    fakeConn(happyRoutes([{ id: WF_ID, uuid: "wf", name: "Expense" }], stepRows(2)));

    const result = await startApproval(startInput());

    expect(result).toMatchObject({
      status: "pending",
      currentStep: "Step 1",
      currentStepOrder: 1,
      approverCount: 2,
      approvalRequestUuid: REQ_UUID,
    });
    expect(createNotificationForUsers).toHaveBeenCalledWith(
      expect.objectContaining({ userIds: [ORG_ADMIN, SUB_ADMIN], referenceId: REQ_UUID })
    );
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "approval.start" }));
  });

  it("persists a synthesised default one-step workflow when the org has none", async () => {
    const conn = fakeConn([
      ...happyRoutes([], [{ id: 1, uuid: "s1", step_order: 1, name: "Organization Admin", approver_type: "org_admin", approver_uuid: null }]),
      ["INSERT INTO workflow_definitions", [{ insertId: 42 }]],
      ["INSERT INTO workflow_steps", [{ affectedRows: 1 }]],
    ]);

    const result = await startApproval(startInput());

    const sql = sqlOf(conn);
    // The fallback is STORED, not synthesised in memory, because
    // approval_requests.workflow_id is NOT NULL.
    expect(sql.some((s) => s.includes("INSERT INTO workflow_definitions"))).toBe(true);
    expect(sql.some((s) => s.includes("INSERT INTO workflow_steps"))).toBe(true);
    expect(result.currentStep).toBe("Organization Admin");
  });

  it("409s when the entity already has a pending approval", async () => {
    fakeConn([["SELECT uuid FROM approval_requests", [{ uuid: "existing" }]]]);
    await expect(startApproval(startInput())).rejects.toMatchObject({
      statusCode: 409,
      message: "This item is already awaiting approval",
    });
  });

  it("converts the duplicate-key race into the same 409", async () => {
    // A second concurrent submit slips past the pre-check and loses on the
    // unique index — the database, not the pre-check, is the real guarantee.
    const conn = fakeConn(happyRoutes([{ id: WF_ID, uuid: "wf", name: "Expense" }], stepRows(1)));
    const base = conn.query.getMockImplementation();
    conn.query.mockImplementation(async (sql, params) => {
      if (String(sql).includes("INSERT INTO approval_requests")) {
        const err = new Error("Duplicate entry");
        err.errno = 1062;
        throw err;
      }
      return base(sql, params);
    });

    await expect(startApproval(startInput())).rejects.toMatchObject({ statusCode: 409 });
  });

  it("refuses to open a chain whose first step has no approver", async () => {
    fakeConn([
      ["SELECT uuid FROM approval_requests", []],
      ["SELECT id, uuid, name FROM workflow_definitions", [{ id: WF_ID, name: "E" }]],
      ["SELECT id, uuid, step_order", stepRows(1)],
      ["SELECT uuid FROM users", []],
    ]);
    await expect(startApproval(startInput())).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("has no approver"),
    });
  });

  it("refuses a 'reporting manager' step instead of silently stalling the chain", async () => {
    fakeConn([
      ["SELECT uuid FROM approval_requests", []],
      ["SELECT id, uuid, name FROM workflow_definitions", [{ id: WF_ID, name: "E" }]],
      [
        "SELECT id, uuid, step_order",
        [{ id: 1, step_order: 1, name: "Line Manager", approver_type: "reporting_manager" }],
      ],
    ]);
    await expect(startApproval(startInput())).rejects.toMatchObject({ statusCode: 501 });
  });

  it("validates input before opening a connection", async () => {
    await expect(startApproval({ ...startInput(), entityType: "" })).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(pool.getConnection).not.toHaveBeenCalled();
  });

  it("rolls back and releases when the insert fails", async () => {
    const conn = fakeConn(happyRoutes([{ id: WF_ID, name: "E" }], stepRows(1)));
    const base = conn.query.getMockImplementation();
    conn.query.mockImplementation(async (sql, params) => {
      if (String(sql).includes("INSERT INTO approval_requests")) throw new Error("boom");
      return base(sql, params);
    });
    await expect(startApproval(startInput())).rejects.toThrow("boom");
    expect(conn.rollback).toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalled();
  });
});

describe("decideApproval — authorisation and tenant isolation", () => {
  it("404s for an approval belonging to another organization", async () => {
    const conn = fakeConn([["FROM approval_requests", []]]);
    await expect(decideApproval({ ...decideInput(), orgId: OTHER_ORG })).rejects.toMatchObject({
      statusCode: 404,
    });
    // The org filter is part of the WHERE, which is what makes it a 404.
    const [sql, params] = conn.query.mock.calls[0];
    expect(String(sql)).toContain("organization_id=?");
    expect(params).toContain(OTHER_ORG);
  });

  it("403s an actor who is not an approver of the current step", async () => {
    fakeConn([
      ["FROM approval_requests", [pendingRequest()]],
      ["SELECT id, uuid, step_order", stepRows(2)],
      ["SELECT uuid FROM users", [{ uuid: ORG_ADMIN }]],
    ]);
    await expect(decideApproval({ ...decideInput(), actorUuid: "intruder" })).rejects.toMatchObject({
      statusCode: 403,
      message: "You are not an approver for this step",
    });
  });

  it("409s on an approval that was already resolved", async () => {
    fakeConn([["FROM approval_requests", [pendingRequest({ status: "rejected" })]]]);
    await expect(decideApproval(decideInput())).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("already rejected"),
    });
  });

  it("locks the request row before reading it, so two clicks cannot double-advance", async () => {
    const conn = fakeConn([
      ["FROM approval_requests", [pendingRequest()]],
      ["SELECT id, uuid, step_order", stepRows(2)],
      ["SELECT uuid FROM users", [{ uuid: ORG_ADMIN, full_name: "Admin" }]],
    ]);
    await decideApproval(decideInput());
    expect(sqlOf(conn).some((s) => s.includes("FOR UPDATE"))).toBe(true);
  });

  it("rolls back on any failure so no half-advanced chain is persisted", async () => {
    const conn = fakeConn([
      ["FROM approval_requests", [pendingRequest()]],
      ["SELECT id, uuid, step_order", stepRows(2)],
      ["SELECT uuid FROM users", [{ uuid: ORG_ADMIN, full_name: "Admin" }]],
    ]);
    conn.commit.mockRejectedValue(new Error("db down"));
    await expect(decideApproval(decideInput())).rejects.toThrow("db down");
    expect(conn.rollback).toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalled();
  });
});

describe("decideApproval — the state machine", () => {
  const decideRoutes = (request, stepList) => [
    ["FROM approval_requests", [request]],
    ["SELECT id, uuid, step_order", stepList],
    // Two distinct user lookups: the step's approver set, and the acting
    // approver's display name. Both patterns are needed or resolveApprovers
    // silently sees no approvers and every decision 403s.
    ["SELECT uuid FROM users", [{ uuid: ORG_ADMIN }]],
    ["SELECT uuid, full_name FROM users", [{ uuid: ORG_ADMIN, full_name: "Admin" }]],
  ];

  it("advances to the next step instead of resolving the chain", async () => {
    const conn = fakeConn(decideRoutes(pendingRequest(), stepRows(2)));
    const result = await decideApproval(decideInput());

    expect(result).toMatchObject({ status: "pending", finalStep: false, nextStep: "Step 2" });
    const sql = sqlOf(conn);
    expect(sql.some((s) => s.includes("SET current_step_order=?"))).toBe(true);
    expect(sql.some((s) => s.includes("status='approved'"))).toBe(false);
    // The acting approver is recorded, and the next step is opened: two rows.
    expect(sql.filter((s) => s.includes("INSERT INTO approval_step_history")).length).toBe(2);
    expect(conn.commit).toHaveBeenCalled();
  });

  it("resolves the whole chain when the LAST step approves", async () => {
    fakeConn(decideRoutes(pendingRequest({ current_step_order: 2 }), stepRows(2)));
    const result = await decideApproval(decideInput());

    expect(result).toMatchObject({ status: "approved", finalStep: true });
    // The requester is told the outcome.
    expect(createNotificationForUsers).toHaveBeenCalledWith(
      expect.objectContaining({ userIds: [REQUESTER], referenceId: REQ_UUID })
    );
  });

  it("notifies the NEXT step's approvers, not the current step's, when advancing", async () => {
    // Step 1 is approvable by any org_admin; step 2 by one named user. The
    // notification must go to the named user, proving approvers are resolved
    // per-step rather than once for the whole chain.
    const conn = fakeConn([
      ["FROM approval_requests", [pendingRequest()]],
      [
        "SELECT id, uuid, step_order",
        [
          { id: 1, uuid: "s1", step_order: 1, name: "Mgr", approver_type: "org_admin", approver_uuid: null },
          {
            id: 2,
            uuid: "s2",
            step_order: 2,
            name: "Finance",
            approver_type: "specific_user",
            approver_uuid: "named-approver",
          },
        ],
      ],
      ["SELECT uuid, full_name FROM users", [{ uuid: ORG_ADMIN, full_name: "Admin" }]],
      // Only step 1 queries users; a 'specific_user' step resolves straight
      // from step.approver_uuid without a query at all.
      ["SELECT uuid FROM users", [{ uuid: ORG_ADMIN }]],
    ]);

    await decideApproval(decideInput());

    const notified = createNotificationForUsers.mock.calls.map(([a]) => a);
    expect(notified.at(-1)).toMatchObject({ userIds: ["named-approver"] });
  });

  it("makes rejection terminal at any step", async () => {
    const conn = fakeConn(decideRoutes(pendingRequest(), stepRows(2)));
    const result = await decideApproval({
      ...decideInput(),
      decision: "reject",
      comments: "Missing receipt",
    });

    expect(result).toMatchObject({ status: "rejected", finalStep: true });
    const sql = sqlOf(conn);
    expect(sql.some((s) => s.includes("status='rejected'"))).toBe(true);
    expect(sql.some((s) => s.includes("current_step_order=?"))).toBe(false);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "approval.reject" }));
  });

  it("blocks advancing into a step that has no approver", async () => {
    const conn = fakeConn([
      ["FROM approval_requests", [pendingRequest()]],
      ["SELECT id, uuid, step_order", stepRows(2)],
      ["SELECT uuid FROM users", [{ uuid: ORG_ADMIN }]],
    ]);
    // Make the SECOND step's approver lookup come back empty.
    const base = conn.query.getMockImplementation();
    let approverLookups = 0;
    conn.query.mockImplementation(async (sql, params) => {
      if (String(sql).includes("SELECT uuid FROM users")) {
        approverLookups += 1;
        // First lookup (current step) succeeds, second (next step) is empty.
        if (approverLookups === 1) return [[{ uuid: ORG_ADMIN }], []];
        return [[], []];
      }
      return base(sql, params);
    });

    await expect(decideApproval(decideInput())).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("has no approver"),
    });
  });
});

describe("cancelApproval", () => {
  const cancelRoutes = (actorRow, request = pendingRequest()) => [
    ["FROM approval_requests", [request]],
    ["SELECT id, uuid, step_order", stepRows(1)],
    // The route VALUE is the rows array itself (fakeConn returns it verbatim),
    // so this must be `actorRow`, never `[actorRow]` — wrapping twice makes
    // actorRows[0] an array, leaving actor.org_role undefined and turning every
    // authorisation check into a spurious 403.
    ["SELECT org_role, full_name FROM users", actorRow],
  ];

  it("lets the requester withdraw their own approval", async () => {
    const conn = fakeConn(cancelRoutes([{ org_role: "employee", full_name: "Req" }]));
    const result = await cancelApproval({
      orgId: ORG,
      requestUuid: REQ_UUID,
      actorUuid: REQUESTER,
      reason: "Wrong amount",
    });
    expect(result.status).toBe("cancelled");
    expect(sqlOf(conn).some((s) => s.includes("status='cancelled'"))).toBe(true);
  });

  it("lets an org admin cancel someone else's approval", async () => {
    fakeConn(cancelRoutes([{ org_role: "org_admin", full_name: "Boss" }]));
    await expect(
      cancelApproval({ orgId: ORG, requestUuid: REQ_UUID, actorUuid: ORG_ADMIN })
    ).resolves.toMatchObject({ status: "cancelled" });
  });

  it("403s a random employee who is neither requester nor admin", async () => {
    fakeConn(cancelRoutes([{ org_role: "employee", full_name: "Nobody" }]));
    await expect(
      cancelApproval({ orgId: ORG, requestUuid: REQ_UUID, actorUuid: "random-employee" })
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("403s a step approver — they must reject, not erase", async () => {
    // An org admin can cancel generally, but the point of this case is that an
    // approver's recourse on something they dislike is 'reject', which is
    // recorded in history — never 'cancel', which removes it from the queue.
    fakeConn(cancelRoutes([{ org_role: "employee", full_name: "Approver" }]));
    await expect(
      cancelApproval({ orgId: ORG, requestUuid: REQ_UUID, actorUuid: SUB_ADMIN })
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("404s for a user outside the organization", async () => {
    fakeConn(cancelRoutes([]));
    await expect(
      cancelApproval({ orgId: ORG, requestUuid: REQ_UUID, actorUuid: "outsider" })
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("getApprovalStatus", () => {
  it("returns null when an entity was never submitted", async () => {
    pool.query.mockResolvedValueOnce([[]]);
    await expect(
      getApprovalStatus({ orgId: ORG, entityType: "expense_claim", entityUuid: ENTITY })
    ).resolves.toBeNull();
  });

  it("always scopes the lookup to the organization", async () => {
    pool.query.mockResolvedValueOnce([[]]);
    await getApprovalStatus({ orgId: OTHER_ORG, entityType: "expense_claim", entityUuid: ENTITY });
    expect(pool.query.mock.calls[0][1]).toContain(OTHER_ORG);
  });

  it("returns the latest request with its full history", async () => {
    pool.query.mockImplementation(async (sql) => {
      const t = String(sql);
      // Order matters: the request query contains "FROM approval_step_history h"
      // in a subquery, so it must be matched BEFORE the history query or the
      // request lookup returns history rows.
      if (t.includes("FROM approval_requests ar"))
        return [[{ uuid: REQ_UUID, current_step_order: 2, status: "pending", history_count: 3 }], []];
      if (t.includes("FROM approval_step_history"))
        return [[{ uuid: "h1", decision: "approved", step_name: "Mgr" }], []];
      if (t.includes("FROM workflow_steps")) return [[{ name: "Finance" }], []];
      return [[], []];
    });
    const result = await getApprovalStatus({
      orgId: ORG,
      entityType: "expense_claim",
      entityUuid: ENTITY,
    });
    expect(result.current_step_name).toBe("Finance");
    expect(result.history.length).toBe(1);
  });
});

describe("getPendingApprovalsFor", () => {
  it("only offers a user steps their own role can act on", async () => {
    pool.query.mockImplementation(async (sql) => {
      const t = String(sql);
      if (t.includes("SELECT uuid, org_role FROM users"))
        return [[{ uuid: SUB_ADMIN, org_role: "sub_admin" }], []];
      if (t.includes("FROM workflow_steps"))
        return [
          [
            { id: 1, step_order: 1, name: "Mgr", approver_type: "org_admin", approver_uuid: null },
            { id: 2, step_order: 2, name: "Fin", approver_type: "sub_admin", approver_uuid: null },
          ],
          [],
        ];
      return [[], []];
    });

    await getPendingApprovalsFor({ orgId: ORG, userUuid: SUB_ADMIN });

    // Only step id 2 is eligible — the org_admin step must never leak in.
    const finalCall = pool.query.mock.calls.at(-1);
    expect(finalCall[1].slice(1)).toEqual([2]);
  });

  it("includes a step explicitly assigned to the user", async () => {
    pool.query.mockImplementation(async (sql) => {
      const t = String(sql);
      if (t.includes("SELECT uuid, org_role FROM users"))
        return [[{ uuid: SUB_ADMIN, org_role: "sub_admin" }], []];
      if (t.includes("FROM workflow_steps"))
        return [
          [{ id: 9, step_order: 1, name: "Named", approver_type: "specific_user", approver_uuid: SUB_ADMIN }],
          [],
        ];
      return [[], []];
    });
    await getPendingApprovalsFor({ orgId: ORG, userUuid: SUB_ADMIN });
    expect(pool.query.mock.calls.at(-1)[1].slice(1)).toEqual([9]);
  });

  it("returns empty without querying when the user has no eligible steps", async () => {
    pool.query.mockImplementation(async (sql) => {
      const t = String(sql);
      if (t.includes("SELECT uuid, org_role FROM users"))
        return [[{ uuid: "employee", org_role: "employee" }], []];
      return [[], []];
    });
    await expect(getPendingApprovalsFor({ orgId: ORG, userUuid: "employee" })).resolves.toEqual([]);
  });

  it("404s for a user outside the organization", async () => {
    pool.query.mockResolvedValueOnce([[]]);
    await expect(getPendingApprovalsFor({ orgId: ORG, userUuid: "outsider" })).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe("listWorkflows", () => {
  it("nests each definition's steps", async () => {
    pool.query.mockImplementation(async (sql) => {
      const t = String(sql);
      if (t.includes("FROM workflow_steps")) return [[{ workflow_id: 5, step_order: 1, name: "Mgr" }], []];
      if (t.includes("FROM workflow_definitions"))
        return [[{ id: 5, uuid: "wf1", module_key: "expense_management" }], []];
      return [[], []];
    });
    const list = await listWorkflows({ orgId: ORG });
    expect(list).toHaveLength(1);
    expect(list[0].steps).toHaveLength(1);
    expect(list[0].steps[0].name).toBe("Mgr");
  });

  it("returns an empty list for an org with no workflows", async () => {
    pool.query.mockResolvedValueOnce([[]]);
    await expect(listWorkflows({ orgId: ORG })).resolves.toEqual([]);
  });
});