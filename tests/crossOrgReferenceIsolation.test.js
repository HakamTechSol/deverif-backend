import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Reference matching is scoped to ONE organization — a security boundary.
 *
 * An organization's employee documents are its private reference pool: they are
 * what its own auto-verification matches submissions against, and they are
 * never visible to, nor usable on behalf of, anyone else. Before these tests
 * existed the sweep read a request's staged reference document purely by id
 * (`SELECT ... FROM employee_documents WHERE id=?`), so a request addressed to
 * an unrelated organization could be auto-approved against a document another
 * organization had uploaded. That is a cross-tenant data-integrity failure (an
 * organization deciding a case on evidence it never held) as much as a data
 * leak (another org's file content and employee name informing that decision).
 *
 * The scenario pinned here is the one from the audit: Org A holds an employee
 * with a verified reference document. An unrelated Org C receives a request for
 * the same person and the same document. Org C legitimately has zero prior
 * reference for that person, so the request must land with a human — never
 * auto-approve, and never resolve against Org A's pool.
 */

const { sharedQuery, fakeConnection, runAutoMatchChecksSpy } = vi.hoisted(() => {
  const q = vi.fn();
  return {
    sharedQuery: q,
    fakeConnection: {
      query: q,
      beginTransaction: vi.fn(),
      commit: vi.fn(),
      rollback: vi.fn(),
      release: vi.fn(),
    },
    // Spied so the detail handler's sweep scope can be asserted without the
    // sweep actually running against the fake pool.
    runAutoMatchChecksSpy: vi.fn(async () => {}),
  };
});

vi.mock("../src/config/db.js", () => ({
  pool: { query: sharedQuery, getConnection: vi.fn(async () => fakeConnection) },
}));
vi.mock("../src/services/documentService.js", async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, validate: vi.fn(), match: vi.fn(), ocrExtract: vi.fn() };
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
vi.mock("../src/utils/autoMatch.js", async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, runAutoMatchChecks: runAutoMatchChecksSpy };
});

import { pool } from "../src/config/db.js";
import { validate, match as matchDocuments } from "../src/services/documentService.js";
import { createRequest, updateMySentRequest, getMyInboxRequestDetail, myInboxRequests } from "../src/controllers/verification.controller.js";
import { computeMatchConfidence } from "../src/utils/autoMatch.js";
import { encryptCnic } from "../src/utils/personCrypto.js";
import { DOCS_DIR } from "../src/config/uploadPaths.js";

// Set before any module that reads it at import time, so encryptCnic() works in
// the fixture that re-addresses a request (its staging re-resolves the owner's
// CNIC from the encrypted person row).
process.env.PERSON_DATA_ENCRYPTION_KEY = "test-only-person-data-key";

const ORG_A_UUID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ORG_C_UUID = "cccccccc-3333-4333-8333-cccccccccccc";
const ORG_A_ID = 10;
const ORG_C_ID = 30;

const SUBMITTED_FILE = `crossorg_submit_${process.pid}.pdf`;
// Byte-identical to Org A's reference: same content, so the exact-hash fast path
// would fire at 100 if the reference lookup were not org-scoped.
const SUBMITTED_BYTES = Buffer.from("%PDF-1.7\nOrg A reference document\n");
const SUBMITTED_HASH = crypto.createHash("sha256").update(SUBMITTED_BYTES).digest("hex");

const OWNER = { document_owner_name: "Asim Khan", document_owner_cnic: "42101-1234567-1" };

const TEMP_FILES = [];

beforeAll(() => {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  fs.writeFileSync(path.join(DOCS_DIR, SUBMITTED_FILE), SUBMITTED_BYTES);
  TEMP_FILES.push(path.join(DOCS_DIR, SUBMITTED_FILE));
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
  pool.getConnection.mockResolvedValue(fakeConnection);
  validate.mockResolvedValue({ success: true, data: { valid: true } });
  // If any code path DOES reach the comparison, the service would happily report
  // a perfect match. The tests below therefore prove the answer comes from never
  // calling it, not from the service declining.
  matchDocuments.mockResolvedValue({
    success: true,
    data: { match: true, confidence: 100, reasons: [] },
  });
  runAutoMatchChecksSpy.mockResolvedValue(undefined);
});

