import { describe, it, expect, vi, beforeEach } from "vitest";

// Org-scoped mirror of the platform /admin/users pending-invite lifecycle.
//
// The security-relevant part is the SCOPE: loadSubAdminInScope must reject a
// sub-admin belonging to a different organization, and must reject anything
// that is not a sub_admin. Without that, an org admin could cancel or delete a
// user in another org by guessing a UUID — so those cases are asserted first and
// loudest.

vi.mock("../src/config/db.js", () => ({ pool: { query: vi.fn(), getConnection: vi.fn() } }));

import { pool } from "../src/config/db.js";
import {
  cancelAdminUserInvite,
  removeAdminUserPermanently,
} from "../src/controllers/org/adminUsers.controller.js";

const SCOPE_ORG = 20;
const OTHER_ORG = 99;
const ACTOR_UUID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const TARGET_UUID = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const REGULAR_USER_UUID = "cccccccc-3333-4333-8333-cccccccccccc";

function mockReq(uuid = TARGET_UUID) {
  return {
    params: { uuid },
    body: {},
    user: { uuid: ACTOR_UUID, id: 1, organization: SCOPE_ORG, org_role: "org_admin" },
    scopeOrgId: SCOPE_ORG,
  };
}
function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

function subAdminRow(overrides = {}) {
  return {
    id: 5,
    uuid: TARGET_UUID,
    full_name: "Sub Admin",
    email: "sub@acme.test",
    organization: SCOPE_ORG,
    org_role: "sub_admin",
    status: "inactive",
    is_verified: "no",
    ...overrides,
  };
}

/** A transaction connection that records what it was asked to do. */
function fakeConnection() {
  const conn = {
    query: vi.fn(async (sql) => {
      if (String(sql).includes("DELETE FROM users")) return [{ affectedRows: 1 }];
      return [{ affectedRows: 1 }];
    }),
    beginTransaction: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
    rollback: vi.fn(async () => {}),
    release: vi.fn(),
  };
  pool.getConnection.mockResolvedValue(conn);
  return conn;
}

const sqlOf = (conn) => conn.query.mock.calls.map(([sql]) => String(sql));

beforeEach(() => {
  // mockReset, not clearAllMocks: several tests throw before reaching the DB,
  // and an unconsumed queued value would otherwise leak into the next test.
  pool.query.mockReset();
  pool.getConnection.mockReset();
});

