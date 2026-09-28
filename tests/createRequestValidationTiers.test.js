import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

// End-to-end tiering coverage at the controller boundary: what the caller of
// assertDocumentValid actually experiences.
//
// The three cases the tiering must never get wrong:
//   1. a truncated/corrupt PDF  -> 400, no request row
//   2. a crop-detector flag      -> 201, request created and stored as 'flagged'
//   3. HTML announced as PDF    -> 400, no request row  (security control)
//
// Case 3 is the one that would be a security regression if the tiering were
// mis-tuned, so it is asserted hardest of the three.

const h = vi.hoisted(() => {
  const sharedQuery = vi.fn();
  return {
    sharedQuery,
    connection: {
      query: sharedQuery,
      beginTransaction: vi.fn(),
      commit: vi.fn(),
      rollback: vi.fn(),
      release: vi.fn(),
    },
  };
});

vi.mock("../src/config/db.js", () => ({
  pool: { query: h.sharedQuery, getConnection: vi.fn(async () => h.connection) },
}));

const serviceMock = vi.fn();
vi.mock("../src/services/documentService.js", () => ({
  validate: (p) => serviceMock(p),
  DocumentServiceError: class extends Error {
    constructor(statusCode, message, { kind = "generic" } = {}) {
      super(message);
      this.name = "DocumentServiceError";
      this.kind = kind;
      this.statusCode = statusCode;
    }
  },
}));
vi.mock("../src/utils/qrCertificate.js", () => ({
  generateQrForRequest: vi.fn().mockResolvedValue(undefined),
  // Identity pass-through: see tests/verifyUrl.test.js for the real behaviour.
  withVerifyUrl: (row) => row,
  withVerifyUrls: (rows) => rows,
}));

import { createRequest } from "../src/controllers/verification.controller.js";
import { DOCS_DIR } from "../src/config/uploadPaths.js";

const ORG_UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OWNER = { document_owner_name: "Asim Khan", document_owner_cnic: "42101-1234567-1" };
const DOC_FILENAME = `doc_tier_${process.pid}.pdf`;
const DUMMY_FILE = path.join(DOCS_DIR, DOC_FILENAME);

const REQ_ROW = {
  id: 1,
  uuid: "cccccccc-dddd-4eee-8fff-000000000001",
  user_id: 1,
  document_type: "Degree",
  status: "under_review",
  issuing_organization_uuid: ORG_UUID,
  issuing_org_name: "Acme",
};

function serviceVerdict(overrides = {}) {
  return {
    success: true,
    data: {
      valid: true,
      reason: null,
      file_type: "pdf",
      check_type: "structural",
      cropped: false,
      crop_reason: null,
      crop_score: 0,
      ...overrides,
    },
  };
}

/** The request INSERT's bound params, keyed by column name. */
function insertedColumns() {
  const call = h.sharedQuery.mock.calls.find(
    ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO verification_requests")
  );
  if (!call) return null;
  const sql = call[0].replace(/NOW\(\)/gi, "@now");
  const [, columnList, valueList] = sql.match(/\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/i);
  const names = columnList.split(",").map((c) => c.trim());
  const tokens = valueList.split(",").map((t) => t.trim());
  let next = 0;
  return Object.fromEntries(
    names.map((name, idx) => [name, tokens[idx] === "?" ? call[1][next++] : null])
  );
}

function makeReq() {
  return {
    body: { document_type: "Degree", issuing_organization_uuid: ORG_UUID, ...OWNER },
    // organization: null keeps the daily-quota path out of these tests so the
    // assertions are only about the validation tiering.
    user: { id: 1, org_role: "org_admin", organization: null },
    file: { filename: DOC_FILENAME, mimetype: "application/pdf", originalname: "doc.pdf" },
  };
}

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

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

