import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/config/db.js", () => ({ pool: { query: vi.fn() } }));
vi.mock("../src/utils/mailer.js", () => ({
  sendPasswordResetEmail: vi.fn().mockResolvedValue({}),
}));

import { pool } from "../src/config/db.js";
import { sendPasswordResetEmail } from "../src/utils/mailer.js";
import { forgotPassword } from "../src/controllers/auth.user.controller.js";

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

const USER = {
  id: 3,
  uuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  email: "known@example.com",
  status: "active",
  preferred_language: "en",
};

beforeEach(() => vi.clearAllMocks());

describe("forgotPassword — truthfully tells the user when the email does not exist", () => {
  it("returns 404 'not registered' for an unknown email and does NOT send mail", async () => {
    pool.query.mockResolvedValueOnce([[]]);
    const res = mockRes();
    await expect(
      forgotPassword({ body: { email: "nobody@example.com" } }, res)
    ).rejects.toMatchObject({
      statusCode: 404,
      message: "This email is not registered in this system",
    });
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it("sends the reset email for an active, known account", async () => {
    pool.query
      .mockResolvedValueOnce([[USER]]) // user lookup
      .mockResolvedValueOnce([{}]) // UPDATE password_reset_tokens
      .mockResolvedValueOnce([{ insertId: 1 }]); // INSERT password_reset_tokens
    const res = mockRes();
    await forgotPassword({ body: { email: "known@example.com" } }, res);
    expect(sendPasswordResetEmail).toHaveBeenCalledTimes(1);
    expect(res.json.mock.calls[0][0].message).toBe("Password reset email sent");
  });

  it("rejects an inactive account with a clear message", async () => {
    pool.query.mockResolvedValueOnce([[{ ...USER, status: "inactive" }]]);
    const res = mockRes();
    await expect(
      forgotPassword({ body: { email: "known@example.com" } }, res)
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
  });
});