function makeReq({ body = {}, user = {}, file = null } = {}) {
  return {
    body,
    user: { id: 1, org_role: "org_admin", ...user },
    file: file || { filename: SUBMITTED_FILE, mimetype: "application/pdf", originalname: SUBMITTED_FILE },
  };
}

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

/** The employee_document row Org A owns. Never reachable by Org C. */
const ORG_A_REFERENCE = {
  id: 777,
  document_hash: SUBMITTED_HASH, // identical to the submission
  file_path: "documents/orgA_reference.pdf",
  document_type: "CNIC / National ID Copy",
  extracted_data: null,
  extraction_status: "succeeded",
};

/** A request as the sweep sees it, staged with ORG A's reference. */
function stagedRequest(overrides = {}) {
  return {
    id: 900,
    uuid: "req-cross-org",
    status: "under_review",
    match_status: "not_attempted",
    matched_employee_document_id: ORG_A_REFERENCE.id,
    document_type: "CNIC / National ID Copy",
    document_path: `/uploads/documents/${SUBMITTED_FILE}`,
    document_hash: SUBMITTED_HASH,
    user_id: 1,
    requester_uuid: "requester-uuid",
    requester_organization: null,
    ...overrides,
  };
}

/** The real sweep (this file mocks the module, so bypass the mock). */
async function realSweep() {
  return (await vi.importActual("../src/utils/autoMatch.js")).runAutoMatchChecks;
}

/**
 * Route pool.query so the reference read answers only for the organization
 * that owns the row, exactly as the org-scoped SQL would.
 */
function installPool({ request, orgId, verifiedRow = null } = {}) {
  const statements = [];
  pool.query.mockImplementation((sql, params = []) => {
    const stmt = String(sql);
    statements.push({ sql: stmt, params });

    if (stmt.includes("FROM verification_requests vr") && stmt.includes("requester_uuid")) {
      return Promise.resolve(request ? [[request]] : [[]]);
    }
    if (stmt.includes("FROM employee_documents ed")) {
      return Promise.resolve(params[1] === ORG_A_ID ? [[ORG_A_REFERENCE]] : [[]]);
    }
    if (stmt.includes("status='verified'") && stmt.includes("match_status='auto_matched'")) {
      return Promise.resolve([{ affectedRows: 1 }]);
    }
    if (stmt.includes("FROM verification_requests WHERE id=?")) {
      return Promise.resolve([[{ ...(request || {}), status: "verified", linked_person_id: null }]]);
    }
    if (verifiedRow && stmt.includes("document_hash=?")) return Promise.resolve([[verifiedRow]]);
    return Promise.resolve([{ affectedRows: 1 }]);
  });
  return statements;
}

