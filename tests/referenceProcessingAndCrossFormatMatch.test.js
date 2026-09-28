import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Parts 2 and 3: an employee reference document is PROCESSED AT UPLOAD TIME, and
 * the match engine then decides on canonical extracted fields rather than on
 * file format.
 *
 * Part 2 closes the "lazily at match time" gap. A reference used to be an inert
 * file: nothing was extracted when it was uploaded, office formats were not even
 * fingerprinted, and the first comparison re-sent it to the document service.
 * The consequence was silent and asymmetric — a DOCX reference produced no text
 * on the OCR path, every canonical field came back "not_visible", the
 * required-field hard-fail fired, and a PDF submission of that very same
 * document landed in manual review as "unverified" (issue D).
 *
 * Part 3 fixes the decision itself: only the extracted fields take part, with
 * the exact-hash fast path as the single byte-level shortcut. Two different
 * file formats can never hash alike, and correctly so — the content match is
 * what has to carry those cases.
 */

vi.mock("../src/config/db.js", () => ({ pool: { query: vi.fn() } }));
vi.mock("../src/services/documentService.js", async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, validate: vi.fn(), ocrExtract: vi.fn(), match: vi.fn() };
});
vi.mock("../src/utils/qrCertificate.js", () => ({
  generateQrForRequest: vi.fn().mockResolvedValue(undefined),
  // Identity pass-through: see tests/verifyUrl.test.js for the real behaviour.
  withVerifyUrl: (row) => row,
  withVerifyUrls: (rows) => rows,
}));
vi.mock("../src/utils/auditLog.js", () => ({
  logAudit: vi.fn(),
  getActorFromReq: vi.fn(() => ({})),
}));
vi.mock("../src/utils/mailer.js", () => ({ sendVerificationResultEmailToOrg: vi.fn() }));

import { pool } from "../src/config/db.js";
import { validate, ocrExtract, match as matchDocuments, DocumentServiceError } from "../src/services/documentService.js";
import { uploadEmployeeDocuments } from "../src/controllers/org/employeeMeta.controller.js";
import { runAutoMatchChecks } from "../src/utils/autoMatch.js";
import {
  isCanonicalExtractionSupported,
  parseExtractedData,
  EXTRACTION_SUCCEEDED,
  EXTRACTION_FAILED,
  EXTRACTION_NOT_APPLICABLE,
} from "../src/utils/referenceExtraction.js";
import { DOCS_DIR } from "../src/config/uploadPaths.js";

const EMP_UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ORG_A_ID = 10;
const ORG_A_REFERENCE_ID = 777;
const DOC_TYPE = "CNIC / National ID Copy";

const TEMP_FILES = [];

/** A real DOCX (ZIP carrying word/document.xml) — the python-docx path's input. */
function writeDocxBytes(name) {
  // A ZIP local file header followed by the DOCX parts python-docx requires.
  // Content is opaque to this layer — the backend only forwards the bytes.
  const filePath = path.join(DOCS_DIR, name);
  fs.writeFileSync(filePath, Buffer.from("PK\u0003\u0004 fake docx container bytes"));
  TEMP_FILES.push(filePath);
  return { filePath, bytes: fs.readFileSync(filePath) };
}

function writePdfBytes(name) {
  const filePath = path.join(DOCS_DIR, name);
  const bytes = Buffer.from("%PDF-1.7\nAsim Khan 42101-1234567-1\n");
  fs.writeFileSync(filePath, bytes);
  TEMP_FILES.push(filePath);
  return { filePath, bytes };
}

beforeAll(() => {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
});

