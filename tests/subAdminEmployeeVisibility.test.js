import { describe, it, expect, vi, beforeEach } from "vitest";

// Organization employees and platform accounts are visible within the tenant;
// sub-admin data scopes may further narrow employee-linked records.

vi.mock("../src/config/db.js", () => ({ pool: { query: vi.fn() } }));

import { pool } from "../src/config/db.js";
import { listEmployees } from "../src/controllers/admin/employees.controller.js";
import { listOrgUsers } from "../src/controllers/org/users.controller.js";

const ORG_ID = 2;
const ADMIN_UUID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const SUB_UUID = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

const orgAdmin = { uuid: ADMIN_UUID, id: 1, org_role: "org_admin", organization: ORG_ID };
const subAdmin = { uuid: SUB_UUID, id: 2, org_role: "sub_admin", organization: ORG_ID };

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

/** A staff request: scopeOrgId is what makes the caller "scoped". */
function staffReq(user, query = {}) {
  return { user, scopeOrgId: ORG_ID, query };
}

function statements() {
  return pool.query.mock.calls.map(([sql, params]) => ({
    sql: String(sql).replace(/\s+/g, " "),
    params,
  }));
}
const countStmt = () => statements().find((s) => s.sql.startsWith("SELECT COUNT(*)"));
const rowStmt = () => statements().find((s) => /SELECT e\.id/.test(s.sql));

beforeEach(() => {
  pool.query.mockReset();
  // assertRole passes, then resolveScopeOrganization's org lookup, then the
  // COUNT, then the rows.
  pool.query.mockImplementation(async (sql) => {
    const stmt = String(sql);
    if (stmt.includes("FROM organizations WHERE id=?")) return [[{ id: ORG_ID, uuid: "org-uuid" }]];
    if (stmt.startsWith("SELECT COUNT(*)")) return [[{ total: 0 }]];
    if (stmt.includes("INSERT") || stmt.includes("UPDATE")) return [{ affectedRows: 1 }];
    return [[]];
  });
});

describe("listEmployees — sub-admin sees the org roster", () => {
  it("does not filter by added_by_uuid for a sub-admin", async () => {
    await listEmployees(staffReq(subAdmin), mockRes());

    const count = countStmt();
    expect(count.sql).toContain("e.organization_id = ?");
    expect(count.sql).not.toContain("e.added_by_uuid = ?");
    // The sub-admin's own uuid must not be bound as a filter.
    expect(count.params).not.toContain(SUB_UUID);
  });

  it("still scopes the sub-admin to their own organization", async () => {
    await listEmployees(staffReq(subAdmin), mockRes());
    // Assert by membership rather than by index: the org scope and the status
    // filter are bound in different shapes now (the current-employee list binds
    // an IN-list into the SQL and passes no status param at all).
    expect(countStmt().params).toContain(ORG_ID);
  });

  it("keeps the current-employee status filter so both list views still work", async () => {
    await listEmployees(staffReq(subAdmin), mockRes());
    const count = countStmt();
    // Default view excludes ex-employees by status, not by the dropped
    // record_type column.
    expect(count.sql).toContain("e.status IN (");
    expect(count.sql).not.toContain("record_type");
  });

  it("shows only ex-employees in the reference view", async () => {
    await listEmployees(staffReq(subAdmin, { reference: "1" }), mockRes());
    const count = countStmt();
    expect(count.sql).toContain("e.status = ?");
    expect(count.params).toContain("ex_employee");
  });
});

describe("listEmployees — org_admin sees the organization roster", () => {
  it("does not filter employees by who added them", async () => {
    await listEmployees(staffReq(orgAdmin), mockRes());

    const count = countStmt();
    expect(count.sql).toContain("e.organization_id = ?");
    expect(count.sql).not.toContain("e.added_by_uuid = ?");
    expect(count.params).not.toContain(ADMIN_UUID);
  });

  it("keeps the organization boundary on both COUNT and rows", async () => {
    await listEmployees(staffReq(orgAdmin), mockRes());
    expect(countStmt().sql).toContain("e.organization_id = ?");
    expect(rowStmt().sql).toContain("e.organization_id = ?");
  });

  it("uses consistent filters for the COUNT and the row query", async () => {
    await listEmployees(staffReq(orgAdmin), mockRes());
    const count = countStmt().params;
    const row = rowStmt().params.slice(0, count.length);
    expect(row).toEqual(count);
  });
});

