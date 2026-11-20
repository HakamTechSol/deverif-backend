import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config/db.js", () => ({ pool: { query: vi.fn() } }));

import { pool } from "../src/config/db.js";
import { listLeaveEmployees } from "../src/controllers/leave.controller.js";

const ADMIN_UUID = "123e4567-e89b-12d3-a456-426614174000";

function response() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
}

describe("listLeaveEmployees", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pool.query.mockResolvedValue([[]]);
  });

  it("restricts filter options to employees in the user's Leave data scope", async () => {
    const req = {
      scopeOrgId: 7,
      user: {
        uuid: ADMIN_UUID,
        org_role: "sub_admin",
        feature_access: { data_scopes: { leave_management: "own_records" } },
      },
    };

    await listLeaveEmployees(req, response());

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("e.added_by_uuid = ?"),
      [7, ADMIN_UUID],
    );
    expect(pool.query.mock.calls[0][0]).not.toContain("linked_user_uuid");
  });

  it("does not restrict filter options for organization admins", async () => {
    const req = {
      scopeOrgId: 7,
      user: { uuid: ADMIN_UUID, org_role: "org_admin" },
    };

    await listLeaveEmployees(req, response());

    const [query, params] = pool.query.mock.calls[0];
    expect(query).not.toContain("linked_user_uuid");
    expect(params).toEqual([7]);
  });
});
