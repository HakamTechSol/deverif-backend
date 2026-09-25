import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/config/db.js", () => ({ pool: { query: vi.fn(), getConnection: vi.fn() } }));
vi.mock("../src/utils/auditLog.js", () => ({
  logAudit: vi.fn().mockResolvedValue({}),
  getActorFromReq: vi.fn(() => ({ actorType: "admin" })),
}));

import { pool } from "../src/config/db.js";
import { cancelInvite } from "../src/controllers/admin/users.controller.js";

const USER = {
  id: 7,
  uuid: "cb86cb99-b5d4-11f1-9e94-9840bb468dc0",
  email: "pending@example.com",
  full_name: "Pending User",
  is_verified: "no",
};

function mockConn() {
  return {
    beginTransaction: vi.fn().mockResolvedValue(),
    query: vi.fn().mockResolvedValue([{}]),
    commit: vi.fn().mockResolvedValue(),
    rollback: vi.fn().mockResolvedValue(),
    release: vi.fn().mockResolvedValue(),
  };
}

const req = { params: { uuid: USER.uuid }, user: { id: 1, role: "admin" } };

beforeEach(() => vi.clearAllMocks());

describe("cancelInvite — removes the invitation completely so a later resend is not blocked", () => {
  it("deletes ALL invite tokens for the user (not just unused ones)", async () => {
    pool.query.mockResolvedValueOnce([[USER]]); // lookup
    const conn = mockConn();
    pool.getConnection.mockResolvedValue(conn);

    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };
    await cancelInvite(req, res);

    const deletes = conn.query.mock.calls.filter(([sql]) => sql.startsWith("DELETE FROM invite_tokens"));
    expect(deletes.length).toBe(1);
    expect(deletes[0][0]).toContain("WHERE user_uuid=?");
    expect(deletes[0][0]).not.toContain("used_at IS NULL");
    expect(conn.commit).toHaveBeenCalledTimes(1);
  });
});