describe("listOrgUsers — platform accounts remain organization-scoped", () => {
  it("does not filter by added_by_uuid for a sub-admin", async () => {
    await listOrgUsers(staffReq(subAdmin), mockRes());
    const count = countStmt();
    expect(count.sql).toContain("u.organization = ?");
    expect(count.sql).not.toContain("e.added_by_uuid = ?");
    expect(count.params).not.toContain(SUB_UUID);
  });

  it("does not filter by which admin added the linked employee", async () => {
    await listOrgUsers(staffReq(orgAdmin), mockRes());
    expect(countStmt().sql).toContain("u.organization = ?");
    expect(countStmt().sql).not.toContain("e.added_by_uuid = ?");
    expect(countStmt().params).not.toContain(ADMIN_UUID);
  });
});

describe("the fix does not widen visibility across organizations", () => {
  it("the organization filter is still mandatory for a sub-admin", async () => {
    // Dropping the added_by filter must not have dropped the org boundary.
    await listEmployees(staffReq(subAdmin), mockRes());
    const count = countStmt();
    expect(count.sql).toContain("e.organization_id = ?");
    expect(count.params).toContain(ORG_ID);
    // And no other user-supplied identifier can stand in for the org.
    expect(count.sql).not.toContain("org_role");
  });
});

/**
 * Legacy ?scope=org picker callers remain tenant-bound and cannot bypass
 * sub-admin data scopes.
 */
describe("listEmployees — organization scope stays bounded", () => {
  it("shows org admins the roster regardless of query scope", async () => {
    await listEmployees(staffReq(orgAdmin, { scope: "org" }), mockRes());

    const count = countStmt();
    expect(count.sql).not.toContain("e.added_by_uuid = ?");
    expect(count.params).not.toContain(ADMIN_UUID);
    expect(count.sql).toContain("e.organization_id = ?");
    expect(count.params).toContain(ORG_ID);
  });

  it("applies the same scope to the COUNT and the row query", async () => {
    // A filter on one side only makes the total disagree with the page, so
    // pagination reports rows that are not there and hides rows that are.
    await listEmployees(staffReq(orgAdmin, { scope: "org" }), mockRes());
    expect(countStmt().sql).not.toContain("e.added_by_uuid = ?");
    expect(rowStmt().sql).not.toContain("e.added_by_uuid = ?");
  });

  it("still excludes ex-employees", async () => {
    await listEmployees(staffReq(orgAdmin, { scope: "org" }), mockRes());
    expect(countStmt().sql).toContain("e.status IN (");
    expect(countStmt().sql).not.toContain("record_type");
  });

  it("has the same organization-wide visibility by default", async () => {
    await listEmployees(staffReq(orgAdmin), mockRes());
    expect(countStmt().sql).not.toContain("e.added_by_uuid = ?");
    expect(countStmt().sql).toContain("e.organization_id = ?");
  });

  it("does not let arbitrary scope values cross the tenant boundary", async () => {
    await listEmployees(staffReq(orgAdmin, { scope: "everything" }), mockRes());
    expect(countStmt().sql).toContain("e.organization_id = ?");
    expect(countStmt().params).toContain(ORG_ID);
  });

  it("changes nothing for a sub-admin, who already saw the whole roster", async () => {
    await listEmployees(staffReq(subAdmin, { scope: "org" }), mockRes());
    const count = countStmt();
    expect(count.sql).not.toContain("e.added_by_uuid = ?");
    expect(count.sql).toContain("e.organization_id = ?");
  });

  it("does not let the picker scope bypass a sub-admin's own-records scope", async () => {
    const scopedSubAdmin = {
      ...subAdmin,
      feature_access: { data_scopes: { employees: "own_records" } },
    };
    await listEmployees(staffReq(scopedSubAdmin, { scope: "org" }), mockRes());

    const count = countStmt();
    expect(count.sql).toContain("e.organization_id = ?");
    expect(count.sql).toContain("e.added_by_uuid = ?");
    expect(count.params).toContain(SUB_UUID);
  });
});
