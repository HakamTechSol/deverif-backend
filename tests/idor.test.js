import { describe, it, expect, vi, beforeEach } from "vitest";
import jwt from "jsonwebtoken";

const JWT_SECRET = "test-idor-secret-at-least-32-characters-long!!";

vi.mock("../src/config/db.js", () => ({ pool: { query: vi.fn() } }));

import { pool } from "../src/config/db.js";
import { deleteMySentRequest } from "../src/controllers/verification.controller.js";
import { verifyRequest } from "../src/controllers/verification.controller.js";

const USER_A_ID = 1;
const USER_A_UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ORG_A_ID = 10;

const USER_B_ID = 2;
const USER_B_UUID = "11111111-2222-4444-8888-333333333333";
const ORG_B_ID = 20;

const REQUEST_UUID = "ffffffff-aaaa-4bbb-8ccc-dddddddddddd";
const NONEXISTENT_UUID = "00000000-0000-4000-8000-000000000000";

function mockReq({ params = {}, body = {}, user = {} } = {}) {
  return { params, body, user: { org_role: "org_admin", ...user } };
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

describe("IDOR Protection — deleteMySentRequest", () => {
  it("returns 403 when User A tries to delete User B's request", async () => {
    pool.query.mockResolvedValueOnce([[{
      id: 100, status: "under_review", user_id: USER_B_ID,
    }]]);

    const req = mockReq({ params: { uuid: REQUEST_UUID }, user: { id: USER_A_ID } });
    const res = mockRes();

    await expect(deleteMySentRequest(req, res)).rejects.toThrow(
      expect.objectContaining({ statusCode: 403 })
    );
  });

  it("returns 404 when the UUID does not exist at all", async () => {
    pool.query.mockResolvedValueOnce([[]]);

    const req = mockReq({ params: { uuid: NONEXISTENT_UUID }, user: { id: USER_A_ID } });
    const res = mockRes();

    await expect(deleteMySentRequest(req, res)).rejects.toThrow(
      expect.objectContaining({ statusCode: 404 })
    );
  });

  it("returns 200 when User A deletes their own request", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 100, status: "under_review", user_id: USER_A_ID }]])
      .mockResolvedValueOnce([]);

    const req = mockReq({ params: { uuid: REQUEST_UUID }, user: { id: USER_A_ID } });
    const res = mockRes();

    await deleteMySentRequest(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("returns 403 when a verified request cannot be deleted", async () => {
    pool.query.mockResolvedValueOnce([[{
      id: 100, status: "verified", user_id: USER_A_ID,
    }]]);

    const req = mockReq({ params: { uuid: REQUEST_UUID }, user: { id: USER_A_ID } });
    const res = mockRes();

    await expect(deleteMySentRequest(req, res)).rejects.toThrow(
      expect.objectContaining({ statusCode: 403 })
    );
  });

  it("returns 409 when request is already finalized (unverified)", async () => {
    pool.query.mockResolvedValueOnce([[{
      id: 100, status: "unverified", user_id: USER_A_ID,
    }]]);

    const req = mockReq({ params: { uuid: REQUEST_UUID }, user: { id: USER_A_ID } });
    const res = mockRes();

    await expect(deleteMySentRequest(req, res)).rejects.toThrow(
      expect.objectContaining({ statusCode: 409 })
    );
  });

  it("rejects invalid UUID format", async () => {
    const req = mockReq({ params: { uuid: "not-a-uuid" }, user: { id: USER_A_ID } });
    const res = mockRes();

    await expect(deleteMySentRequest(req, res)).rejects.toThrow(
      expect.objectContaining({ statusCode: 400 })
    );
  });
});

describe("IDOR Protection — verifyRequest", () => {
  // verifyRequest calls assertOrganizationActive(orgId) first — every test
  // that reaches the request lookup needs this mock queued before others.
  const ORG_ACTIVE = [[{ subscription_status: "active", subscription_expiry: null }]];

  it("returns 403 when User A (org A) tries to verify a request addressed to org B", async () => {
    pool.query
      .mockResolvedValueOnce(ORG_ACTIVE)
      .mockResolvedValueOnce([[{
        id: 100, uuid: REQUEST_UUID, status: "under_review",
        issuing_organization_id: ORG_B_ID, user_id: USER_B_ID,
      }]]);

    const req = mockReq({
      params: { uuid: REQUEST_UUID },
      body: { status: "verified", verification_remarks: "Looks good" },
      user: { id: USER_A_ID, organization: ORG_A_ID },
    });
    const res = mockRes();

    await expect(verifyRequest(req, res)).rejects.toThrow(
      expect.objectContaining({ statusCode: 403 })
    );
  });

  it("returns 404 when the request UUID does not exist", async () => {
    pool.query
      .mockResolvedValueOnce(ORG_ACTIVE)
      .mockResolvedValueOnce([[]]);

    const req = mockReq({
      params: { uuid: NONEXISTENT_UUID },
      body: { status: "verified" },
      user: { id: USER_A_ID, organization: ORG_A_ID },
    });
    const res = mockRes();

    await expect(verifyRequest(req, res)).rejects.toThrow(
      expect.objectContaining({ statusCode: 404 })
    );
  });

  it("returns 200 when a user from the issuing org verifies the request", async () => {
    pool.query
      .mockResolvedValueOnce(ORG_ACTIVE) // assertOrganizationActive
      .mockResolvedValueOnce([[{
        id: 100, uuid: REQUEST_UUID, status: "under_review",
        issuing_organization_id: ORG_B_ID, user_id: USER_B_ID,
      }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE verification_requests
      .mockResolvedValueOnce([[{
        id: 100, uuid: REQUEST_UUID, status: "verified",
        issuing_organization_id: ORG_B_ID, user_id: USER_B_ID,
      }]]) // SELECT updated request
      // QR generation is skipped (no QR_SIGNING_SECRET in test env)
      .mockResolvedValueOnce([[{ uuid: USER_B_UUID, organization: ORG_B_ID }]]) // requester lookup
      .mockResolvedValueOnce([[{ name: "Org B" }]]); // sender org name

    const req = mockReq({
      params: { uuid: REQUEST_UUID },
      body: { status: "verified", verification_remarks: "Authentic" },
      user: { id: USER_B_ID, organization: ORG_B_ID },
    });
    const res = mockRes();

    await verifyRequest(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("returns 400 when user has no organization", async () => {
    const req = mockReq({
      params: { uuid: REQUEST_UUID },
      body: { status: "verified" },
      user: { id: USER_A_ID, organization: null },
    });
    const res = mockRes();

    await expect(verifyRequest(req, res)).rejects.toThrow(
      expect.objectContaining({ statusCode: 400 })
    );
  });

  it("returns 409 when request is already finalized", async () => {
    pool.query
      .mockResolvedValueOnce(ORG_ACTIVE)
      .mockResolvedValueOnce([[{
        id: 100, uuid: REQUEST_UUID, status: "verified",
        issuing_organization_id: ORG_A_ID, user_id: USER_A_ID,
      }]]);

    const req = mockReq({
      params: { uuid: REQUEST_UUID },
      body: { status: "verified" },
      user: { id: USER_A_ID, organization: ORG_A_ID },
    });
    const res = mockRes();

    await expect(verifyRequest(req, res)).rejects.toThrow(
      expect.objectContaining({ statusCode: 409 })
    );
  });
});
