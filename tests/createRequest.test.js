import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

vi.mock("../src/config/db.js", () => ({ pool: { query: vi.fn() } }));
vi.mock("../src/services/documentService.js", async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, validate: vi.fn() };
});
vi.mock("../src/utils/qrCertificate.js", () => ({
  generateQrForRequest: vi.fn().mockResolvedValue(undefined),
}));

import { pool } from "../src/config/db.js";
import { validate } from "../src/services/documentService.js";
import { createRequest } from "../src/controllers/verification.controller.js";
import { DOCS_DIR } from "../src/config/uploadPaths.js";

// Per-run unique filename so this suite only ever creates/deletes ITS OWN file
// inside the shared uploads dir and never wipes real uploaded documents.
const DOC_FILENAME = `doc_test_${process.pid}.pdf`;
const DUMMY_FILE = path.join(DOCS_DIR, DOC_FILENAME);

beforeAll(() => {
  process.env.PERSON_DATA_ENCRYPTION_KEY = "test-only-person-data-key";
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  fs.writeFileSync(DUMMY_FILE, "fake-doc-bytes");
});

afterAll(() => {
  try {
    if (fs.existsSync(DUMMY_FILE)) fs.unlinkSync(DUMMY_FILE);
  } catch {
    /* best-effort */
  }
});

function makeReq({ body = {}, user = {}, file = null } = {}) {
  return {
    body,
    user: { id: 1, org_role: "org_admin", ...user },
    file: file || { filename: DOC_FILENAME, mimetype: "application/pdf" },
  };
}

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

const ORG_UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OWNER = { document_owner_name: "Asim Khan", document_owner_cnic: "42101-1234567-1" };

const REQ_ROW = {
  id: 1,
  uuid: "cccccccc-dddd-4eee-8fff-000000000001",
  user_id: 1,
  document_type: "Degree",
  status: "under_review",
  document_path: `/uploads/documents/${DOC_FILENAME}`,
  document_format: "pdf",
  document_hash: "a".repeat(64),
  organization_conserned_for_future: "no",
  verification_method: "manual",
  verified_at: null,
  document_owner_name: OWNER.document_owner_name,
  issuing_organization_uuid: ORG_UUID,
  issuing_org_name: "Acme",
  unmatched_org_uuid: null,
  unmatched_org_name: null,
};

/**
 * SQL-router default for pool.query. Individual tests prepend
 * mockResolvedValueOnce(...) where a specific result matters (org lookup,
 * previous-verified row, etc.); everything else falls through here.
 */
function sqlRouter(sql) {
  if (typeof sql !== "string") return Promise.resolve([[]]);
  const stmt = sql.trim();
  if (stmt.includes("INSERT INTO verification_requests")) return Promise.resolve([{ insertId: 1, affectedRows: 1 }]);
  if (stmt.includes("INSERT INTO persons")) return Promise.resolve([{ insertId: 99 }]);
  if (stmt.includes("INSERT INTO unmatched_organizations")) return Promise.resolve([{ insertId: 2 }]);
  if (/^(INSERT|UPDATE|DELETE)\b/.test(stmt)) return Promise.resolve([{ affectedRows: 1 }]);
  // Final SELECT of the created request (vr.* + issuing org joins)
  if (stmt.includes("issuing_org_name")) return Promise.resolve([[REQ_ROW]]);
  return Promise.resolve([[]]);
}

beforeEach(() => {
  vi.resetAllMocks();
  validate.mockResolvedValue({ success: true, data: { valid: true } });
  pool.query.mockImplementation(sqlRouter);
});

