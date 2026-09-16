import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";

vi.mock("../src/config/db.js", () => ({ pool: { query: vi.fn() } }));

import { pool } from "../src/config/db.js";
import { createRequest } from "../src/controllers/verification.controller.js";

const UPLOAD_DIR = "./uploads/documents";
const DUMMY_FILE = `${UPLOAD_DIR}/doc_test.pdf`;

beforeAll(() => {
  mkdirSync(UPLOAD_DIR, { recursive: true });
  writeFileSync(DUMMY_FILE, "fake-doc-bytes");
});

afterAll(() => {
  rmSync(UPLOAD_DIR, { recursive: true, force: true });
});

function makeReq({ body = {}, user = {}, file = null } = {}) {
  return {
    body,
    user: { id: 1, org_role: "org_admin", ...user },
    file: file || { filename: "doc_test.pdf", mimetype: "application/pdf" },
  };
}

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

const ORG_UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createRequest — other_organization_name validation", () => {
  it("succeeds when an organization UUID is provided (other_organization_name optional)", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 10 }]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([{ insertId: 1 }])
      .mockResolvedValueOnce([[{ id: 1, issuing_organization_id: 10, other_organization_name: null, submission_remarks: null }]]);

    const req = makeReq({
      body: { document_type: "Degree", issuing_organization_uuid: ORG_UUID },
      user: { id: 1 },
    });
    const res = mockRes();

    await createRequest(req, res);
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("succeeds when no org is selected but other_organization_name is provided", async () => {
    pool.query
      .mockResolvedValueOnce([[]]) // resolveUnmatchedOrg: no existing org
      .mockResolvedValueOnce([{ insertId: 2 }]) // resolveUnmatchedOrg: insert
      .mockResolvedValueOnce([{ insertId: 2 }]) // createRequest: insert request
      .mockResolvedValueOnce([[{ id: 2, issuing_organization_id: null, other_organization_name: "Acme Corp", submission_remarks: null }]]);

    const req = makeReq({
      body: { document_type: "License", other_organization_name: "Acme Corp" },
      user: { id: 1 },
    });
    const res = mockRes();

    await createRequest(req, res);
    expect(res.status).toHaveBeenCalledWith(201);

    const insertCall = pool.query.mock.calls.find(([sql]) =>
      typeof sql === "string" && sql.includes("INSERT INTO verification_requests")
    );
    // other_organization_name is normalized into an unmatched_organizations
    // row; the request references it by id (param index 3).
    expect(insertCall[1][3]).toBe(2);
  });

  it("rejects when no org is selected and other_organization_name is missing", async () => {
    const req = makeReq({
      body: { document_type: "Degree" },
      user: { id: 1 },
    });
    const res = mockRes();

    await expect(createRequest(req, res)).rejects.toThrow(
      expect.objectContaining({
        statusCode: 400,
        message: "other_organization_name is required when no organization is selected",
      })
    );
  });

  it("rejects when other_organization_name exceeds 200 characters", async () => {
    const req = makeReq({
      body: { document_type: "Degree", other_organization_name: "A".repeat(201) },
      user: { id: 1 },
    });
    const res = mockRes();

    await expect(createRequest(req, res)).rejects.toThrow(
      expect.objectContaining({
        statusCode: 400,
        message: "other_organization_name must be 200 characters or fewer",
      })
    );
  });

  it("trims whitespace from other_organization_name before validation", async () => {
    pool.query
      .mockResolvedValueOnce([[]]) // resolveUnmatchedOrg: no existing org
      .mockResolvedValueOnce([{ insertId: 3 }]) // resolveUnmatchedOrg: insert
      .mockResolvedValueOnce([{ insertId: 3 }]) // createRequest: insert request
      .mockResolvedValueOnce([[{ id: 3, issuing_organization_id: null, other_organization_name: "Trimmed Org", submission_remarks: null }]]);

    const req = makeReq({
      body: { document_type: "Passport", other_organization_name: "  Trimmed Org  " },
      user: { id: 1 },
    });
    const res = mockRes();

    await createRequest(req, res);
    expect(res.status).toHaveBeenCalledWith(201);

    const insertCall = pool.query.mock.calls.find(([sql]) =>
      typeof sql === "string" && sql.includes("INSERT INTO verification_requests")
    );
    // Name is trimmed before the unmatched_organizations lookup (id at param index 3)
    expect(insertCall[1][3]).toBe(3);
  });
});

describe("createRequest — submission_remarks validation", () => {
  it("succeeds with submission_remarks under 500 characters", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 10 }]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([{ insertId: 4 }])
      .mockResolvedValueOnce([[{ id: 4, submission_remarks: "Some notes" }]]);

    const req = makeReq({
      body: {
        document_type: "Degree",
        issuing_organization_uuid: ORG_UUID,
        submission_remarks: "Some notes",
      },
      user: { id: 1 },
    });
    const res = mockRes();

    await createRequest(req, res);
    expect(res.status).toHaveBeenCalledWith(201);

    const insertCall = pool.query.mock.calls.find(([sql]) =>
      typeof sql === "string" && sql.includes("INSERT INTO verification_requests")
    );
    expect(insertCall[1]).toContain("Some notes");
  });

  it("rejects when submission_remarks exceeds 500 characters", async () => {
    const req = makeReq({
      body: {
        document_type: "Degree",
        other_organization_name: "Some Org",
        submission_remarks: "X".repeat(501),
      },
      user: { id: 1 },
    });
    const res = mockRes();

    await expect(createRequest(req, res)).rejects.toThrow(
      expect.objectContaining({
        statusCode: 400,
        message: "submission_remarks must be 500 characters or fewer",
      })
    );
  });

  it("saves null when submission_remarks is omitted", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 10 }]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([{ insertId: 5 }])
      .mockResolvedValueOnce([[{ id: 5, submission_remarks: null }]]);

    const req = makeReq({
      body: { document_type: "Degree", issuing_organization_uuid: ORG_UUID },
      user: { id: 1 },
    });
    const res = mockRes();

    await createRequest(req, res);
    expect(res.status).toHaveBeenCalledWith(201);

    const insertCall = pool.query.mock.calls.find(([sql]) =>
      typeof sql === "string" && sql.includes("INSERT INTO verification_requests")
    );
    const remarksValue = insertCall[1][8];
    expect(remarksValue).toBeNull();
  });
});
