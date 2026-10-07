import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * Every offboarding ENDPOINT, dispatched as a real request through the real router.
 *
 * WHY ROUTE-LEVEL AND NOT "CALL THE CONTROLLER".
 *
 * The review handler shipped with `decisionNotes,` passed to a service that
 * destructures `decisionNotes` from the request body as `decision_notes`. That is
 * a ReferenceError: `node --check` passes it, the module imports, the service works
 * perfectly when called directly with the right argument, and the endpoint answers
 * 500 with a masked "Internal Server Error". Only executing the handler finds it.
 *
 * A cross-check that compared property names against the service signature also
 * failed to find it, because `decisionNotes` IS a valid property of that service -
 * the defect was lexical scope, not the shape of the argument object. No amount of
 * reading source text substitutes for running the code path.
 *
 * authUser, the subscription lock and the module gate are stubbed so the request
 * reaches the handler rather than the auth stack; letting a test fail on a missing
 * token or an inactive plan would hide the thing it is here to prove.
 */
vi.mock("../src/middleware/authUser.js", () => ({
  default: (req, _res, next) => {
    req.user = {
      uuid: "11111111-1111-4111-8111-111111111111",
      id: 1,
      full_name: "Route Admin",
      email: "admin@local.test",
      org_role: "org_admin",
      organization: 5,
    };
    req.scopeOrgId = 5;
    next();
  },
}));
vi.mock("../src/middleware/requireActiveSubscription.js", () => ({
  default: (_req, _res, next) => next(),
}));
vi.mock("../src/middleware/requireModuleFeature.js", () => ({
  default: () => (_req, _res, next) => next(),
}));
// The staff routes sit behind requireRole, which re-verifies the JWT itself
// rather than trusting authUser. Mocked too, for the same reason: the point is the
// handler, not the token.
vi.mock("../src/middleware/requireRole.js", () => ({
  default: () => (req, _res, next) => {
    req.scopeOrgId = 5;
    next();
  },
}));

const EXIT_UUID = "22222222-2222-4222-8222-222222222222";
const CHECKLIST_UUID = "33333333-3333-4333-8333-333333333333";

const exitRow = {
  uuid: EXIT_UUID,
  employee_uuid: "44444444-4444-4444-8444-444444444444",
  employee_name: "Leaver",
  designation: "Engineer",
  request_type: "resignation",
  notice_period_days: 30,
  last_working_day: new Date(2026, 9, 31),
  reason: "Better opportunity",
  status: "pending",
  decided_by_name: null,
  created_at: new Date(2026, 8, 20),
  decided_at: null,
  completed_at: null,
};

const checklistRow = {
  uuid: CHECKLIST_UUID,
  department: "IT",
  task_name: "Revoke system access",
  status: "pending",
  cleared_by_uuid: null,
  cleared_at: null,
  notes: null,
};

