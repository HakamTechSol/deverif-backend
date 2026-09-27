import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

vi.mock("../src/config/db.js", () => ({ pool: { query: vi.fn() } }));
vi.mock("../src/services/documentService.js", async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, validate: vi.fn(), ocrExtract: vi.fn() };
});

import { pool } from "../src/config/db.js";
import { validate, ocrExtract, DocumentServiceError } from "../src/services/documentService.js";
import { uploadEmployeeDocuments } from "../src/controllers/org/employeeMeta.controller.js";
import { DOCS_DIR } from "../src/config/uploadPaths.js";

const EMP_UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const TEMP_FILES = [];

beforeAll(() => {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
});

afterAll(() => {
  for (const file of TEMP_FILES) {
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {
      /* cleanup best-effort */
    }
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  // Document service is "up" and happy by default; individual tests override.
  validate.mockResolvedValue({ success: true, data: { valid: true } });
  ocrExtract.mockResolvedValue({
    success: true,
    data: {
      document_type: "education_certificate",
      fields: { name: { value: "Asim Khan", confidence: "high" } },
    },
  });
});

function writeTempFile(name, bytes) {
  const filePath = path.join(DOCS_DIR, name);
  fs.writeFileSync(filePath, bytes);
  TEMP_FILES.push(filePath);
  return filePath;
}

function makeReq({ files = [], ...overrides } = {}) {
  return {
    params: { uuid: EMP_UUID },
    scopeOrgId: 5,
    body: { document_type: "Degree" },
    user: { id: 1, uuid: "actor-uuid", org_role: "org_admin", full_name: "Admin" },
    admin: null,
    ip: "127.0.0.1",
    headers: {},
    connection: { remoteAddress: "127.0.0.1" },
    ...overrides,
    files,
  };
}

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

describe("uploadEmployeeDocuments — corrupt-file guard (document service up/down)", () => {
  it("rejects a definitively corrupt upload with 400 and does not insert", async () => {
    validate.mockResolvedValue({
      success: true,
      data: { valid: false, check_type: "structural", reason: "Corrupt PDF" },
    });
    pool.query.mockResolvedValue([[{ uuid: EMP_UUID }]]);

    const req = makeReq({
      files: [{ filename: "corrupt.pdf", originalname: "corrupt.pdf", mimetype: "application/pdf", size: 12 }],
    });
    const res = mockRes();

    await expect(uploadEmployeeDocuments(req, res)).rejects.toMatchObject({
      statusCode: 400,
      // The service's own reason is surfaced rather than a generic string, so the
      // uploader learns WHY the file was rejected.
      message: "Corrupt PDF",
    });

    const insertCall = pool.query.mock.calls.find(([sql]) =>
      typeof sql === "string" && sql.includes("INSERT INTO employee_documents")
    );
    expect(insertCall).toBeUndefined();
  });

  it("treats a heuristic quality flag as fatal here, unlike a request submission", async () => {
    // Reference documents are the yardstick the 100% auto-verification match
    // compares submissions against. A reference scan missing part of its own
    // content would corrupt every later match, so the flag-rather-than-block
    // default used for requests must NOT apply on this path.
    validate.mockResolvedValue({
      success: true,
      data: {
        valid: false,
        check_type: "heuristic",
        cropped: true,
        reason: "Content runs off the left edge of the scan — the document looks cropped",
      },
    });
    pool.query.mockResolvedValue([[{ uuid: EMP_UUID }]]);

    const req = makeReq({
      files: [{ filename: "cropped.pdf", originalname: "cropped.pdf", mimetype: "application/pdf", size: 12 }],
    });
    const res = mockRes();

    await expect(uploadEmployeeDocuments(req, res)).rejects.toMatchObject({ statusCode: 400 });

    const insertCall = pool.query.mock.calls.find(([sql]) =>
      typeof sql === "string" && sql.includes("INSERT INTO employee_documents")
    );
    expect(insertCall).toBeUndefined();
  });

  it("hard-blocks a MIME-spoofed reference document", async () => {
    validate.mockResolvedValue({
      success: true,
      data: {
        valid: false,
        check_type: "structural",
        file_type: "text",
        reason: "File type mismatch: declared content type 'application/pdf' but content is TEXT",
      },
    });
    pool.query.mockResolvedValue([[{ uuid: EMP_UUID }]]);

    const req = makeReq({
      files: [{ filename: "spoof.pdf", originalname: "spoof.pdf", mimetype: "application/pdf", size: 12 }],
    });
    const res = mockRes();

    await expect(uploadEmployeeDocuments(req, res)).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("mismatch"),
    });

    const insertCall = pool.query.mock.calls.find(([sql]) =>
      typeof sql === "string" && sql.includes("INSERT INTO employee_documents")
    );
    expect(insertCall).toBeUndefined();
  });

  it("fails open (proceeds with the upload) when the document service is unreachable", async () => {
    // The client reports unreachability as kind "connection" (refused/unreachable)
    // or "timeout" — those are the ONLY kinds allowed to fail open.
    validate.mockRejectedValue(
      new DocumentServiceError(502, "Document service unreachable at http://localhost:5001/validate", { kind: "connection" })
    );

    pool.query
      .mockResolvedValueOnce([[{ uuid: EMP_UUID }]])
      .mockResolvedValueOnce([{ insertId: 1 }])
      .mockResolvedValueOnce([[{ uuid: "doc-uuid", employee_uuid: EMP_UUID, document_type: "Degree", file_name: "x.pdf", file_path: "documents/x.pdf", file_size: 9 }]]);

    const req = makeReq({
      files: [{ filename: "ok.pdf", originalname: "x.pdf", mimetype: "application/pdf", size: 9 }],
    });
    const res = mockRes();

    await uploadEmployeeDocuments(req, res);
    expect(res.status).toHaveBeenCalledWith(201);

    const insertCall = pool.query.mock.calls.find(([sql]) =>
      typeof sql === "string" && sql.includes("INSERT INTO employee_documents")
    );
    expect(insertCall).toBeTruthy();
  });

  it("fails closed (rejects the upload) when the service responds with an HTTP error", async () => {
    // Service is UP but answered 422 (e.g. "cannot parse file") — an unvalidated
    // file must NOT slip through just because it happens to be reachable.
    validate.mockRejectedValue(
      new DocumentServiceError(422, "Document service could not parse the file", { kind: "http" })
    );
    pool.query.mockResolvedValue([[{ uuid: EMP_UUID }]]);

    const req = makeReq({
      files: [{ filename: "weird.pdf", originalname: "weird.pdf", mimetype: "application/pdf", size: 5 }],
    });
    const res = mockRes();

    await expect(uploadEmployeeDocuments(req, res)).rejects.toMatchObject({
      statusCode: 400,
      message: "Document could not be validated — please try again.",
    });

    const insertCall = pool.query.mock.calls.find(([sql]) =>
      typeof sql === "string" && sql.includes("INSERT INTO employee_documents")
    );
    expect(insertCall).toBeUndefined();
  });

  it("fails closed (rejects the upload) when the service returns an unexpected payload", async () => {
    // 2xx but the {success,data} envelope was malformed — also NOT unreachability.
    validate.mockRejectedValue(
      new DocumentServiceError(502, "Document service returned an unexpected payload", { kind: "generic" })
    );
    pool.query.mockResolvedValue([[{ uuid: EMP_UUID }]]);

    const req = makeReq({
      files: [{ filename: "broken.pdf", originalname: "broken.pdf", mimetype: "application/pdf", size: 6 }],
    });
    const res = mockRes();

    await expect(uploadEmployeeDocuments(req, res)).rejects.toMatchObject({
      statusCode: 400,
      message: "Document could not be validated — please try again.",
    });

    const insertCall = pool.query.mock.calls.find(([sql]) =>
      typeof sql === "string" && sql.includes("INSERT INTO employee_documents")
    );
    expect(insertCall).toBeUndefined();
  });
});