afterAll(() => {
  for (const f of TEMP_FILES) {
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch {
      /* best-effort */
    }
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  validate.mockResolvedValue({ success: true, data: { valid: true } });
  ocrExtract.mockResolvedValue({
    success: true,
    data: {
      document_type: "cnic",
      fields: {
        name: { value: "Asim Khan", confidence: "high" },
        cnic: { value: "4210112345671", confidence: "high" },
        dob: { value: "1990-08-05", confidence: "high" },
      },
    },
  });
});

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

function uploadReq(file) {
  return {
    params: { uuid: EMP_UUID },
    scopeOrgId: ORG_A_ID,
    body: { document_type: DOC_TYPE },
    user: { id: 1, uuid: "actor", org_role: "org_admin", full_name: "Admin" },
    admin: null,
    ip: "127.0.0.1",
    headers: {},
    connection: { remoteAddress: "127.0.0.1" },
    files: [file],
  };
}

/** The employee_documents INSERT's bound parameters, read by column name. */
function insertedColumns() {
  const call = pool.query.mock.calls.find(
    ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO employee_documents")
  );
  expect(call).toBeDefined();

  // Function calls are reduced to bare placeholders first: a "(" inside
  // UUID()/NOW() would otherwise truncate the value list at its closing paren.
  const sql = call[0].replace(/UUID\(\)/gi, "@uuid").replace(/NOW\(\)/gi, "@now");
  const [, columnList, valueList] = sql.match(/\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/i);
  const names = columnList.split(",").map((c) => c.trim());
  const tokens = valueList.split(",").map((t) => t.trim());
  let next = 0;
  return Object.fromEntries(
    names.map((name, idx) => [name, tokens[idx] === "?" ? call[1][next++] : tokens[idx]])
  );
}

function installUploadPool() {
  pool.query
    .mockResolvedValueOnce([[{ uuid: EMP_UUID }]])
    .mockResolvedValueOnce([{ insertId: 1 }])
    .mockResolvedValueOnce([[{ uuid: "doc-uuid", employee_uuid: EMP_UUID }]]);
}

describe("Part 2 — reference documents are processed at UPLOAD time", () => {
  it("extracts the canonical fields for a PDF reference and caches them on the row", async () => {
    const { filePath } = writePdfBytes(`ref_pdf_${process.pid}.pdf`);
    installUploadPool();

    await uploadEmployeeDocuments(
      uploadReq({ filename: path.basename(filePath), originalname: "cnic.pdf", mimetype: "application/pdf", size: 30 }),
      mockRes()
    );

    // The document service was asked, at upload, with this file.
    expect(ocrExtract).toHaveBeenCalledTimes(1);
    expect(ocrExtract.mock.calls[0][0]).toBe(filePath);
    expect(ocrExtract.mock.calls[0][1]).toBe(DOC_TYPE);

    const cols = insertedColumns();
    expect(cols.extraction_status).toBe(EXTRACTION_SUCCEEDED);
    expect(JSON.parse(cols.extracted_data)).toEqual({
      document_type: "cnic",
      document_type_label: DOC_TYPE,
      fields: {
        name: { value: "Asim Khan", confidence: "high" },
        cnic: { value: "4210112345671", confidence: "high" },
        dob: { value: "1990-08-05", confidence: "high" },
      },
    });
  });

  it("extracts a DOCX reference through the same python-docx text path", async () => {
    // This is the gap: extraction used to run only for verification-request
    // uploads, so an EMPLOYEE reference uploaded as a DOCX was never processed
    // and silently produced no comparable data.
    const { filePath } = writeDocxBytes(`ref_docx_${process.pid}.docx`);
    installUploadPool();

    await uploadEmployeeDocuments(
      uploadReq({
        filename: path.basename(filePath),
        originalname: "cnic.docx",
        mimetype: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        size: 30,
      }),
      mockRes()
    );

    // Same endpoint as the PDF: the service dispatches on the file's real
    // content type and reads a DOCX out of word/document.xml rather than
    // rasterising it.
    expect(ocrExtract).toHaveBeenCalledTimes(1);
    expect(ocrExtract.mock.calls[0][0]).toBe(filePath);

    const cols = insertedColumns();
    expect(cols.extraction_status).toBe(EXTRACTION_SUCCEEDED);
    expect(JSON.parse(cols.extracted_data).fields.cnic.value).toBe("4210112345671");
  });

  it("fingerprints every uploaded format, not just PDF and images", async () => {
    const { filePath, bytes } = writeDocxBytes(`ref_hash_${process.pid}.docx`);
    installUploadPool();

    await uploadEmployeeDocuments(
      uploadReq({
        filename: path.basename(filePath),
        originalname: "cnic.docx",
        mimetype: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        size: bytes.length,
      }),
      mockRes()
    );

    expect(insertedColumns().document_hash).toBe(
      crypto.createHash("sha256").update(bytes).digest("hex")
    );
  });

  it("records 'failed' — and still stores the document — when the service is down", async () => {
    // A reference that cannot be processed must not be rejected: the file has
    // already passed the corrupt-file check, and matching falls back to
    // comparing the files live.
    ocrExtract.mockRejectedValue(
      new DocumentServiceError(502, "Document service unreachable", { kind: "connection" })
    );
    const { filePath } = writePdfBytes(`ref_down_${process.pid}.pdf`);
    installUploadPool();

    const res = mockRes();
    await uploadEmployeeDocuments(
      uploadReq({ filename: path.basename(filePath), originalname: "cnic.pdf", mimetype: "application/pdf", size: 30 }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(201);
    const cols = insertedColumns();
    expect(cols.extraction_status).toBe(EXTRACTION_FAILED);
    expect(cols.extracted_data).toBeNull();
    expect(cols.extraction_error).toContain("unreachable");
  });

  it("records 'failed' when the service returns no extractable fields", async () => {
    ocrExtract.mockResolvedValue({ success: true, data: { document_type: "cnic", fields: {} } });
    const { filePath } = writePdfBytes(`ref_empty_${process.pid}.pdf`);
    installUploadPool();

    await uploadEmployeeDocuments(
      uploadReq({ filename: path.basename(filePath), originalname: "cnic.pdf", mimetype: "application/pdf", size: 30 }),
      mockRes()
    );

    expect(insertedColumns().extraction_status).toBe(EXTRACTION_FAILED);
  });

  it("records 'not_applicable' without calling the service for a format with no text path", async () => {
    // Legacy .doc (an OLE2 compound file) has no reader in the document service,
    // so asking would only ever return an empty extraction. The status makes
    // that explicit instead of leaving a misleading NULL.
    const filePath = path.join(DOCS_DIR, `ref_legacy_${process.pid}.doc`);
    fs.writeFileSync(filePath, Buffer.from("\xd0\xcf\x11\xe0 legacy word document"));
    TEMP_FILES.push(filePath);
    installUploadPool();

    await uploadEmployeeDocuments(
      uploadReq({ filename: path.basename(filePath), originalname: "cnic.doc", mimetype: "application/msword", size: 16 }),
      mockRes()
    );

    expect(ocrExtract).not.toHaveBeenCalled();
    const cols = insertedColumns();
    expect(cols.extraction_status).toBe(EXTRACTION_NOT_APPLICABLE);
    expect(cols.extracted_data).toBeNull();
  });
});

describe("Part 2 — referenceExtraction helpers", () => {
  it("recognises the formats the document service can read", () => {
    const supported = (mimetype, name) =>
      isCanonicalExtractionSupported({ mimetype, originalname: name });

    expect(supported("application/pdf", "a.pdf")).toBe(true);
    expect(supported("image/jpeg", "a.jpg")).toBe(true);
    expect(supported("image/png", "a.png")).toBe(true);
    expect(
      supported("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "a.docx")
    ).toBe(true);
    // A browser's generic blob marker must not cause a valid type to be skipped.
    expect(supported("application/octet-stream", "a.docx")).toBe(true);
    expect(supported(null, "a.pdf")).toBe(true);

    expect(supported("application/msword", "a.doc")).toBe(false);
    expect(supported("text/plain", "a.txt")).toBe(false);
    expect(supported("application/zip", "a.zip")).toBe(false);
  });

  it("parses a cached payload given as an object or as a JSON string", () => {
    const payload = {
      document_type: "cnic",
      document_type_label: "CNIC / National ID Copy",
      fields: { name: { value: "Asim Khan", confidence: "high" } },
    };
    const fromObject = parseExtractedData(payload);
    const fromString = parseExtractedData(JSON.stringify(payload));

    expect(fromObject.fields).toEqual(payload.fields);
    expect(fromString.fields).toEqual(payload.fields);
    // The ORIGINAL label round-trips, so the schema is re-resolved exactly.
    expect(fromString.documentType).toBe("CNIC / National ID Copy");
    expect(fromString.canonicalDocumentType).toBe("cnic");
  });

  it("treats anything unusable as 'no cache', so matching falls back to the file", () => {
    // MariaDB hands a JSON column back as a string, a row that predates the
    // column has NULL, and a failed extraction has NULL too. None of those may
    // be mistaken for a usable field map.
    expect(parseExtractedData(null)).toBeNull();
    expect(parseExtractedData("")).toBeNull();
    expect(parseExtractedData("   ")).toBeNull();
    expect(parseExtractedData("not json")).toBeNull();
    expect(parseExtractedData({})).toBeNull();
    expect(parseExtractedData({ fields: {} })).toBeNull();
    expect(parseExtractedData({ fields: [] })).toBeNull();
  });
});

describe("Part 3 — the match engine compares canonical fields, not file format", () => {
  /** A request as the sweep sees it, staged against the cached reference. */
  function stagedRequest(overrides = {}) {
    return {
      id: 800,
      uuid: "req-docx-ref",
      status: "under_review",
      match_status: "not_attempted",
      matched_employee_document_id: ORG_A_REFERENCE_ID,
      issuing_organization_id: ORG_A_ID,
      document_type: DOC_TYPE,
      document_path: `/uploads/documents/${path.basename(PDF_SUBMISSION.filePath)}`,
      // A PDF and a DOCX of the same document NEVER hash alike, and that is
      // expected: the exact-hash fast path is simply not what decides this case.
      document_hash: crypto.createHash("sha256").update(PDF_SUBMISSION.bytes).digest("hex"),
      user_id: 1,
      requester_uuid: "requester-uuid",
      requester_organization: null,
      ...overrides,
    };
  }

  let PDF_SUBMISSION;
  let DOCX_REFERENCE;

  beforeEach(() => {
    PDF_SUBMISSION = writePdfBytes(`submit_pdf_${process.pid}.pdf`);
    DOCX_REFERENCE = writeDocxBytes(`ref_cached_${process.pid}.docx`);
  });

  it("a DOCX reference and a PDF submission of the same document auto-match", async () => {
    // Issue D's regression test. The reference is a DOCX whose canonical fields
    // were cached at upload; the submission is a clean PDF. Their hashes differ,
    // so only the canonical-field comparison can carry this — and it must.
    const cached = {
      document_type: "cnic",
      document_type_label: DOC_TYPE,
      fields: {
        name: { value: "Asim Khan", confidence: "high" },
        cnic: { value: "4210112345671", confidence: "high" },
        dob: { value: "1990-08-05", confidence: "high" },
      },
    };
    matchDocuments.mockResolvedValue({
      success: true,
      data: { match: true, confidence: 100, reasons: ["name matches (100%)"] },
    });

    const request = stagedRequest();
    pool.query.mockImplementation((sql) => {
      const stmt = String(sql);
      if (stmt.includes("FROM verification_requests vr")) return Promise.resolve([[request]]);
      if (stmt.includes("FROM employee_documents ed")) {
        return Promise.resolve([[
          {
            id: ORG_A_REFERENCE_ID,
            // A DOCX reference and a PDF submission can never be byte-identical.
            document_hash: crypto.createHash("sha256").update(DOCX_REFERENCE.bytes).digest("hex"),
            file_path: `documents/${path.basename(DOCX_REFERENCE.filePath)}`,
            document_type: DOC_TYPE,
            extracted_data: JSON.stringify(cached),
            extraction_status: "succeeded",
          },
        ]]);
      }
      if (stmt.includes("match_status='auto_matched'")) return Promise.resolve([{ affectedRows: 1 }]);
      if (stmt.includes("FROM verification_requests WHERE id=?")) {
        return Promise.resolve([[{ ...request, status: "verified", linked_person_id: null }]]);
      }
      return Promise.resolve([{ affectedRows: 1 }]);
    });

    await runAutoMatchChecks({ orgId: ORG_A_ID });

    // The comparison was made on the cached fields with the reference file NOT
    // sent: that is what makes the format difference irrelevant.
    expect(matchDocuments).toHaveBeenCalledTimes(1);
    const [submittedPath, referencePath, options] = matchDocuments.mock.calls[0];
    expect(submittedPath).toBe(PDF_SUBMISSION.filePath);
    expect(referencePath).toBeNull(); // never re-read, never re-OCR'd
    expect(options.fieldsB).toEqual(cached.fields);
    expect(options.documentTypeA).toBe(DOC_TYPE);
    expect(options.documentTypeB).toBe(DOC_TYPE);

    const approve = pool.query.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("match_status='auto_matched'")
    );
    expect(approve).toBeDefined();
    expect(approve[1]).toEqual([100, request.id]);
  });

  it("falls back to sending the reference FILE when it has no cached fields", async () => {
    // A row that predates the column, or whose extraction failed, must still be
    // comparable — the cache is an optimisation, never a new requirement.
    const reference = stagedRequest();
    matchDocuments.mockResolvedValue({
      success: true,
      data: { match: true, confidence: 95, reasons: [] },
    });

    pool.query.mockImplementation((sql) => {
      const stmt = String(sql);
      if (stmt.includes("FROM verification_requests vr")) return Promise.resolve([[reference]]);
      if (stmt.includes("FROM employee_documents ed")) {
        return Promise.resolve([[
          {
            id: ORG_A_REFERENCE_ID,
            document_hash: "c".repeat(64), // different bytes -> no fast path
            file_path: `documents/${path.basename(DOCX_REFERENCE.filePath)}`,
            document_type: DOC_TYPE,
            extracted_data: null,
            extraction_status: "failed",
          },
        ]]);
      }
      if (stmt.includes("match_status='auto_matched'")) return Promise.resolve([{ affectedRows: 1 }]);
      if (stmt.includes("FROM verification_requests WHERE id=?")) {
        return Promise.resolve([[{ ...reference, status: "verified", linked_person_id: null }]]);
      }
      return Promise.resolve([{ affectedRows: 1 }]);
    });

    await runAutoMatchChecks({ orgId: ORG_A_ID });

    const [, referencePath, options] = matchDocuments.mock.calls[0];
    expect(referencePath).toBe(DOCX_REFERENCE.filePath);
    expect(options.fieldsB).toBeUndefined();
  });

  it("still takes the exact-hash fast path when the files really are identical", async () => {
    // The one place bytes decide. Unchanged behaviour, pinned so the canonical
    // path above cannot quietly become the only path.
    const sameBytes = Buffer.from("%PDF-1.7\nAsim Khan 42101-1234567-1\n");
    const reference = stagedRequest();
    const sharedHash = crypto.createHash("sha256").update(sameBytes).digest("hex");

    pool.query.mockImplementation((sql) => {
      const stmt = String(sql);
      if (stmt.includes("FROM verification_requests vr")) return Promise.resolve([[reference]]);
      if (stmt.includes("FROM employee_documents ed")) {
        return Promise.resolve([[
          {
            id: ORG_A_REFERENCE_ID,
            document_hash: sharedHash,
            file_path: "documents/whatever.pdf",
            document_type: DOC_TYPE,
            extracted_data: null,
            extraction_status: "succeeded",
          },
        ]]);
      }
      if (stmt.includes("match_status='auto_matched'")) return Promise.resolve([{ affectedRows: 1 }]);
      if (stmt.includes("FROM verification_requests WHERE id=?")) {
        return Promise.resolve([[{ ...reference, status: "verified", linked_person_id: null }]]);
      }
      return Promise.resolve([{ affectedRows: 1 }]);
    });

    await runAutoMatchChecks({ orgId: ORG_A_ID });

    // No extraction at all, and no reference file read.
    expect(matchDocuments).not.toHaveBeenCalled();
    const approve = pool.query.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("match_status='auto_matched'")
    );
    expect(approve[1]).toEqual([100, reference.id]);
  });

  it("does not auto-approve when the canonical fields disagree", async () => {
    // The comparison still has teeth: two different people stay apart even
    // though the reference was found in this organization's own pool.
    const cached = {
      document_type: "cnic",
      document_type_label: DOC_TYPE,
      fields: {
        name: { value: "Bilal Ahmed", confidence: "high" },
        cnic: { value: "3520276543211", confidence: "high" },
        dob: { value: "1985-01-02", confidence: "high" },
      },
    };
    matchDocuments.mockResolvedValue({
      success: true,
      data: { match: false, confidence: 0, reasons: ["cnic differs (0%)"] },
    });

    const reference = stagedRequest();
    pool.query.mockImplementation((sql) => {
      const stmt = String(sql);
      if (stmt.includes("FROM verification_requests vr")) return Promise.resolve([[reference]]);
      if (stmt.includes("FROM employee_documents ed")) {
        return Promise.resolve([[
          {
            id: ORG_A_REFERENCE_ID,
            document_hash: "d".repeat(64),
            file_path: "documents/ref.docx",
            document_type: DOC_TYPE,
            extracted_data: JSON.stringify(cached),
            extraction_status: "succeeded",
          },
        ]]);
      }
      return Promise.resolve([{ affectedRows: 1 }]);
    });

    await runAutoMatchChecks({ orgId: ORG_A_ID });

    const update = pool.query.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("match_status='manual_review'")
    );
    expect(update).toBeDefined();
    expect(update[1]).toEqual([0, reference.id]);
  });

  it("defers (leaves the request undecided) when the comparison service is down", async () => {
    // A transient outage must not be recorded as a permanent 'no reference'.
    matchDocuments.mockRejectedValue(
      new DocumentServiceError(503, "Document service timed out", { kind: "timeout" })
    );

    const reference = stagedRequest();
    pool.query.mockImplementation((sql) => {
      const stmt = String(sql);
      if (stmt.includes("FROM verification_requests vr")) return Promise.resolve([[reference]]);
      if (stmt.includes("FROM employee_documents ed")) {
        return Promise.resolve([[
          {
            id: ORG_A_REFERENCE_ID,
            document_hash: "e".repeat(64),
            file_path: "documents/ref.docx",
            document_type: DOC_TYPE,
            extracted_data: JSON.stringify({ fields: { name: { value: "Asim Khan", confidence: "high" } } }),
            extraction_status: "succeeded",
          },
        ]]);
      }
      return Promise.resolve([{ affectedRows: 1 }]);
    });

    await runAutoMatchChecks({ orgId: ORG_A_ID });

    for (const [sql] of pool.query.mock.calls) {
      if (typeof sql !== "string") continue;
      expect(sql).not.toContain("match_status='auto_matched'");
      expect(sql).not.toContain("match_status='manual_review'");
      expect(sql).not.toContain("match_status='no_reference_found'");
    }
  });
});