describe("Part 1 — reference matching never crosses an organization boundary", () => {
  it("Org C's request does not auto-approve against Org A's reference document", async () => {
    // The request is addressed to Org C but was staged with Org A's reference id.
    // Org C holds no reference for this person, so 'no_reference_found' is the
    // only honest outcome.
    installPool({ request: stagedRequest({ issuing_organization_id: ORG_C_ID }) });

    await (await realSweep())({ orgId: ORG_C_ID });

    // The service was never consulted: Org A's document was never read.
    expect(matchDocuments).not.toHaveBeenCalled();

    const resolution = pool.query.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("match_status='no_reference_found'")
    );
    expect(resolution).toBeDefined();
    expect(resolution[1]).toEqual([900]);
  });

  it("resolving to no_reference_found clears the cross-org reference pointer", async () => {
    installPool({ request: stagedRequest({ id: 901, issuing_organization_id: ORG_C_ID }) });

    await (await realSweep())({ orgId: ORG_C_ID });

    const update = pool.query.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("match_status='no_reference_found'")
    )[0];
    // The pointer is dropped, so the request can never be reconsidered against
    // a reference it is not allowed to use.
    expect(update).toContain("matched_employee_document_id=NULL");
    expect(update).toContain("match_confidence=NULL");
  });

  it("never writes an auto-approve or a manual_review for a cross-org reference", async () => {
    installPool({ request: stagedRequest({ id: 902, issuing_organization_id: ORG_C_ID }) });

    await (await realSweep())({ orgId: ORG_C_ID });

    for (const [sql] of pool.query.mock.calls) {
      if (typeof sql !== "string") continue;
      expect(sql).not.toContain("match_status='auto_matched'");
      expect(sql).not.toContain("match_status='manual_review'");
    }
  });

  it("the reference lookup filters on the target organization in its WHERE clause", async () => {
    const statements = installPool({
      request: stagedRequest({ id: 903, issuing_organization_id: ORG_C_ID, document_hash: "b".repeat(64) }),
    });

    await (await realSweep())({ orgId: ORG_C_ID });

    const refRead = statements.find((s) => s.sql.includes("FROM employee_documents ed"));
    expect(refRead).toBeDefined();
    // The owning organization is part of the WHERE clause, not a post-filter.
    expect(refRead.sql).toContain("e.organization_id = ?");
    // And the value bound is the TARGET org of this request.
    expect(refRead.params).toEqual([ORG_A_REFERENCE.id, ORG_C_ID]);
  });

  it("a request with no target organization resolves to no reference, not an approval", async () => {
    installPool({ request: stagedRequest({ id: 904, issuing_organization_id: null }) });

    await (await realSweep())({});

    expect(matchDocuments).not.toHaveBeenCalled();
  });

  it("the sweep never picks up a request with no target organization", async () => {
    const statements = installPool({});

    await (await realSweep())({});

    const candidateQuery = statements.find((s) => s.sql.includes("FROM verification_requests vr"));
    expect(candidateQuery.sql).toContain("vr.issuing_organization_id IS NOT NULL");
  });

  it("computeMatchConfidence defers for a request with no target organization", async () => {
    const confidence = await computeMatchConfidence(
      stagedRequest({ issuing_organization_id: null })
    );
    expect(confidence).toBeNull();
    // Nothing was read at all — the answer is settled before any query runs.
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("Org A's own request against Org A's reference still auto-approves", async () => {
    // The scoping must not neuter the feature: the owning organization matches
    // against its own pool exactly as before.
    installPool({ request: stagedRequest({ id: 905, issuing_organization_id: ORG_A_ID }) });

    await (await realSweep())({ orgId: ORG_A_ID });

    const approve = pool.query.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("match_status='auto_matched'")
    );
    expect(approve).toBeDefined();
    expect(approve[1]).toEqual([100, 905]);
  });

  it("the auto-approve write itself restates the tenant invariant", async () => {
    installPool({ request: stagedRequest({ id: 906, issuing_organization_id: ORG_A_ID }) });

    await (await realSweep())({ orgId: ORG_A_ID });

    const approve = pool.query.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("match_status='auto_matched'")
    )[0];
    // Belt-and-braces on the one statement that flips a request to 'verified'
    // without a human: no target organization, no automatic outcome.
    expect(approve).toContain("issuing_organization_id IS NOT NULL");
  });
});

