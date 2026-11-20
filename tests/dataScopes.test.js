import { describe, expect, it } from "vitest";
import { employeeScopeCondition, getDataScope } from "../src/utils/dataScopes.js";

describe("employee-linked data scopes", () => {
  it("preserves organization-wide visibility for legacy users without saved scopes", () => {
    expect(getDataScope({ org_role: "sub_admin", feature_access: { manage_employees: true } }, "employees"))
      .toBe("entire_organization");
  });

  it("always leaves Org Admin with full organization scope", () => {
    expect(getDataScope({ org_role: "org_admin", feature_access: { data_scopes: { employees: "own_records" } } }, "employees"))
      .toBe("entire_organization");
  });

  it("filters own-record scope to employee records created by the caller", () => {
    const req = {
      user: { uuid: "user-1", org_role: "sub_admin", feature_access: { data_scopes: { employees: "own_records" } } },
      scopeOrgId: 7,
    };
    expect(employeeScopeCondition(req, "employees", "e")).toEqual({
      sql: "e.added_by_uuid = ?",
      params: ["user-1"],
    });
  });

  it("treats a previously saved team scope as own-record scope", () => {
    const req = {
      user: { uuid: "user-1", org_role: "sub_admin", feature_access: { data_scopes: { attendance: "my_team" } } },
      scopeOrgId: 7,
    };
    expect(getDataScope(req.user, "attendance")).toBe("own_records");
    expect(employeeScopeCondition(req, "attendance", "e")).toEqual({
      sql: "e.added_by_uuid = ?",
      params: ["user-1"],
    });
  });

  it("does not apply a SQL filter for entire-organization scope", () => {
    const req = {
      user: { uuid: "user-1", org_role: "sub_admin", feature_access: { data_scopes: { payroll: "entire_organization" } } },
      scopeOrgId: 7,
    };
    expect(employeeScopeCondition(req, "payroll", "e")).toBeNull();
  });
});