describe("uploadEmployeeDocuments — document_hash storage", () => {
  it("stores the SHA-256 hash for a PDF upload (auto-verification fast path needs it)", async () => {
    const bytes = Buffer.from("%PDF-1.7\nfake pdf body for hashing");
    writeTempFile("hash_me.pdf", bytes);
    const expected = crypto.createHash("sha256").update(bytes).digest("hex");

    pool.query
      .mockResolvedValueOnce([[{ uuid: EMP_UUID }]])
      .mockResolvedValueOnce([{ insertId: 1 }])
      .mockResolvedValueOnce([[{ uuid: "doc-uuid", employee_uuid: EMP_UUID, document_type: "Degree", file_name: "hash_me.pdf", file_path: "documents/hash_me.pdf", file_size: bytes.length }]]);

    const req = makeReq({
      files: [{ filename: "hash_me.pdf", originalname: "hash_me.pdf", mimetype: "application/pdf", size: bytes.length }],
    });
    const res = mockRes();

    await uploadEmployeeDocuments(req, res);

    const insertCall = pool.query.mock.calls.find(([sql]) =>
      typeof sql === "string" && sql.includes("INSERT INTO employee_documents")
    );
    expect(insertCall[1][6]).toBe(expected);
    expect(insertCall[1][6]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("stores a SHA-256 hash for a DOCX too, exactly as a request upload does", async () => {
    // Regression: the hash used to be computed for PDF/image uploads only, so a
    // DOCX reference permanently carried a NULL document_hash. Nothing matched
    // on it (correct — a DOCX and a PDF of the same document can never be
    // byte-identical), but the NULL also erased the difference between "this
    // reference was never fingerprinted" and "fingerprinted and differs". A
    // verification-request upload hashes every file, and so does this one now.
    const bytes = Buffer.from("PK\x03\x04 not a real docx, but hashed like any upload");
    writeTempFile("hash_docx.docx.bin", bytes);
    const expected = crypto.createHash("sha256").update(bytes).digest("hex");

    pool.query
      .mockResolvedValueOnce([[{ uuid: EMP_UUID }]])
      .mockResolvedValueOnce([{ insertId: 2 }])
      .mockResolvedValueOnce([[{ uuid: "doc-uuid-2", employee_uuid: EMP_UUID, document_type: "Degree", file_name: "ref.docx", file_path: "documents/ref.docx", file_size: bytes.length }]]);

    const req = makeReq({
      files: [{
        filename: "hash_docx.docx.bin",
        originalname: "ref.docx",
        mimetype: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        size: bytes.length,
      }],
    });
    const res = mockRes();

    await uploadEmployeeDocuments(req, res);

    const insertCall = pool.query.mock.calls.find(([sql]) =>
      typeof sql === "string" && sql.includes("INSERT INTO employee_documents")
    );
    expect(insertCall[1][6]).toBe(expected);
    expect(insertCall[1][6]).toMatch(/^[0-9a-f]{64}$/);
  });
});