vi.mock("../src/config/db.js", () => {
  // mysql2 resolves to [rows, fields], NOT to rows. Returning `[row]` makes
  // `const [rows] = await query()` bind rows to the row object itself, whose
  // `.length` is undefined - so every "does this row exist" check silently reads
  // as "not found". That is not hypothetical: it made the ESS handler report "no
  // employee record" for an employee that exists, and a test asserting the
  // no-employee path passed for the wrong reason.
  const row = (r) => [[r], []];
  const empty = [[], []];
  const total = (n) => [[{ total: n }], []];

  // One query handler, shared by the pool and by a dedicated connection.
  //
  // createExitRequest opens its own transaction when it is handed the pool rather
  // than a connection, so the transaction path issues its queries through
  // getConnection(). A stub whose conn.query answered nothing makes submission
  // fail with "Employee not found" - a mock artefact that looks exactly like a
  // tenancy bug in the code under test.
  const handleQuery = async (sql, params) => {
    const s = String(sql);
    // The employee lookup for the ESS routes. No linked record unless a test
        // says otherwise, so the "no employee record" path is reachable too.
        if (s.includes("FROM employees") && s.includes("linked_user_uuid")) {
          if (globalThis.__noEmployeeRecord) return empty;
          return row({
            uuid: "44444444-4444-4444-8444-444444444444",
            full_name: "Leaver",
            status: "current_employee",
            created_at: new Date(2026, 8, 20),
            last_working_day: new Date(2026, 9, 31),
            request_type: "resignation",
            notice_period_days: 30,
            reason: "Better opportunity",
            decision_notes: null,
          });
        }
        // Ordered most-specific first: the list projection, the detail projection
        // and the COUNT all mention exit_requests, and matching them in the wrong
        // order makes a handler fail on a mock artefact instead of on its own code.
        if (s.includes("FROM exit_requests") && s.includes("SELECT er.uuid, er.employee_uuid")) {
          return row({ ...exitRow, clearance_pending: 1, clearance_total: 9, assets_outstanding: 0 });
        }
        // The roster lookup an exit is filed against. Distinct from the ESS lookup
        // above: no linked_user_uuid in the SQL, and it is what proves the employee
        // belongs to THIS organization before anything is written.
        if (s.includes("dg.name AS designation")) {
          if (globalThis.__noRosterEmployee) return empty;
          return row({
            uuid: "44444444-4444-4444-8444-444444444444",
            full_name: "Leaver",
            status: globalThis.__exStatus ?? "current_employee",
            joining_date: new Date(2024, 0, 1),
            designation: "Engineer",
          });
        }
        if (s.includes("FROM exit_requests") && s.includes("COUNT(*)")) return total(1);
        if (s.includes("SELECT uuid, status, notice_period_days")) return row({ ...exitRow, status: globalThis.__exitStatus ?? exitRow.status });
        // Two different queries start SELECT uuid, status FROM exit_requests.
        // The open-exit check filters by employee_uuid and asks whether the
        // employee already has one; the settlement lookup filters by
        // exit_request_uuid. Answering the former with a row makes every
        // submission 409 for "already has an exit", which is correct behaviour
        // meeting a fixture that claims one.
        if (s.includes("SELECT uuid, status FROM exit_requests") && s.includes("employee_uuid")) {
          return empty;
        }
        if (s.includes("SELECT uuid, status FROM exit_requests")) {
          return row({ uuid: exitRow.uuid, status: globalThis.__exitStatus ?? exitRow.status });
        }
        if (s.includes("SELECT er.uuid, er.status, er.request_type")) {
          return row({
            uuid: exitRow.uuid,
            status: exitRow.status,
            request_type: exitRow.request_type,
            notice_period_days: exitRow.notice_period_days,
            last_working_day: exitRow.last_working_day,
            reason: exitRow.reason,
            decision_notes: null,
            created_at: exitRow.created_at,
            decided_at: null,
            completed_at: null,
          });
        }
        if (s.includes("SELECT er.*")) return row({ ...exitRow, status: globalThis.__exitStatus ?? exitRow.status });
        // The checklist read for one exit, and the single-item lookup that joins a
        // task to its exit. Both carry the exit's status, and the clearance guard
        // reads it - so a stub without it makes every clear look like it was
        // attempted against a pending request.
        if (s.includes("SELECT uuid, department, task_name")) {
          return row({ ...checklistRow, exit_status: globalThis.__exitStatus ?? exitRow.status });
        }
        if (s.includes("FROM offboarding_checklists") && s.includes("COUNT(*)")) {
          return total(1);
        }
        if (s.includes("er.status AS exit_status")) {
          return row({ uuid: checklistRow.uuid, status: checklistRow.status, exit_status: globalThis.__exitStatus ?? exitRow.status });
        }
        if (s.includes("FROM offboarding_checklists")) return row(checklistRow);
        if (s.includes("FROM asset_assignments")) return empty;
        if (s.includes("FROM final_settlements")) return empty;
        if (s.includes("FROM employee_salary_history")) return row({ basic_salary: "31000.00" });
        if (s.includes("FROM leave_types") || s.includes("FROM employee_leave_allocations")) return empty;
        if (s.includes("FROM work_week_config")) {
          return row({ mon: 1, tue: 1, wed: 1, thu: 1, fri: 1, sat: 0, sun: 0 });
        }
        if (s.includes("FROM holidays")) return empty;
        if (s.startsWith("INSERT") || s.startsWith("UPDATE")) return [{ insertId: 1, affectedRows: 1 }];
    return empty;
  };

  const conn = {
    query: vi.fn(handleQuery),
    beginTransaction: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
    rollback: vi.fn(async () => {}),
    release: vi.fn(),
  };

  return {
    pool: {
      query: vi.fn(handleQuery),
      getConnection: vi.fn(async () => conn),
    },
  };
});

let app;

beforeAll(async () => {
  const router = (await import("../src/routes/index.js")).default;
  const { default: errorHandler } = await import("../src/middleware/errorHandler.js");
  app = express();
  app.use(express.json());
  app.use("/api/v1", router);
  // The real error handler, so a handler that throws produces its real status and
  // message. Without it express answers with an empty body and a 500, which makes
  // a genuine defect indistinguishable from a mock that did not match.
  app.use(errorHandler);
  app.use((_req, res) => res.status(404).json({ success: false, message: "Route not found" }));
});

beforeEach(() => {
  globalThis.__noEmployeeRecord = false;
  globalThis.__noRosterEmployee = false;
  globalThis.__exitStatus = "pending";
  globalThis.__exStatus = undefined;
});

