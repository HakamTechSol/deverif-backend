import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/config/db.js", () => ({ pool: { query: vi.fn() } }));

import { pool } from "../src/config/db.js";
import { archiveReference } from "../src/controllers/admin/employees.controller.js";

const EMP_UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ORG_ID = 5;
const ORG_UUID = "bbbbbbbb-cccc-4ddd-9eee-ffffffffffff";

function makeReq(overrides = {}) {
  return {
    params: { uuid: EMP_UUID },
    scopeOrgId: ORG_ID,
    user: { id: 1, uuid: "actor-uuid", org_role: "org_admin", full_name: "Admin" },
    admin: null,
    ip: "127.0.0.1",
    headers: {},
    connection: { remoteAddress: "127.0.0.1" },
    ...overrides,
  };
}

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

function mockScopeOrg() {
  return [[{ id: ORG_ID, uuid: ORG_UUID }]];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("archiveReference", () => {
  it("archives an in-org employee as an ex_employee (happy path)", async () => {
    const emp = { uuid: EMP_UUID, organization_id: ORG_ID, status: "current_employee", full_name: "Jane Roe" };
    const archived = { ...emp, status: "ex_employee" };

    pool.query
      .mockResolvedValueOnce(mockScopeOrg())   // resolveScopeOrganization
      .mockResolvedValueOnce([[emp]])          // SELECT * FROM employees
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE
      .mockResolvedValueOnce([[archived]]);    // EMPLOYEE_SELECT

    const res = mockRes();
    await archiveReference(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(200);

    const updateCall = pool.query.mock.calls.find(([sql]) =>
      typeof sql === "string" && sql.startsWith("UPDATE employees")
    );
    // One column, one value. This used to write record_type='learned_reference'
    // AND status='resigned' — the dual-write the merge removed.
    expect(updateCall[0]).toContain("status='ex_employee'");
    expect(updateCall[0]).not.toContain("record_type");
    expect(updateCall[1]).toEqual([EMP_UUID]);

    const body = res.json.mock.calls[0][0];
    expect(body.success).toBe(true);
    expect(body.data.employee).toEqual(archived);
    expect(body.message).toBe("Employee archived as reference");
  });

  it("keeps ex_employee rows visible to staff lists (row is preserved)", async () => {
    // Regression guard: archiving must NOT delete the row — it only moves it to
    // the ex-employee status, which is what the org dashboard filters rely on.
    // An archived employee keeps their documents, so the auto-match reference
    // pool stays intact.
    const emp = { uuid: EMP_UUID, organization_id: ORG_ID, status: "current_employee", full_name: "Term Case" };
    const archived = { ...emp, status: "ex_employee" };

    pool.query
      .mockResolvedValueOnce(mockScopeOrg())
      .mockResolvedValueOnce([[emp]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[archived]]);

    const res = mockRes();
    await archiveReference(makeReq(), res);

    const deleteCall = pool.query.mock.calls.find(([sql]) =>
      typeof sql === "string" && /^DELETE\b/.test(sql)
    );
    expect(deleteCall).toBeUndefined();
    expect(res.json.mock.calls[0][0].data.employee.status).toBe("ex_employee");
  });

  it("rejects archiving an employee from another organization (403)", async () => {
    pool.query
      .mockResolvedValueOnce(mockScopeOrg())
      .mockResolvedValueOnce([[{ uuid: EMP_UUID, organization_id: 999, status: "active", full_name: "Other" }]]);

    const res = mockRes();
    await expect(archiveReference(makeReq(), res)).rejects.toMatchObject({
      statusCode: 403,
      message: "You can only manage employees within your organization",
    });
  });

  it("returns 404 when the employee does not exist", async () => {
    pool.query
      .mockResolvedValueOnce(mockScopeOrg())
      .mockResolvedValueOnce([[]]);

    const res = mockRes();
    await expect(archiveReference(makeReq(), res)).rejects.toMatchObject({
      statusCode: 404,
      message: "Employee not found",
    });
  });

  it("rejects non-staff roles with 403", async () => {
    const res = mockRes();
    await expect(archiveReference(makeReq({ user: { id: 2, org_role: "employee" } }), res)).rejects.toMatchObject({
      statusCode: 403,
      message: "You do not have permission to perform this action",
    });
  });
});