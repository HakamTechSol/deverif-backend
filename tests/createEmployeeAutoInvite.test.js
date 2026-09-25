/**
 * createEmployee auto-invite: an employee saved WITH an email is created as a
 * platform user and a set-password link is emailed, and — critically — this is
 * NOT gated on the organization's subscription. The invite is the employee's
 * way in; what they can see afterwards is decided per-request by the plan.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  conn: {
    query: vi.fn(),
    beginTransaction: vi.fn(),
    commit: vi.fn(),
    rollback: vi.fn(),
    release: vi.fn(),
  },
}));

vi.mock("../src/config/db.js", () => ({
  pool: { query: vi.fn(), getConnection: vi.fn(async () => h.conn) },
}));
vi.mock("../src/utils/mailer.js", () => ({
  sendInviteEmail: vi.fn().mockResolvedValue({}),
}));

import { pool } from "../src/config/db.js";
import { sendInviteEmail } from "../src/utils/mailer.js";
import { createEmployee } from "../src/controllers/admin/employees.controller.js";

const ORG_UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const EMAIL = "asad@example.com";
const OWNER = {
  full_name: "Asad",
  cnic: "42501-7363763-7",
  phone: "0364754647",
  emergency_contact: "0364754647",
  organization_uuid: ORG_UUID,
};

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

function makeReq(body) {
  return {
    body,
    user: { id: 1, org_role: "org_admin", organization: null, full_name: "Admin" },
    admin: null,
    query: {},
  };
}

/** Route every conn/pool statement through a shape-aware router. */
function installRouter() {
  const route = (sql) => {
    const s = String(sql);
    if (s.includes("SELECT id FROM organizations")) return [[{ id: 1 }]];
    if (s.includes("SELECT uuid FROM users WHERE email")) return [[]];
    if (s.includes("SELECT id FROM organizations WHERE id")) return [[{ id: 1 }]];
    if (s.includes("INSERT INTO users")) return [{ insertId: 55 }];
    if (s.includes("SELECT uuid FROM users WHERE id")) return [[{ uuid: "user-uuid-1" }]];
    if (s.includes("SELECT uuid FROM employees WHERE id")) return [[{ uuid: "emp-uuid-1" }]];
    if (s.includes("SELECT r") || s.includes("SELECT e.id")) return [[{ uuid: "emp-uuid-1" }]];
    if (s.includes("SELECT id FROM designations")) return [[]];
    if (s.includes("SELECT id FROM departments")) return [[]];
    if (s.includes("SELECT uuid FROM employees WHERE email")) return [[]];
    if (s.includes("SELECT uuid FROM employees WHERE cnic")) return [[]];
    return [{}];
  };
  h.conn.query.mockImplementation(async (sql) => route(sql));
  pool.query.mockImplementation(async (sql) => route(sql));
  pool.getConnection.mockResolvedValue(h.conn);
}

beforeEach(() => {
  vi.clearAllMocks();
  installRouter();
});

function connSql() {
  return h.conn.query.mock.calls.map(([sql]) => String(sql));
}

describe("createEmployee — automatic platform-user invite", () => {
  it("creates a platform user, an invite token and links the employee when an email is given", async () => {
    const res = mockRes();
    await createEmployee(makeReq({ document_type: undefined, ...OWNER, email: EMAIL }), res);

    const sql = connSql().join("\n");
    expect(sql).toContain("INSERT INTO users");
    expect(sql).toContain("INSERT INTO invite_tokens");
    expect(sql).toContain("UPDATE employees SET is_platform_user='yes'");
    // The platform account starts inactive until they set a password.
    expect(sql).toContain("'inactive'");
  });

  it("emails a set-password link containing the raw token", async () => {
    const res = mockRes();
    await createEmployee(makeReq({ ...OWNER, email: EMAIL }), res);

    expect(sendInviteEmail).toHaveBeenCalledTimes(1);
    const arg = sendInviteEmail.mock.calls[0][0];
    expect(arg.to).toBe(EMAIL);
    expect(arg.setLink).toMatch(/\/set-password\?token=/);
    expect(arg.setLink).not.toContain("undefined");
  });

  it("does NOT gate the invite on the organization's subscription", async () => {
    // resolveOrganizationId + the whole create path must run without any plan or
    // module-flag lookup. If a subscription gate were reintroduced it would show
    // up as an extra subscription/module query here.
    const res = mockRes();
    await createEmployee(makeReq({ ...OWNER, email: EMAIL }), res);

    const allSql = [...connSql(), ...pool.query.mock.calls.map(([s]) => String(s))].join("\n");
    expect(allSql).not.toMatch(/subscription_plans/);
    expect(allSql).not.toMatch(/module_flags/);
  });

  it("skips user creation entirely when no email is provided", async () => {
    const res = mockRes();
    await createEmployee(makeReq({ ...OWNER, email: undefined }), res);

    const sql = connSql().join("\n");
    expect(sql).not.toContain("INSERT INTO users");
    expect(sql).not.toContain("INSERT INTO invite_tokens");
    expect(sendInviteEmail).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0].message).toBe("Employee created successfully");
  });

  it("reports a mail failure without losing the created employee", async () => {
    sendInviteEmail.mockRejectedValueOnce(new Error("smtp down"));
    const res = mockRes();
    await createEmployee(makeReq({ ...OWNER, email: EMAIL }), res);

    const body = res.json.mock.calls[0][0];
    // The transaction is already committed by the time mail is attempted.
    expect(h.conn.commit).toHaveBeenCalled();
    expect(body.message).toContain("invite email failed");
    expect(body.data?._email_warning ?? body._email_warning).toContain("Invite email failed");
  });
});
