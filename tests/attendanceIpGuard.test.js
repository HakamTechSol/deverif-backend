/**
 * Attendance must be completely OFF until an org admin has configured at least
 * one allowed office IP — including for a developer hitting the API from
 * localhost, which ALLOW_LOOPBACK_ATTENDANCE used to wave through.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/config/db.js", () => ({ pool: { query: vi.fn() } }));

import { pool } from "../src/config/db.js";
import { checkIn, checkOut } from "../src/controllers/attendance.controller.js";

const ORG_ID = 1;

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

function makeReq() {
  return {
    user: { id: 1, uuid: "user-uuid", org_role: "employee", organization: ORG_ID },
    ip: "::1",
    body: {},
    headers: {},
  };
}

/** Route statements: employee lookup, org lookup, ip rules, attendance rows. */
function installRouter(rules) {
  pool.query.mockImplementation(async (sql) => {
    const s = String(sql);
    if (s.includes("FROM employees WHERE linked_user_uuid")) {
      return [[{ uuid: "emp-uuid", organization_id: ORG_ID, is_platform_user: "yes" }]];
    }
    if (s.includes("FROM organizations WHERE id")) return [[{ id: ORG_ID }]];
    if (s.includes("FROM organization_ip_rules")) return [rules];
    if (s.includes("FROM attendance_records WHERE id")) {
      return [[{ uuid: "att-uuid", employee_uuid: "emp-uuid", status: "checked_in" }]];
    }
    if (s.includes("FROM attendance_records WHERE employee_uuid")) return [[]];
    return [{ affectedRows: 1, insertId: 1 }];
  });
}

const originalLoopback = process.env.ALLOW_LOOPBACK_ATTENDANCE;

beforeEach(() => {
  vi.resetAllMocks();
  process.env.ALLOW_LOOPBACK_ATTENDANCE = "true";
});

afterEach(() => {
  if (originalLoopback === undefined) delete process.env.ALLOW_LOOPBACK_ATTENDANCE;
  else process.env.ALLOW_LOOPBACK_ATTENDANCE = originalLoopback;
});

describe("attendance with no configured IPs", () => {
  it("blocks check-in when the org has zero allow rules, even from loopback", async () => {
    installRouter([]);
    await expect(checkIn(makeReq(), mockRes())).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringContaining("not enabled"),
    });
  });

  it("blocks check-out when the org has zero allow rules, even from loopback", async () => {
    installRouter([]);
    await expect(checkOut(makeReq(), mockRes())).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringContaining("not enabled"),
    });
  });

  it("does not treat a deny-only rule set as an enabled allow-list", async () => {
    installRouter([{ ip_address: "10.0.0.5", rule_type: "deny" }]);
    await expect(checkIn(makeReq(), mockRes())).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringContaining("not enabled"),
    });
  });
});

describe("attendance with configured IPs", () => {
  it("still lets the loopback dev bypass work once IPs exist", async () => {
    installRouter([{ ip_address: "10.0.0.5", rule_type: "allow" }]);
    await expect(checkIn(makeReq(), mockRes())).resolves.toBeDefined();
  });

  it("blocks a non-loopback IP that is not on the list", async () => {
    installRouter([{ ip_address: "10.0.0.5", rule_type: "allow" }]);
    const req = makeReq();
    req.ip = "203.0.113.9";
    await expect(checkIn(req, mockRes())).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringContaining("not on this organization's allowed list"),
    });
  });

  it("honours a deny rule for a listed IP", async () => {
    installRouter([
      { ip_address: "10.0.0.5", rule_type: "allow" },
      { ip_address: "::1", rule_type: "deny" },
    ]);
    process.env.ALLOW_LOOPBACK_ATTENDANCE = "false";
    await expect(checkIn(makeReq(), mockRes())).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringContaining("explicitly blocked"),
    });
  });
});