describe("createRequest — other_organization_name validation", () => {
  it("succeeds when an organization UUID is provided (other_organization_name optional)", async () => {
    pool.query.mockResolvedValueOnce([[{ id: 10 }]]);

    const req = makeReq({
      body: { document_type: "Degree", issuing_organization_uuid: ORG_UUID, ...OWNER },
      user: { id: 1 },
    });
    const res = mockRes();

    await createRequest(req, res);
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("succeeds when no org is selected but other_organization_name is provided", async () => {
    const req = makeReq({
      body: { document_type: "License", other_organization_name: "Acme Corp", ...OWNER },
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
      body: { document_type: "Degree", ...OWNER },
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
      body: { document_type: "Degree", other_organization_name: "A".repeat(201), ...OWNER },
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
    const req = makeReq({
      body: { document_type: "Passport", other_organization_name: "  Trimmed Org  ", ...OWNER },
      user: { id: 1 },
    });
    const res = mockRes();

    await createRequest(req, res);
    expect(res.status).toHaveBeenCalledWith(201);

    const insertCall = pool.query.mock.calls.find(([sql]) =>
      typeof sql === "string" && sql.includes("INSERT INTO verification_requests")
    );
    // Name is trimmed before the unmatched_organizations lookup (id at param index 3)
    expect(insertCall[1][3]).toBe(2);
  });
});

describe("createRequest — submission_remarks validation", () => {
  it("succeeds with submission_remarks under 500 characters", async () => {
    pool.query.mockResolvedValueOnce([[{ id: 10 }]]);

    const req = makeReq({
      body: {
        document_type: "Degree",
        issuing_organization_uuid: ORG_UUID,
        submission_remarks: "Some notes",
        ...OWNER,
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
        ...OWNER,
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
    pool.query.mockResolvedValueOnce([[{ id: 10 }]]);

    const req = makeReq({
      body: { document_type: "Degree", issuing_organization_uuid: ORG_UUID, ...OWNER },
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

describe("createRequest — required document owner fields", () => {
  it("rejects with 400 when document_owner_name is missing", async () => {
    const req = makeReq({
      body: { document_type: "Degree", document_owner_cnic: "42101-1234567-1" },
      user: { id: 1 },
    });
    const res = mockRes();

    await expect(createRequest(req, res)).rejects.toMatchObject({
      statusCode: 400,
      message: "document_owner_name is required",
    });
  });

  it("rejects with 400 when document_owner_cnic is missing", async () => {
    const req = makeReq({
      body: { document_type: "Degree", document_owner_name: "Asim Khan" },
      user: { id: 1 },
    });
    const res = mockRes();

    await expect(createRequest(req, res)).rejects.toMatchObject({
      statusCode: 400,
      message: "document_owner_cnic is required",
    });
  });

  it("rejects with 400 when document_owner_cnic is not 13 digits", async () => {
    const req = makeReq({
      body: { document_type: "Degree", document_owner_name: "Asim Khan", document_owner_cnic: "12345" },
      user: { id: 1 },
    });
    const res = mockRes();

    await expect(createRequest(req, res)).rejects.toMatchObject({
      statusCode: 400,
      message: "document_owner_cnic must be a valid CNIC (XXXXX-XXXXXXX-X)",
    });
  });
});

describe("createRequest — exact-hash auto-verification (existing fast path unchanged)", () => {
  it("auto-verifies when the same SHA-256 hash was already verified by the issuing org", async () => {
    // 1st query resolves the org UUID; 2nd query returns a previously-verified
    // row with the matching document_hash -> autoVerify=true, no OCR involved.
    pool.query
      .mockResolvedValueOnce([[{ id: 10 }]])
      .mockResolvedValueOnce([[{ id: 5 }]]);

    const req = makeReq({
      body: { document_type: "Degree", issuing_organization_uuid: ORG_UUID, ...OWNER },
      user: { id: 1 },
    });
    const res = mockRes();

    await createRequest(req, res);
    expect(res.status).toHaveBeenCalledWith(201);

    const insertCall = pool.query.mock.calls.find(([sql]) =>
      typeof sql === "string" && sql.includes("INSERT INTO verification_requests")
    );
    expect(insertCall[1][4]).toBe("verified"); // status
    expect(insertCall[1][9]).toBe("auto"); // verification_method
    expect(insertCall[1][10]).toEqual(expect.any(Date)); // verified_at populated
  });

  it("stays under_review when the hash was never verified before (no auto-verify)", async () => {
    pool.query.mockResolvedValueOnce([[{ id: 10 }]]); // org lookup; previous-verified check returns nothing

    const req = makeReq({
      body: { document_type: "Degree", issuing_organization_uuid: ORG_UUID, ...OWNER },
      user: { id: 1 },
    });
    const res = mockRes();

    await createRequest(req, res);
    expect(res.status).toHaveBeenCalledWith(201);

    const insertCall = pool.query.mock.calls.find(([sql]) =>
      typeof sql === "string" && sql.includes("INSERT INTO verification_requests")
    );
    expect(insertCall[1][4]).toBe("under_review");
    expect(insertCall[1][9]).toBe("manual");
    expect(insertCall[1][10]).toBeNull();
  });
});