describe("Part 1 — the exact-hash auto-verify check is scoped to the issuing org", () => {
  /** A pool good enough for the whole createRequest path. */
  function installCreatePool({ orgId, previousVerified = null, employees = [] } = {}) {
    pool.query.mockImplementation((sql) => {
      const stmt = String(sql);
      if (stmt.includes("SELECT id FROM organizations")) {
        return Promise.resolve(orgId ? [[{ id: orgId }]] : [[]]);
      }
      if (stmt.includes("document_hash=?")) {
        return Promise.resolve(previousVerified ? [[previousVerified]] : [[]]);
      }
      if (stmt.includes("INSERT INTO verification_requests")) {
        return Promise.resolve([{ insertId: 1, affectedRows: 1 }]);
      }
      if (stmt.includes("INSERT INTO unmatched_organizations")) {
        return Promise.resolve([{ insertId: 9 }]);
      }
      if (stmt.includes("JOIN employee_documents ed") || stmt.includes("FROM employees emp")) {
        return Promise.resolve([employees]);
      }
      if (stmt.includes("FROM employees e")) return Promise.resolve([[]]);
      if (stmt.includes("issuing_org_name")) {
        return Promise.resolve([[{ id: 1, uuid: "req-uuid", issuing_organization_id: orgId }]]);
      }
      if (/^(INSERT|UPDATE|DELETE)\b/.test(stmt)) return Promise.resolve([{ affectedRows: 1 }]);
      return Promise.resolve([[]]);
    });
  }

  it("scopes the prior-verified lookup on the TARGET organization", async () => {
    installCreatePool({ orgId: ORG_C_ID });

    await createRequest(
      makeReq({
        body: {
          document_type: "CNIC / National ID Copy",
          issuing_organization_uuid: ORG_C_UUID,
          ...OWNER,
        },
      }),
      mockRes()
    );

    const lookup = pool.query.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("FROM verification_requests") && sql.includes("document_hash=?")
    );
    expect(lookup).toBeDefined();
    expect(lookup[0]).toContain("issuing_organization_id=?");
    // The bound value is the resolved TARGET org — not the requester's, and not
    // a platform-wide lookup.
    expect(lookup[1][1]).toBe(ORG_C_ID);
  });

  it("gives no repeat-submission credit based on another org's verified document", async () => {
    // The pool answers the prior-verified read exactly as it would if a
    // DIFFERENT organization had verified the same bytes: the query itself is
    // what keeps that row out of reach, so nothing comes back.
    installCreatePool({ orgId: ORG_C_ID });

    const res = mockRes();
    await createRequest(
      makeReq({
        body: {
          document_type: "CNIC / National ID Copy",
          issuing_organization_uuid: ORG_C_UUID,
          ...OWNER,
        },
      }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(201);
    const insert = pool.query.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO verification_requests")
    );
    // status is the 4th column of the INSERT's column list; 'verified' here
    // would mean a cross-org auto-verify leaked through.
    const insertSql = insert[0].replace(/NOW\(\)/gi, "@now");
    const columns = insertSql.match(/\(([^)]*)\)\s*VALUES/i)[1].split(",").map((c) => c.trim());
    const bound = {};
    let i = 0;
    const tokens = insertSql.match(/VALUES\s*\(([^)]*)\)/i)[1].split(",").map((t) => t.trim());
    columns.forEach((name, idx) => {
      if (tokens[idx] === "?") bound[name] = insert[1][i++];
    });
    expect(bound.status).toBe("under_review");
    expect(bound.organization_conserned_for_future).toBe("no");
  });

  it("a request with no target organization gets no repeat-submission credit at all", async () => {
    installCreatePool({ orgId: null });

    await createRequest(
      makeReq({
        body: {
          document_type: "CNIC / National ID Copy",
          other_organization_name: "Some Unregistered Body",
          ...OWNER,
        },
      }),
      mockRes()
    );

    // The prior-verified lookup is skipped entirely without a target org — the
    // hash is never compared against the whole platform.
    const lookup = pool.query.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("document_hash=?")
    );
    expect(lookup).toBeUndefined();
  });
});

