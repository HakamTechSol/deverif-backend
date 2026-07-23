import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "crypto";

vi.mock("../src/config/db.js", () => ({
  pool: { query: vi.fn(), getConnection: vi.fn() },
}));
vi.mock("../src/utils/mailer.js", () => ({
  sendPasswordResetEmail: vi.fn().mockResolvedValue(undefined),
}));

import { pool } from "../src/config/db.js";
import { sendPasswordResetEmail } from "../src/utils/mailer.js";
import {
  validatePasswordPolicy,
  HASH_ROUNDS,
  hashPassword,
  comparePassword,
} from "../src/utils/password.js";
import {
  forgotPassword,
  resetPassword,
} from "../src/controllers/auth.user.controller.js";

function mockReq({ body = {} } = {}) {
  return { body };
}
function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("validatePasswordPolicy", () => {
  it("accepts a strong password", () => {
    expect(() => validatePasswordPolicy("Abcdef1!")).not.toThrow();
  });

  it("rejects password shorter than 8 characters", () => {
    expect(() => validatePasswordPolicy("Abc1!")).toThrow(
      expect.objectContaining({ statusCode: 400 })
    );
  });

  it("rejects password without uppercase", () => {
    expect(() => validatePasswordPolicy("abcdef1!")).toThrow(
      expect.objectContaining({ statusCode: 400 })
    );
  });

  it("rejects password without lowercase", () => {
    expect(() => validatePasswordPolicy("ABCDEF1!")).toThrow(
      expect.objectContaining({ statusCode: 400 })
    );
  });

  it("rejects password without number", () => {
    expect(() => validatePasswordPolicy("Abcdefg!")).toThrow(
      expect.objectContaining({ statusCode: 400 })
    );
  });

  it("rejects password without special character", () => {
    expect(() => validatePasswordPolicy("Abcdefg1")).toThrow(
      expect.objectContaining({ statusCode: 400 })
    );
  });

  it("rejects non-string input", () => {
    expect(() => validatePasswordPolicy(null)).toThrow(
      expect.objectContaining({ statusCode: 400 })
    );
  });
});

describe("bcrypt hash rounds", () => {
  it("hashes with 12 salt rounds", async () => {
    const hashed = await hashPassword("Testpass1!");
    // bcrypt format: $2b$<rounds>$<salt+hash>
    const rounds = parseInt(hashed.split("$")[2], 10);
    expect(rounds).toBe(HASH_ROUNDS);
    expect(rounds).toBeGreaterThanOrEqual(12);
  }, 15000);

  it("verify works with the shared helper", async () => {
    const hashed = await hashPassword("Testpass1!");
    expect(await comparePassword("Testpass1!", hashed)).toBe(true);
    expect(await comparePassword("wrong", hashed)).toBe(false);
  }, 15000);
});

describe("forgotPassword", () => {
  const USER_UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

  it("returns generic success even if user does not exist (no enumeration)", async () => {
    pool.query.mockResolvedValueOnce([[]]);

    const req = mockReq({ body: { email: "noone@test.com" } });
    const res = mockRes();
    await forgotPassword(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("generates a token and sends email for valid active user", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 1, uuid: USER_UUID, email: "a@test.com", status: "active" }]])
      .mockResolvedValueOnce([])  // invalidate old tokens
      .mockResolvedValueOnce([]); // insert new token

    const req = mockReq({ body: { email: "a@test.com" } });
    const res = mockRes();
    await forgotPassword(req, res);

    expect(sendPasswordResetEmail).toHaveBeenCalledTimes(1);
    const { resetLink } = sendPasswordResetEmail.mock.calls[0][0];
    expect(resetLink).toContain("token=");

    const insertCall = pool.query.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO password_reset_tokens")
    );
    expect(insertCall).toBeDefined();
    expect(insertCall[1][0]).toBe(USER_UUID);
  });

  it("invalidates previous tokens before creating new one", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 1, uuid: USER_UUID, email: "a@test.com", status: "active" }]])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const req = mockReq({ body: { email: "a@test.com" } });
    const res = mockRes();
    await forgotPassword(req, res);

    const invalidateCall = pool.query.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("UPDATE password_reset_tokens SET used_at")
    );
    expect(invalidateCall).toBeDefined();
    expect(invalidateCall[1][0]).toBe(USER_UUID);
  });
});

describe("resetPassword", () => {
  const USER_UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const RAW_TOKEN = "a".repeat(64);

  function mockValidTokenRow(overrides = {}) {
    return {
      id: 1,
      user_uuid: USER_UUID,
      expires_at: new Date(Date.now() + 600_000).toISOString(),
      used_at: null,
      ...overrides,
    };
  }

  it("rejects token and newPassword being missing", async () => {
    const req = mockReq({ body: {} });
    const res = mockRes();
    await expect(resetPassword(req, res)).rejects.toThrow(
      expect.objectContaining({ statusCode: 400 })
    );
  });

  it("rejects weak password", async () => {
    const req = mockReq({ body: { token: RAW_TOKEN, newPassword: "weak" } });
    const res = mockRes();
    await expect(resetPassword(req, res)).rejects.toThrow(
      expect.objectContaining({ statusCode: 400 })
    );
  });

  it("rejects token that does not exist in DB", async () => {
    pool.query.mockResolvedValueOnce([[]]);
    const req = mockReq({ body: { token: RAW_TOKEN, newPassword: "Abcdef1!" } });
    const res = mockRes();
    await expect(resetPassword(req, res)).rejects.toThrow(
      expect.objectContaining({ statusCode: 400 })
    );
  });

  it("rejects already-used token", async () => {
    pool.query.mockResolvedValueOnce([
      [mockValidTokenRow({ used_at: new Date().toISOString() })],
    ]);
    const req = mockReq({ body: { token: RAW_TOKEN, newPassword: "Abcdef1!" } });
    const res = mockRes();
    await expect(resetPassword(req, res)).rejects.toThrow(
      expect.objectContaining({ statusCode: 400 })
    );
  });

  it("rejects expired token", async () => {
    pool.query.mockResolvedValueOnce([
      [mockValidTokenRow({ expires_at: new Date(Date.now() - 1000).toISOString() })],
    ]);
    const req = mockReq({ body: { token: RAW_TOKEN, newPassword: "Abcdef1!" } });
    const res = mockRes();
    await expect(resetPassword(req, res)).rejects.toThrow(
      expect.objectContaining({ statusCode: 400 })
    );
  });

  it("resets password and invalidates all tokens on valid request", async () => {
    const conn = {
      query: vi.fn().mockResolvedValue([]),
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
    };
    pool.getConnection.mockResolvedValue(conn);
    pool.query
      .mockResolvedValueOnce([[mockValidTokenRow()]])
      .mockResolvedValueOnce([[{ id: 10, uuid: USER_UUID, status: "active" }]]);

    const req = mockReq({ body: { token: RAW_TOKEN, newPassword: "Abcdef1!" } });
    const res = mockRes();
    await resetPassword(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(conn.query).toHaveBeenCalledWith(
      "UPDATE users SET password=? WHERE id=?",
      [expect.any(String), 10]
    );
    expect(conn.query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE password_reset_tokens SET used_at"),
      [USER_UUID]
    );
    expect(conn.commit).toHaveBeenCalled();
  });
});
