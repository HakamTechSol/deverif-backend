import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/config/db.js", () => ({ pool: { query: vi.fn() } }));
vi.mock("../src/utils/mailer.js", () => ({
  sendInviteEmail: vi.fn().mockResolvedValue({}),
}));

import { pool } from "../src/config/db.js";
import { sendInviteEmail } from "../src/utils/mailer.js";
import { resendInvite } from "../src/controllers/admin/users.controller.js";

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

const UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const USER = {
  uuid: UUID,
  email: "ref@example.com",
  full_name: "Ref",
  status: "active",
  is_verified: "no",
};

beforeEach(() => vi.clearAllMocks());

describe("resendInvite — a fresh invite can always be resent", () => {
  it("allows resend for an unused invite even when status='active' (the reported bug)", async () => {
    pool.query
      .mockResolvedValueOnce([[USER]]) // user lookup
      .mockResolvedValueOnce([[{ used: 0 }]]) // used-token count
      .mockResolvedValueOnce([{}]) // UPDATE invite_tokens
      .mockResolvedValueOnce([{ insertId: 7 }]); // INSERT invite_tokens
    const res = mockRes();
    await resendInvite({ params: { uuid: UUID }, admin: { full_name: "Admin" } }, res);
    expect(sendInviteEmail).toHaveBeenCalledTimes(1);
    expect(res.json.mock.calls[0][0].message).toBe("Invite resent successfully");
  });

  it("blocks when the invite was already accepted (used token)", async () => {
    pool.query
      .mockResolvedValueOnce([[USER]])
      .mockResolvedValueOnce([[{ used: 1 }]]);
    const res = mockRes();
    await expect(
      resendInvite({ params: { uuid: UUID }, admin: {} }, res)
    ).rejects.toMatchObject({ message: "Invitation already accepted. Use forgot password instead." });
    expect(sendInviteEmail).not.toHaveBeenCalled();
  });

  it("blocks when the account is verified", async () => {
    pool.query.mockResolvedValueOnce([[{ ...USER, is_verified: "yes" }]]);
    const res = mockRes();
    await expect(
      resendInvite({ params: { uuid: UUID }, admin: {} }, res)
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(sendInviteEmail).not.toHaveBeenCalled();
  });
});
