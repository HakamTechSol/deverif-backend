import { describe, it, expect, vi, beforeEach } from "vitest";

// Regression: sub-admins saw an EMPTY Employees list.
//
// The cause was a per-admin visibility filter, added so that each org_admin sees
// only the employee records they personally added, but applied to every scoped
// caller — and sub-admins are scoped callers too (STAFF_ROLES =
// [org_admin, sub_admin]). Since the roster is imported by the org_admin, a
// sub-admin's list was filtered down to zero while their granted
// 'manage_employees' permission silently did nothing.
//
// These tests pin the role split: org_admin keeps the isolation rule, sub-admin
// sees the whole org roster.

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
function staffReq(user) {
  return { user, scopeOrgId: ORG_ID, query: {} };
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
    // Param order is record_type first, then the org scope, so assert by
    // membership rather than by index.
    expect(countStmt().params).toContain(ORG_ID);
  });

  it("keeps the record_type filter so roster/reference views still work", async () => {
    await listEmployees(staffReq(subAdmin), mockRes());
    const count = countStmt();
    expect(count.sql).toContain("e.record_type = ?");
    expect(count.params).toContain("roster");
  });
});

describe("listEmployees — org_admin keeps per-admin isolation", () => {
  it("still filters by added_by_uuid for an org_admin", async () => {
    await listEmployees(staffReq(orgAdmin), mockRes());

    const count = countStmt();
    expect(count.sql).toContain("e.added_by_uuid = ?");
    expect(count.params).toContain(ADMIN_UUID);
  });

  it("applies the same filter to both the COUNT and the row query", async () => {
    // If only one side had it, the total and the page would disagree and
    // pagination would silently lie.
    await listEmployees(staffReq(orgAdmin), mockRes());
    expect(countStmt().sql).toContain("e.added_by_uuid = ?");
    expect(rowStmt().sql).toContain("e.added_by_uuid = ?");
  });

  it("binds identical params to the COUNT and the row query", async () => {
    await listEmployees(staffReq(orgAdmin), mockRes());
    const count = countStmt().params;
    const row = rowStmt().params.slice(0, count.length);
    expect(row).toEqual(count);
  });
});

describe("listOrgUsers — same role split on the platform-accounts list", () => {
  it("does not filter by added_by_uuid for a sub-admin", async () => {
    await listOrgUsers(staffReq(subAdmin), mockRes());
    const count = countStmt();
    expect(count.sql).toContain("u.organization = ?");
    expect(count.sql).not.toContain("e.added_by_uuid = ?");
    expect(count.params).not.toContain(SUB_UUID);
  });

  it("still filters by added_by_uuid for an org_admin", async () => {
    await listOrgUsers(staffReq(orgAdmin), mockRes());
    expect(countStmt().sql).toContain("e.added_by_uuid = ?");
    expect(countStmt().params).toContain(ADMIN_UUID);
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
