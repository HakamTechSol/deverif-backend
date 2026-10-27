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

/**
 * ?scope=org - the asset Assign picker.
 *
 * The per-admin filter is right for the Employees page, which is a work queue of
 * "records I imported", and wrong for a picker over the company. Handing a laptop
 * to a colleague another admin onboarded is a normal thing to do, so the picker
 * needs the whole org roster; with the filter on, that person was not hidden
 * behind a "show more" but ABSENT, and the only symptom was that the company's
 * own employees seemed not to exist.
 *
 * So the opt-out is deliberate and narrow. The tenant boundary is what must not
 * move, and it is asserted separately below.
 */
describe("listEmployees — ?scope=org gives an org_admin the whole roster", () => {
  it("drops the added_by_uuid filter", async () => {
    await listEmployees(staffReq(orgAdmin, { scope: "org" }), mockRes());

    const count = countStmt();
    expect(count.sql).not.toContain("e.added_by_uuid = ?");
    expect(count.params).not.toContain(ADMIN_UUID);
  });

  it("keeps the organization boundary — this is not a cross-tenant switch", async () => {
    await listEmployees(staffReq(orgAdmin, { scope: "org" }), mockRes());

    const count = countStmt();
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
    // Widening to the org roster must not turn the picker into the full history:
    // an ex-employee must not be assignable company property.
    await listEmployees(staffReq(orgAdmin, { scope: "org" }), mockRes());
    expect(countStmt().sql).toContain("e.status IN (");
    expect(countStmt().sql).not.toContain("record_type");
  });

  it("is opt-in: the default list is unchanged", async () => {
    // Guard against the opt-out being made the default later, which would quietly
    // undo the per-admin isolation the Employees page depends on.
    await listEmployees(staffReq(orgAdmin), mockRes());
    expect(countStmt().sql).toContain("e.added_by_uuid = ?");
    expect(countStmt().params).toContain(ADMIN_UUID);
  });

  it("ignores any other scope value", async () => {
    // Only the exact literal widens. An unrecognised value must not be treated as
    // "close enough", because this parameter is a visibility control.
    await listEmployees(staffReq(orgAdmin, { scope: "everything" }), mockRes());
    expect(countStmt().sql).toContain("e.added_by_uuid = ?");

    pool.query.mockClear();
    await listEmployees(staffReq(orgAdmin, { scope: "" }), mockRes());
    expect(countStmt().sql).toContain("e.added_by_uuid = ?");
  });

  it("changes nothing for a sub-admin, who already saw the whole roster", async () => {
    await listEmployees(staffReq(subAdmin, { scope: "org" }), mockRes());
    const count = countStmt();
    expect(count.sql).not.toContain("e.added_by_uuid = ?");
    expect(count.sql).toContain("e.organization_id = ?");
  });
});