describe("staff offboarding endpoints are wired and execute", () => {
  const routes = [
    ["get", "/api/v1/org/offboarding/exit-requests"],
    ["get", "/api/v1/org/offboarding/clearances"],
    ["get", `/api/v1/org/offboarding/exit-requests/${EXIT_UUID}`],
    ["get", `/api/v1/org/offboarding/exit-requests/${EXIT_UUID}/assets`],
    ["get", `/api/v1/org/offboarding/exit-requests/${EXIT_UUID}/settlement`],
  ];

  for (const [method, path] of routes) {
    it(`${method.toUpperCase()} ${path} is routed and does not 500`, async () => {
      const res = await request(app)[method](path);
      expect(res.status, `${method} ${path} -> ${res.status} ${JSON.stringify(res.body)}`).toBe(200);
    });
  }

  it("POST review executes, carrying the decision notes through", async () => {
    // The regression. Before the fix this answered 500 with a masked body.
    const res = await request(app)
      .post(`/api/v1/org/offboarding/exit-requests/${EXIT_UUID}/review`)
      .send({ decision: "approved", notice_period_days: 30, decision_notes: "Contract is 30 days" });

    expect(res.status, `review -> ${res.status} ${JSON.stringify(res.body)}`).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.exit_request.status).toBe("pending");
  });

  it("POST review REJECTS a decision it cannot honour, rather than answering 500", async () => {
    const res = await request(app)
      .post(`/api/v1/org/offboarding/exit-requests/${EXIT_UUID}/review`)
      .send({ decision: "maybe" });

    // 400 from the service. A 500 here would mean the handler threw rather than
    // refused, which is the distinction the whole error contract turns on.
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("POST checklist clear executes on an APPROVED exit", async () => {
    globalThis.__exitStatus = "approved";
    const res = await request(app)
      .post(`/api/v1/org/offboarding/exit-requests/${EXIT_UUID}/checklist/${CHECKLIST_UUID}`)
      .send({ notes: "done" });
    expect(res.status, `clear -> ${res.status} ${JSON.stringify(res.body)}`).toBe(200);
  });

  it("POST checklist clear is REFUSED while the exit is still pending", async () => {
    // Clearing work against an exit nobody approved would let the checklist read
    // complete on a request that may still be rejected.
    globalThis.__exitStatus = "pending";
    const res = await request(app)
      .post(`/api/v1/org/offboarding/exit-requests/${EXIT_UUID}/checklist/${CHECKLIST_UUID}`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/must be approved before clearance/);
  });

  it("POST exit-request submission is routed", async () => {
    const res = await request(app).post("/api/v1/org/offboarding/exit-requests").send({
      employee_uuid: "44444444-4444-4444-8444-444444444444",
      request_type: "resignation",
      notice_period_days: 30,
      last_working_day: "2026-10-31",
    });
    // 201: a submission creates a request and a checklist, so it is not a 200.
    expect(res.status, `submit -> ${res.status} ${JSON.stringify(res.body)}`).toBe(201);
  });

  it("the literal /clearances path is not swallowed by a uuid matcher", async () => {
    // The registration-order trap: if /offboarding/:uuid were registered first,
    // "clearances" would be read as a uuid and 400. Asserting the dashboard
    // answers is the only way to notice it stopped answering.
    const res = await request(app).get("/api/v1/org/offboarding/clearances");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.items)).toBe(true);
  });
});

describe("the employee self-service route is mounted at the path the client asks for", () => {
  it("GET /my/resignation is not a 404", async () => {
    // The /my/assets sibling shipped with the two halves disagreeing: router
    // mounted at /my-assets, client requesting /my/assets. Same trap, same fix -
    // assert against the URL a client would actually use.
    const res = await request(app).get("/api/v1/my/resignation");
    expect(res.status, `got ${res.status}: ${JSON.stringify(res.body)}`).not.toBe(404);
    expect(res.status).toBe(200);
  });

  it("returns the employee's own exit, not a 403", async () => {
    const res = await request(app).get("/api/v1/my/resignation");
    expect(res.status).toBe(200);
    expect(res.body.data.exit_request).toBeTruthy();
    expect(res.body.data.exit_request.employee_uuid).toBeUndefined();
  });

  it("POST /my/resignation is routed", async () => {
    const res = await request(app)
      .post("/api/v1/my/resignation")
      .send({ last_working_day: "2026-10-31", reason: "Moving on" });
    // 201: a submission creates a request and a checklist, so it is not a 200.
    expect(res.status, `submit -> ${res.status} ${JSON.stringify(res.body)}`).toBe(201);
  });

  it("an account with no employee record is told so, not given a confusing failure", async () => {
    globalThis.__noEmployeeRecord = true;
    const res = await request(app).get("/api/v1/my/resignation");
    expect(res.status).toBe(200);
    expect(res.body.data.exit_request).toBeNull();
  });

  it("POST from an account with no employee record is refused with a reason", async () => {
    globalThis.__noEmployeeRecord = true;
    const res = await request(app).post("/api/v1/my/resignation").send({ last_working_day: "2026-10-31" });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/not linked to an employee record/);
  });

  it("is NOT routed at a hyphenated path", async () => {
    const res = await request(app).get("/api/v1/my-resignation");
    expect(res.status).toBe(404);
  });
});