describe("Part 1 — the reference-staging lookup at request-creation time", () => {
  function installCreatePool(orgId) {
    pool.query.mockImplementation((sql) => {
      const stmt = String(sql);
      if (stmt.includes("SELECT id FROM organizations")) return Promise.resolve([[{ id: orgId }]]);
      if (stmt.includes("INSERT INTO verification_requests")) return Promise.resolve([{ insertId: 1 }]);
      if (stmt.includes("FROM employees")) return Promise.resolve([[]]); // nobody in this org
      if (stmt.includes("issuing_org_name")) return Promise.resolve([[{ id: 1, issuing_organization_id: orgId }]]);
      if (/^(INSERT|UPDATE|DELETE)\b/.test(stmt)) return Promise.resolve([{ affectedRows: 1 }]);
      return Promise.resolve([[]]);
    });
  }

  it("scopes both employee lookups on the target organization", async () => {
    installCreatePool(ORG_C_ID);

    await createRequest(
      makeReq({
        body: {
          document_type: "CNIC / National ID Copy",
          issuing_organization_uuid: ORG_C_UUID,
          ...OWNER,
        },
      }),
      mockRes()
    );

    const staging = pool.query.mock.calls.filter(
      ([sql]) => typeof sql === "string" && sql.includes("JOIN employee_documents ed")
    );
    expect(staging.length).toBeGreaterThan(0);
    expect(staging[0][0]).toContain("e.organization_id = ?");
    expect(staging[0][1][0]).toBe(ORG_C_ID);

    const fallback = pool.query.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("FROM employees emp")
    );
    expect(fallback[0]).toContain("emp.organization_id = ?");
    expect(fallback[1][0]).toBe(ORG_C_ID);
  });

  it("resolves to no_reference_found when the target org has no employee for that CNIC", async () => {
    // Org A holds the employee; Org C does not. There is deliberately no
    // platform-wide fallback, so the request lands with a human.
    installCreatePool(ORG_C_ID);

    await createRequest(
      makeReq({
        body: {
          document_type: "CNIC / National ID Copy",
          issuing_organization_uuid: ORG_C_UUID,
          ...OWNER,
        },
      }),
      mockRes()
    );

    const stagingWrite = pool.query.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("SET match_status=?, matched_employee_document_id=?")
    );
    expect(stagingWrite[1]).toEqual(["no_reference_found", null, 1]);
  });
});

