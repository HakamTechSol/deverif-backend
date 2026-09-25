import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/config/db.js", () => ({ pool: { query: vi.fn() } }));

import { pool } from "../src/config/db.js";
import { validateInviteToken, setPassword } from "../src/controllers/auth.user.controller.js";

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

const future = () => new Date(Date.now() + 60 * 60 * 1000);
const past = () => new Date(Date.now() - 60 * 1000);

beforeEach(() => vi.clearAllMocks());

describe("validateInviteToken — pre-checks an invite link before showing the form", () => {
  it("returns valid:true for an unused, unexpired token", async () => {
    pool.query.mockResolvedValueOnce([[{ used_at: null, expires_at: future() }]]);
    const res = mockRes();
    await validateInviteToken({ query: { token: "abc" } }, res);
    expect(res.json.mock.calls[0][0].data).toEqual({ valid: true });
  });

  it("returns not_found when the row was deleted (cancelled invite)", async () => {
    pool.query.mockResolvedValueOnce([[]]);
    const res = mockRes();
    await validateInviteToken({ query: { token: "abc" } }, res);
    expect(res.json.mock.calls[0][0].data).toEqual({ valid: false, reason: "not_found" });
  });

  it("returns used when used_at is set", async () => {
    pool.query.mockResolvedValueOnce([[{ used_at: new Date(), expires_at: future() }]]);
    const res = mockRes();
    await validateInviteToken({ query: { token: "abc" } }, res);
    expect(res.json.mock.calls[0][0].data).toEqual({ valid: false, reason: "used" });
  });

  it("returns expired when expires_at is in the past", async () => {
    pool.query.mockResolvedValueOnce([[{ used_at: null, expires_at: past() }]]);
    const res = mockRes();
    await validateInviteToken({ query: { token: "abc" } }, res);
    expect(res.json.mock.calls[0][0].data).toEqual({ valid: false, reason: "expired" });
  });

  it("throws 400 when no token is supplied", async () => {
    const res = mockRes();
    await expect(validateInviteToken({ query: {} }, res)).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});

describe("setPassword — cancelled invite cannot be used", () => {
  it("throws 400 when the token is no longer present in invite_tokens", async () => {
    pool.query.mockResolvedValueOnce([[]]);
    const res = mockRes();
    await expect(
      setPassword({ body: { token: "deadbeef", newPassword: "Abcd1234!" } }, res)
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
