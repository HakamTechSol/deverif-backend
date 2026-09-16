import { describe, it, expect, vi, beforeEach } from "vitest";
import jwt from "jsonwebtoken";

const JWT_SECRET = "test-role-security-secret-at-least-32-chars!!";
process.env.JWT_SECRET = JWT_SECRET;

vi.mock("../src/config/db.js", () => ({ pool: { query: vi.fn() } }));
vi.mock("../src/utils/tokenBlacklist.js", () => ({ isBlacklisted: vi.fn().mockResolvedValue(false) }));

import authAdminEnv from "../src/middleware/authAdminEnv.js";
import authUser from "../src/middleware/authUser.js";
import authAny from "../src/middleware/authAny.js";
import { pool } from "../src/config/db.js";

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: "30m",
    issuer: "dverif-api",
    audience: "dverif-client",
    algorithm: "HS256",
  });
}

function mockReq({ headers = {} } = {}) {
  return { headers };
}
function mockRes() {
  return {};
}
function nextFn() {
  nextFn.called = true;
}
nextFn.called = false;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.JWT_SECRET = JWT_SECRET;
  nextFn.called = false;
});

describe("Role security — middleware reads role from JWT, not from request", () => {
  describe("authAdminEnv rejects user tokens", () => {
    it("returns 401 when a user token hits admin-only middleware", async () => {
      const token = signToken({ type: "user", userId: "user-uuid", role: "user" });
      const req = mockReq({ headers: { authorization: `Bearer ${token}` } });
      const next = vi.fn();

      await authAdminEnv(req, mockRes(), next);

      expect(next).toHaveBeenCalledTimes(1);
      const err = next.mock.calls[0][0];
      expect(err).toBeDefined();
      expect(err.statusCode).toBe(401);
    });

    it("returns 401 when token has role='admin' in body but role='user' in JWT", async () => {
      const token = signToken({ type: "user", userId: "user-uuid", role: "user" });
      const req = mockReq({ headers: { authorization: `Bearer ${token}` } });
      req.body = { role: "admin" };
      const next = vi.fn();

      await authAdminEnv(req, mockRes(), next);

      expect(next).toHaveBeenCalledTimes(1);
      const err = next.mock.calls[0][0];
      expect(err).toBeDefined();
      expect(err.statusCode).toBe(401);
    });
  });

  describe("authUser rejects admin tokens", () => {
    it("returns 401 when an admin token hits user-only middleware", async () => {
      const token = signToken({ type: "admin", userId: "admin@test.com", role: "admin", email: "admin@test.com" });
      const req = mockReq({ headers: { authorization: `Bearer ${token}` } });
      const next = vi.fn();

      pool.query.mockResolvedValueOnce([[]]);

      await authUser(req, mockRes(), next);

      expect(next).toHaveBeenCalledTimes(1);
      const err = next.mock.calls[0][0];
      expect(err).toBeDefined();
      expect(err.statusCode).toBe(401);
    });
  });

  describe("authAny routes user token away from admin path", () => {
    it("returns req.user (not req.admin) for a user token", async () => {
      process.env.JWT_SECRET = JWT_SECRET;
      const token = signToken({ type: "user", userId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", role: "user" });
      const req = mockReq({ headers: { authorization: `Bearer ${token}` } });
      const next = vi.fn();

      pool.query
        .mockReset()
        .mockResolvedValueOnce([[{
          id: 1, uuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
          status: "active",
        }]]);

      await authAny(req, mockRes(), next);

      expect(next).toHaveBeenCalledWith();
      expect(req.user).toBeDefined();
      expect(req.admin).toBeUndefined();
    });

    it("returns req.admin for an admin token", async () => {
      const token = signToken({ type: "admin", userId: "admin-uuid-123", role: "admin", email: "admin@test.com" });
      const req = mockReq({ headers: { authorization: `Bearer ${token}` } });
      const next = vi.fn();

      pool.query.mockReset().mockResolvedValueOnce([[{
        id: 1, uuid: "admin-uuid-123", email: "admin@test.com", full_name: "Test Admin", status: "active",
      }]]);

      await authAny(req, mockRes(), next);

      expect(next).toHaveBeenCalledWith();
      expect(req.admin).toBeDefined();
      expect(req.admin.email).toBe("admin@test.com");
      expect(req.user).toBeUndefined();
    });
  });

  describe("JWT signature prevents forgery", () => {
    it("rejects token signed with wrong secret", async () => {
      const token = jwt.sign(
        { type: "admin", userId: "attacker@test.com", role: "admin", email: "attacker@test.com" },
        "wrong-secret-12345678901234567890",
        { expiresIn: "30m", issuer: "dverif-api", audience: "dverif-client", algorithm: "HS256" }
      );
      const req = mockReq({ headers: { authorization: `Bearer ${token}` } });
      const next = vi.fn();

      await authAdminEnv(req, mockRes(), next);

      expect(next).toHaveBeenCalledTimes(1);
      const err = next.mock.calls[0][0];
      expect(err).toBeDefined();
      expect(err.statusCode).toBe(401);
    });

    it("rejects token with tampered payload (role changed from user to admin)", async () => {
      const userToken = signToken({ type: "user", userId: "user-uuid", role: "user" });
      const parts = userToken.split(".");

      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
      payload.role = "admin";
      payload.type = "admin";
      parts[1] = Buffer.from(JSON.stringify(payload)).toString("base64url");

      const tamperedToken = parts.join(".");
      const req = mockReq({ headers: { authorization: `Bearer ${tamperedToken}` } });
      const next = vi.fn();

      await authAdminEnv(req, mockRes(), next);

      expect(next).toHaveBeenCalledTimes(1);
      const err = next.mock.calls[0][0];
      expect(err).toBeDefined();
      expect(err.statusCode).toBe(401);
    });
  });
});