describe("org sub-admin invite lifecycle — scope enforcement", () => {
  it("cancel: 403 when the sub-admin belongs to a different organization", async () => {
    pool.query.mockResolvedValueOnce([[subAdminRow({ organization: OTHER_ORG })]]);

    await expect(cancelAdminUserInvite(mockReq(), mockRes())).rejects.toMatchObject({
      statusCode: 403,
    });
    // Nothing was even opened.
    expect(pool.getConnection).not.toHaveBeenCalled();
  });

  it("remove: 403 when the sub-admin belongs to a different organization", async () => {
    pool.query.mockResolvedValueOnce([[subAdminRow({ organization: OTHER_ORG })]]);

    await expect(removeAdminUserPermanently(mockReq(), mockRes())).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(pool.getConnection).not.toHaveBeenCalled();
  });

  it("cancel: 409 when the target is not a sub_admin", async () => {
    // A regular member of the same org is reachable by UUID but must not be
    // cancellable through the sub-admin endpoint.
    pool.query.mockResolvedValueOnce([[subAdminRow({ org_role: "employee" })]]);

    await expect(cancelAdminUserInvite(mockReq(), mockRes())).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("remove: 409 when the target is not a sub_admin", async () => {
    pool.query.mockResolvedValueOnce([[subAdminRow({ org_role: "org_admin" })]]);

    await expect(removeAdminUserPermanently(mockReq(), mockRes())).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("cancel: 409 when targeting yourself", async () => {
    pool.query.mockResolvedValueOnce([[subAdminRow({ uuid: ACTOR_UUID })]]);

    await expect(cancelAdminUserInvite(mockReq(ACTOR_UUID), mockRes())).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("remove: 404 when the user does not exist", async () => {
    pool.query.mockResolvedValueOnce([[]]);

    await expect(
      removeAdminUserPermanently(mockReq(REGULAR_USER_UUID), mockRes())
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("org sub-admin invite lifecycle — already accepted is refused", () => {
  it("cancel: 400 once is_verified='yes', telling the caller to deactivate", async () => {
    pool.query.mockResolvedValueOnce([[subAdminRow({ is_verified: "yes", status: "active" })]]);

    await expect(cancelAdminUserInvite(mockReq(), mockRes())).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("deactivate"),
    });
    expect(pool.getConnection).not.toHaveBeenCalled();
  });

  it("remove: 400 once is_verified='yes'", async () => {
    pool.query.mockResolvedValueOnce([[subAdminRow({ is_verified: "yes", status: "active" })]]);

    await expect(removeAdminUserPermanently(mockReq(), mockRes())).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(pool.getConnection).not.toHaveBeenCalled();
  });
});

describe("org sub-admin invite lifecycle — cancel a pending invite", () => {
  it("deletes every invite token and marks the account inactive", async () => {
    pool.query.mockResolvedValueOnce([[subAdminRow()]]);
    const conn = fakeConnection();

    const res = mockRes();
    await cancelAdminUserInvite(mockReq(), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(conn.beginTransaction).toHaveBeenCalled();
    expect(conn.commit).toHaveBeenCalledTimes(1);
    expect(conn.rollback).not.toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalled();

    const sql = sqlOf(conn);
    // EVERY token, not just unused ones: a previous resend marks the old token
    // used, and leaving it behind blocks a later resend after this cancel.
    expect(sql.some((s) => s.includes("DELETE FROM invite_tokens WHERE user_uuid=?"))).toBe(true);
    // The is_verified='no' guard is in the UPDATE too, so a race that accepts the
    // invite mid-flight cannot leave a cancelled-but-active account behind.
    expect(
      sql.some((s) => s.includes("UPDATE users SET status='inactive'") && s.includes("is_verified='no'"))
    ).toBe(true);
  });
});

describe("org sub-admin invite lifecycle — permanently remove a pending invite", () => {
  it("unlinks the employee row, deletes the user, and commits", async () => {
    pool.query.mockResolvedValueOnce([[subAdminRow()]]);
    const conn = fakeConnection();

    const res = mockRes();
    await removeAdminUserPermanently(mockReq(), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(conn.commit).toHaveBeenCalledTimes(1);
    expect(conn.rollback).not.toHaveBeenCalled();

    const sql = sqlOf(conn);
    expect(sql.some((s) => s.includes("DELETE FROM invite_tokens"))).toBe(true);
    // employees.linked_user_uuid is a FK to users; unlink before deleting.
    const unlinkIdx = sql.findIndex((s) => s.includes("UPDATE employees SET linked_user_uuid=NULL"));
    const deleteIdx = sql.findIndex((s) => s.includes("DELETE FROM users"));
    expect(unlinkIdx).toBeGreaterThanOrEqual(0);
    expect(deleteIdx).toBeGreaterThan(unlinkIdx);
    expect(sql[deleteIdx]).toContain("is_verified='no'");
  });

  it("rolls back with 409 when the delete affects no rows (raced state change)", async () => {
    pool.query.mockResolvedValueOnce([[subAdminRow()]]);
    const conn = fakeConnection();
    conn.query.mockImplementation(async (sql) => {
      if (String(sql).includes("DELETE FROM users")) return [{ affectedRows: 0 }];
      return [{ affectedRows: 1 }];
    });

    await expect(removeAdminUserPermanently(mockReq(), mockRes())).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(conn.rollback).toHaveBeenCalledTimes(1);
    expect(conn.commit).not.toHaveBeenCalled();
  });

  it("rolls back and releases the connection when a statement throws", async () => {
    pool.query.mockResolvedValueOnce([[subAdminRow()]]);
    const conn = fakeConnection();
    conn.query.mockRejectedValueOnce(new Error("ER_LOCK_DEADLOCK"));

    await expect(removeAdminUserPermanently(mockReq(), mockRes())).rejects.toThrow(/ER_LOCK_DEADLOCK/);
    expect(conn.rollback).toHaveBeenCalledTimes(1);
    expect(conn.commit).not.toHaveBeenCalled();
    // Released even on the failure path, or the pool leaks a connection.
    expect(conn.release).toHaveBeenCalled();
  });
});
