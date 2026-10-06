import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * Every way a client can fail to name an employee, checked at the HTTP boundary.
 *
 * Written because this was reported as a 500 and the belief that a missing
 * employee_uuid could produce one is worth testing rather than arguing about:
 * a throw inside the transaction that is not an ApiError reaches errorHandler
 * with no statusCode, and errorHandler answers 500 with a masked
 * "Internal Server Error" - the least diagnosable response in the system.
 *
 * The guard belongs in the service, not the controller, because the service is
 * what owns the transaction. A controller-level check would still let a direct
 * service caller (a script, a future route, a job) write an assignment with no
 * employee.
 */

const ORG = 7;
const ASSET = "11111111-1111-4111-8111-111111111111";
const EMPLOYEE = "22222222-2222-4222-8222-222222222222";
const ADMIN = "640aa412-bf20-11f1-aeb4-9840bb468dc0";

const conn = {
  query: vi.fn(),
  beginTransaction: vi.fn(),
  commit: vi.fn(),
  rollback: vi.fn(),
  release: vi.fn(),
};

vi.mock("../src/config/db.js", () => ({
  pool: { ...conn, getConnection: async () => conn },
}));

const { assignAsset } = await import("../src/controllers/org/assets.controller.js");
const errorHandler = (await import("../src/middleware/errorHandler.js")).default;

const app = express();
app.use(express.json());
app.post("/org/assets/:uuid/assign", (req, res, next) => {
  req.scopeOrgId = ORG;
  req.user = { uuid: ADMIN };
  assignAsset(req, res).catch(next);
});
app.use(errorHandler);

/** Rows the happy path sees; overridden per case where the employee matters. */
function stubHappyPath(employeeUuid = EMPLOYEE) {
  conn.query.mockImplementation(async (sql) => {
    const s = String(sql);
    if (s.includes("FROM assets a")) {
      return [[{ uuid: ASSET, status: "available", organization_id: ORG }], []];
    }
    if (s.includes("COUNT(*) AS n FROM asset_maintenance")) return [[{ n: 0 }], []];
    if (s.includes("COUNT(*) AS n FROM asset_assignments")) return [[{ n: 1 }], []];
    if (s.includes("FROM employees")) {
      return [[{ uuid: employeeUuid, full_name: "Kinza", linked_user_uuid: null }], []];
    }
    if (s.startsWith("INSERT")) return [{ insertId: 1 }, []];
    return [[{ uuid: "x" }], []];
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  stubHappyPath();
});

const post = (body) => request(app).post(`/org/assets/${ASSET}/assign`).send(body);

/**
 * Each of these is something a real client does: the field is omitted, sent
 * null, sent blank by an untouched input, or sent under the wrong key because
 * the payload was built with a different casing convention.
 */
const MISSING_EMPLOYEE = [
  ["no request body at all", undefined],
  ["an empty object", {}],
  ["an empty string", { employee_uuid: "" }],
  ["null", { employee_uuid: null }],
  ["whitespace only", { employee_uuid: "   " }],
  ["a tab and newline", { employee_uuid: "\t\n" }],
  ["the wrong key name (camelCase)", { employeeUuid: EMPLOYEE }],
  ["the wrong key name (user_id)", { user_id: EMPLOYEE }],
  ["undefined spelled as a string", { employee_uuid: "undefined" }],
  ["no selection sent as 0", { employee_uuid: 0 }],
];

describe("assigning without an employee never reaches the database", () => {
  it.each(MISSING_EMPLOYEE)("%s is a 400, not a 500", async (_label, body) => {
    const r = await post(body);
    expect(r.status, `got ${r.status}: ${JSON.stringify(r.body)}`).toBe(400);
  });

  it.each(MISSING_EMPLOYEE)("%s writes no assignment row", async (_label, body) => {
    await post(body);
    const inserted = conn.query.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO asset_assignments"));
    expect(inserted).toHaveLength(0);
  });

  it("always leaves the transaction rolled back, never committed", async () => {
    for (const [, body] of MISSING_EMPLOYEE) {
      vi.clearAllMocks();
      stubHappyPath();
      await post(body);
      expect(conn.commit, "a rejected assign must not commit").not.toHaveBeenCalled();
      expect(conn.rollback).toHaveBeenCalled();
      // Leaking the connection instead of releasing it exhausts the pool, and
      // the next unrelated request fails with a 500 that names no cause.
      expect(conn.release).toHaveBeenCalled();
    }
  });

  it("asks the person to pick someone, in words they can act on", async () => {
    // "employee_uuid is required" describes the payload, not the problem. The
    // user did not know there was a uuid field; they left a dropdown empty.
    const r = await post({});
    expect(r.body.message).toBe("Please select an employee");
  });

  it("blames a malformed uuid only when one was actually sent", async () => {
    // Distinct messages for "nothing was picked" and "that is not a uuid", so
    // the response points at the real problem.
    const r = await post({ employee_uuid: "not-a-uuid" });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/valid UUID/i);
  });
});

describe("a valid uuid that is not an employee in this organization", () => {
  it("is a 404 and writes nothing", async () => {
    conn.query.mockImplementation(async (sql) => {
      const s = String(sql);
      if (s.includes("FROM assets a")) return [[{ uuid: ASSET, status: "available", organization_id: ORG }], []];
      if (s.includes("FROM employees")) return [[], []];
      return [[], []];
    });
    const r = await post({ employee_uuid: EMPLOYEE });
    // Not a 400: the client sent a well-formed value, the reference is simply
    // wrong. Not a 403 either - that would imply the employee exists elsewhere.
    expect(r.status).toBe(404);
    const inserted = conn.query.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO asset_assignments"));
    expect(inserted).toHaveLength(0);
  });
});

describe("the stored employee_uuid is the employee's own uuid", () => {
  it("writes the value the lookup confirmed, not the client's string", async () => {
    const r = await post({ employee_uuid: EMPLOYEE });
    expect(r.status).toBe(200);

    const insert = conn.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO asset_assignments"));
    const params = insert[1];
    // /my/assets joins asset_assignments.employee_uuid to employees.uuid, so a
    // mismatch here is invisible in the staff view and empty on the employee's.
    expect(params[2]).toBe(EMPLOYEE);
  });

  it("cannot be steered to a different employee than the one verified", async () => {
    // The lookup proves employee X exists in this org; the insert must store X
    // even if the client and the lookup could somehow disagree.
    const STALE = "33333333-3333-4333-8333-333333333333";
    conn.query.mockImplementation(async (sql) => {
      const s = String(sql);
      if (s.includes("FROM assets a")) return [[{ uuid: ASSET, status: "available", organization_id: ORG }], []];
      if (s.includes("COUNT(*) AS n FROM asset_maintenance")) return [[{ n: 0 }], []];
      if (s.includes("COUNT(*) AS n FROM asset_assignments")) return [[{ n: 1 }], []];
      if (s.includes("FROM employees")) {
        return [[{ uuid: STALE, full_name: "Kinza", linked_user_uuid: null }], []];
      }
      if (s.startsWith("INSERT")) return [{ insertId: 1 }, []];
      return [[{ uuid: "x" }], []];
    });

    await post({ employee_uuid: EMPLOYEE });
    const insert = conn.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO asset_assignments"));
    expect(insert[1][2]).toBe(STALE);
  });
});