describe("Part 1 — a request re-addressed to another organization is re-staged", () => {
  const ENCRYPTED_CNIC = encryptCnic("4210112345671");

  function installUpdatePool({ employees = [] } = {}) {
    const statements = [];
    pool.query.mockImplementation((sql, params = []) => {
      const stmt = String(sql);
      statements.push({ sql: stmt, params });
      if (stmt.includes("SELECT id FROM organizations")) return Promise.resolve([[{ id: ORG_C_ID }]]);
      if (stmt.includes("cnic_encrypted")) return Promise.resolve([[{ cnic_encrypted: ENCRYPTED_CNIC }]]);
      if (stmt.includes("JOIN employee_documents ed") || stmt.includes("FROM employees emp")) {
        return Promise.resolve([employees]);
      }
      return Promise.resolve([{ affectedRows: 1 }]);
    });
    return statements;
  }

  function updateReq() {
    return {
      params: { uuid: "ffffffff-1111-4111-8111-111111111111" },
      body: { document_type: "CNIC / National ID Copy", issuing_organization_uuid: ORG_C_UUID },
      user: { id: 1, org_role: "org_admin" },
      file: null,
    };
  }

  function existingRequest(overrides = {}) {
    return {
      id: 500,
      status: "under_review",
      user_id: 1,
      document_path: `/uploads/documents/${SUBMITTED_FILE}`,
      document_format: "pdf",
      document_hash: SUBMITTED_HASH,
      document_owner_name: OWNER.document_owner_name,
      issuing_organization_id: ORG_A_ID, // was addressed to Org A...
      linked_person_id: 42,
      match_status: "not_attempted",
      matched_employee_document_id: ORG_A_REFERENCE.id, // ...with Org A's reference staged
      ...overrides,
    };
  }

  it("drops the previous target's reference and re-resolves for the new target", async () => {
    const statements = installUpdatePool();
    pool.query.mockResolvedValueOnce([[existingRequest()]]);

    const res = mockRes();
    await updateMySentRequest(updateReq(), res);
    expect(res.status).toHaveBeenCalledWith(200);

    const stagingRead = statements.find((s) => s.sql.includes("JOIN employee_documents ed"));
    expect(stagingRead).toBeDefined();
    // Re-resolved against the NEW target org, not the previous one.
    expect(stagingRead.params[0]).toBe(ORG_C_ID);

    const update = statements.find((s) =>
      s.sql.includes("match_status=?, matched_employee_document_id=?")
    );
    // Org C has nobody by this CNIC, so nothing is staged and the stale Org A
    // pointer is gone.
    expect(update.params[10]).toBe("no_reference_found");
    expect(update.params[11]).toBeNull();
  });

  it("keeps the existing staging when the target organization is unchanged", async () => {
    const statements = installUpdatePool();
    pool.query.mockResolvedValueOnce([
      [existingRequest({ issuing_organization_id: ORG_C_ID })],
    ]);

    await updateMySentRequest(
      {
        ...updateReq(),
        body: { document_type: "CNIC / National ID Copy", issuing_organization_uuid: ORG_C_UUID },
      },
      mockRes()
    );

    // No re-staging work was done at all: a document re-upload (or an unrelated
    // field edit) must not discard a valid reference.
    expect(statements.some((s) => s.sql.includes("JOIN employee_documents ed"))).toBe(false);
    const updateStmt = statements.find((s) =>
      s.sql.includes("match_status=?, matched_employee_document_id=?")
    );
    expect(updateStmt.params[10]).toBe("not_attempted");
    expect(updateStmt.params[11]).toBe(ORG_A_REFERENCE.id);
  });

  it("resolves to no_reference_found when re-addressed to an unmatched organization", async () => {
    const statements = installUpdatePool();
    pool.query.mockResolvedValueOnce([[existingRequest()]]);

    await updateMySentRequest(
      {
        params: { uuid: "ffffffff-1111-4111-8111-111111111111" },
        body: { document_type: "CNIC / National ID Copy", other_organization_name: "Unregistered Body" },
        user: { id: 1, org_role: "org_admin" },
        file: null,
      },
      mockRes()
    );

    const updateStmt = statements.find((s) =>
      s.sql.includes("match_status=?, matched_employee_document_id=?")
    );
    expect(updateStmt.params[10]).toBe("no_reference_found");
    expect(updateStmt.params[11]).toBeNull();
  });
});

describe("Part 1 — inbox/detail responses never expose another org's reference", () => {
  it("the inbox and detail queries gate the reference join on the target org", async () => {
    const statements = [];
    pool.query.mockImplementation((sql) => {
      statements.push(String(sql));
      if (String(sql).includes("COUNT(*)")) return Promise.resolve([[{ total: 0 }]]);
      return Promise.resolve([[]]);
    });

    await myInboxRequests(
      { params: {}, query: {}, user: { id: 1, org_role: "org_admin", organization: ORG_A_ID } },
      mockRes()
    );

    const listQuery = statements.find((s) => s.includes("matched_document_name"));
    expect(listQuery).toBeDefined();
    // Without this predicate a stale matched_employee_document_id would render
    // another organization's reference file name and employee name here.
    expect(listQuery).toContain("e.organization_id = vr.issuing_organization_id");
  });

  it("the detail handler scopes the lazy sweep to the caller's organization", async () => {
    pool.query.mockImplementation((sql) => {
      if (String(sql).includes("matched_document_name")) {
        return Promise.resolve([
          [{ id: 1, uuid: "eeeeeeee-4444-4444-8444-333333333333", issuing_organization_id: ORG_A_ID, document_hash: null }],
        ]);
      }
      return Promise.resolve([[]]);
    });

    await getMyInboxRequestDetail(
      {
        params: { uuid: "eeeeeeee-4444-4444-8444-333333333333" },
        user: { id: 1, org_role: "org_admin", organization: ORG_A_ID },
      },
      mockRes()
    );

    expect(runAutoMatchChecksSpy).toHaveBeenCalledWith({
      requestId: 1,
      orgId: ORG_A_ID,
    });
  });
});