beforeEach(() => {
  vi.clearAllMocks();
  h.pool_getConnectionReset?.();
  h.sharedQuery.mockImplementation(async (sql) => {
    const stmt = String(sql).trim();
    if (stmt.includes("SELECT id FROM organizations WHERE uuid=")) return [[{ id: 10 }]];
    if (stmt.includes("FROM verification_requests") && stmt.includes("document_hash=?")) return [[]];
    if (stmt.includes("INSERT INTO verification_requests")) return [{ insertId: 1, affectedRows: 1 }];
    if (stmt.includes("issuing_org_name")) return [[REQ_ROW]];
    if (stmt.includes("INSERT INTO persons")) return [{ insertId: 99, affectedRows: 1 }];
    if (/^(INSERT|UPDATE|DELETE)\b/.test(stmt)) return [{ affectedRows: 1 }];
    return [[]];
  });
  serviceMock.mockResolvedValue(serviceVerdict());
});

// ---------------------------------------------------------------------------
// 1. structural -> hard block, no request row
// ---------------------------------------------------------------------------

describe("createRequest — a truncated PDF is hard-blocked and creates nothing", () => {
  beforeEach(() => {
    serviceMock.mockResolvedValue(
      serviceVerdict({
        valid: false,
        check_type: "structural",
        reason: "PDF is truncated (missing %%EOF marker)",
      })
    );
  });

  it("rejects with 400 carrying the service's reason", async () => {
    await expect(createRequest(makeReq(), mockRes())).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("truncated"),
    });
  });

  it("creates no request row", async () => {
    await expect(createRequest(makeReq(), mockRes())).rejects.toThrow();

    expect(insertedColumns()).toBeNull();
    const committed = h.sharedQuery.mock.calls.filter(([sql]) =>
      String(sql).includes("INSERT INTO verification_requests")
    );
    expect(committed).toHaveLength(0);
  });

  it("opens no transaction, so no quota is consumed", async () => {
    await expect(createRequest(makeReq(), mockRes())).rejects.toThrow();

    expect(h.connection.beginTransaction).not.toHaveBeenCalled();
    expect(h.connection.commit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. heuristic -> soft flag, request created
// ---------------------------------------------------------------------------

describe("createRequest — a crop-detector flag is stored, not blocked", () => {
  const CROP_MESSAGE = "Content runs off the left edge of the scan — the document looks cropped";

  beforeEach(() => {
    serviceMock.mockResolvedValue(
      serviceVerdict({
        valid: false,
        check_type: "heuristic",
        cropped: true,
        crop_score: 0.42,
        reason: CROP_MESSAGE,
        crop_reason: CROP_MESSAGE,
      })
    );
  });

  it("creates the request successfully", async () => {
    const res = mockRes();
    await createRequest(makeReq(), res);
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("stores document_validation_status='flagged' on the row", async () => {
    await createRequest(makeReq(), mockRes());
    expect(insertedColumns().document_validation_status).toBe("flagged");
  });

  it("stores the service's own reason so the reviewer sees the real measurement", async () => {
    await createRequest(makeReq(), mockRes());
    expect(insertedColumns().document_validation_reason).toBe(CROP_MESSAGE);
  });

  it("commits the transaction — the flag is a real, delivered request", async () => {
    await createRequest(makeReq(), mockRes());
    expect(h.connection.commit).toHaveBeenCalledTimes(1);
    expect(h.connection.rollback).not.toHaveBeenCalled();
  });

  it("does NOT block: the reviewing org gets the request with a warning", async () => {
    // The point of the heuristic tier: a tuning-sensitive threshold must not
    // cost an honest submitter their request.
    const res = mockRes();
    await createRequest(makeReq(), res);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(insertedColumns()).not.toBeNull();
    expect(insertedColumns().document_validation_status).toBe("flagged");
  });

  it("flags a darkness/low-contrast verdict the same way", async () => {
    const dark = "The scan is under-exposed: no pixel in the image is bright enough to be paper";
    serviceMock.mockResolvedValue(
      serviceVerdict({ valid: false, check_type: "heuristic", cropped: true, reason: dark })
    );

    await createRequest(makeReq(), mockRes());
    const cols = insertedColumns();
    expect(cols.document_validation_status).toBe("flagged");
    expect(cols.document_validation_reason).toBe(dark);
  });
});

// ---------------------------------------------------------------------------
// 3. MIME spoofing -> STILL a hard block
// ---------------------------------------------------------------------------

describe("createRequest — MIME spoofing is still hard-blocked (security control)", () => {
  const SPOOF_REASON =
    "File type mismatch: declared content type 'application/pdf' but content is TEXT";

  beforeEach(() => {
    // HTML bytes, .pdf filename, application/pdf mimetype — the exact case from
    // the security audit.
    serviceMock.mockResolvedValue(
      serviceVerdict({ valid: false, check_type: "structural", file_type: "text", reason: SPOOF_REASON })
    );
  });

  it("is rejected with 400", async () => {
    await expect(createRequest(makeReq(), mockRes())).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("mismatch"),
    });
  });

  it("creates no request row", async () => {
    await expect(createRequest(makeReq(), mockRes())).rejects.toThrow();
    expect(insertedColumns()).toBeNull();
  });

  it("is never persisted as 'flagged' — a spoofed file cannot be waved through", async () => {
    // The tiering is only safe if a structural verdict has no path to a soft
    // flag. Try both spoof payload shapes: bare, and carrying a crop signal that
    // a naive `if (cropped) flag` implementation would have soft-flagged.
    const shapes = [
      { valid: false, check_type: "structural", file_type: "text", reason: SPOOF_REASON },
      {
        valid: false,
        check_type: "structural",
        file_type: "text",
        cropped: true,
        crop_score: 0.9,
        reason: SPOOF_REASON,
        crop_reason: "Content runs off the top edge",
      },
    ];

    for (const shape of shapes) {
      vi.clearAllMocks();
      h.sharedQuery.mockImplementation(async (sql) => {
        const stmt = String(sql).trim();
        if (stmt.includes("SELECT id FROM organizations WHERE uuid=")) return [[{ id: 10 }]];
        if (stmt.includes("FROM verification_requests") && stmt.includes("document_hash=?")) return [[]];
        if (stmt.includes("issuing_org_name")) return [[REQ_ROW]];
        if (/^(INSERT|UPDATE|DELETE)\b/.test(stmt)) return [{ affectedRows: 1 }];
        return [[]];
      });
      serviceMock.mockResolvedValue(serviceVerdict(shape));

      await expect(createRequest(makeReq(), mockRes())).rejects.toMatchObject({ statusCode: 400 });
      // No row at all — so certainly no row marked 'flagged'.
      expect(insertedColumns()).toBeNull();
    }
  });

  it("still blocks even if the payload also carries a crop signal", async () => {
    // A spoofed file that additionally trips the crop heuristic must not be able
    // to buy its way in through the soft branch.
    serviceMock.mockResolvedValue(
      serviceVerdict({
        valid: false,
        check_type: "structural",
        file_type: "text",
        cropped: true,
        crop_score: 0.9,
        reason: SPOOF_REASON,
        crop_reason: "Content runs off the top edge",
      })
    );

    await expect(createRequest(makeReq(), mockRes())).rejects.toMatchObject({ statusCode: 400 });
    expect(insertedColumns()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. clean + unvalidated
// ---------------------------------------------------------------------------

describe("createRequest — a clean document is stored as passed", () => {
  it("stores document_validation_status='passed' with no reason", async () => {
    await createRequest(makeReq(), mockRes());
    const cols = insertedColumns();
    expect(cols.document_validation_status).toBe("passed");
    expect(cols.document_validation_reason).toBeNull();
  });
});

describe("createRequest — an unreachable validator is not recorded as a clean pass", () => {
  it("creates the request but stores status='unvalidated'", async () => {
    const { DocumentServiceError } = await import("../src/services/documentService.js");
    serviceMock.mockRejectedValue(
      new DocumentServiceError(503, "timed out", { kind: "timeout" })
    );

    const res = mockRes();
    await createRequest(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(201);
    const cols = insertedColumns();
    // Fail-open preserved, but recorded honestly: this file was never checked,
    // and 'passed' would claim otherwise.
    expect(cols.document_validation_status).toBe("unvalidated");
    expect(cols.document_validation_reason).toBeNull();
  });
});
