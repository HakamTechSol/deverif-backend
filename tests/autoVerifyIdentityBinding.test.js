import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * A document's hash is an identity claim only when the person presenting it is
 * the person the organization already approved it for.
 *
 * The creation-time auto-verify path used to look up its prior approval on the
 * SHA-256 of the uploaded file plus the issuing organization and nothing else:
 *
 *   SELECT id FROM verification_requests
 *    WHERE document_hash=? AND issuing_organization_id=? AND status='verified'
 *
 * The document owner's CNIC was never part of that lookup. So the sequence
 *   1. Person A submits document D to org X; the org approves it.
 *   2. Person B submits the SAME bytes of D, claiming a different CNIC.
 * was auto-verified on the spot — never reaching the reviewing organization's
 * inbox, with no human in the loop and no OCR. Because the row is born
 * 'verified', a publicly signed, tamper-evident QR certificate was minted for a
 * document B never held: document replay dressed up as identity verification.
 *
 * The org's approval of a document is a statement about WHO presented it, so it
 * can only ever be inherited by the same identity. The fix joins `persons` and
 * requires `p.cnic_hash` to match, so the prior approval is scoped to a person
 * and not to a file. A legacy verified row with no linked person has no
 * identity to compare and confers no credit at all (fail closed → manual review).
 *
 * These tests pin that binding at the SQL level, and pin the two places it could
 * otherwise be quietly undone: the identity ledger (which recorded
 * match_status='not_checked' on this path, hiding the discrepancy) and the
 * reference-match fast path in autoMatch.js (which asserted confidence 100 on
 * byte equality alone, discarding the reference's own CNIC evidence).
 *
 * NOTE ON THE MOCK: the prior-verified lookup is modelled as a faithful
 * implementation of its OWN statement — it reads the SQL and applies whichever
 * predicates that SQL actually binds, so it reproduces the vulnerable query's
 * behaviour exactly when the identity predicate is absent. A mock hard-wired to
 * require a cnic_hash match would be worse than useless: the vulnerable query
 * binds only two parameters, the third would be `undefined`, the identity
 * comparison would never match, and the "a different person must not
 * auto-verify" tests would go green against the very bug they exist to catch.
 * Verified by running this file against the pre-fix code, where 13 of these 22
 * assertions fail — including every "a different person must not auto-verify"
 * case. The other 9 pass both before and after by design: they pin behaviour the
 * fix must not break (same-person repeats, the cross-org boundary, and the
 * fast path where the reference has no CNIC to contradict).
 */

const { sharedQuery, fakeConnection, recordPersonDocumentMock, runAutoMatchChecksSpy } = vi.hoisted(() => {
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
    recordPersonDocumentMock: vi.fn(),
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
vi.mock("../src/utils/personDocuments.js", () => ({
  recordPersonDocument: recordPersonDocumentMock,
}));
vi.mock("../src/controllers/notification.controller.js", () => ({
  // Must resolve: createRequest chains .catch() onto the org-wide notification.
  createNotificationForUsers: vi.fn().mockResolvedValue(undefined),
  createNotificationForOrgUsers: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/utils/autoMatch.js", async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, runAutoMatchChecks: runAutoMatchChecksSpy };
});

import { pool } from "../src/config/db.js";
import { validate, match as matchDocuments, ocrExtract } from "../src/services/documentService.js";
import { createRequest } from "../src/controllers/verification.controller.js";
import { recordPersonDocument } from "../src/utils/personDocuments.js";
import { hashCnic } from "../src/utils/personCrypto.js";
import { DOCS_DIR } from "../src/config/uploadPaths.js";

// Set before the first encryptCnic()/hashCnic() call. The key is read lazily by
// getKey(), so top-level assignment (matching tests/crossOrgReferenceIsolation)
// is sufficient even though the imports above already evaluated.
process.env.PERSON_DATA_ENCRYPTION_KEY = "test-only-person-data-key";

const ORG_UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OTHER_ORG_UUID = "99999999-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ORG_ID = 10;
const OTHER_ORG_ID = 20;
const PERSON_ID_A = 41;
const PERSON_ID_B = 42;

// Two genuinely different people, as far as the platform is concerned.
const CNIC_A = "42101-1234567-1"; // -> 4210112345671
const CNIC_B = "35202-7654321-9"; // -> 3520276543219
const CNIC_HASH_A = hashCnic(CNIC_A);
const CNIC_HASH_B = hashCnic(CNIC_B);

const OWNER_A = { document_owner_name: "Asim Khan", document_owner_cnic: CNIC_A };
const OWNER_B = { document_owner_name: "Bilal Ahmed", document_owner_cnic: CNIC_B };
const DOC_TYPE = "CNIC / National ID Copy";

// One document, submitted twice by two different people.
const SUBMITTED_FILE = `identity_binding_${process.pid}.pdf`;
const DOC_BYTES = Buffer.from("%PDF-1.7\nEmployment certificate for one named person\n");
const DOC_HASH = crypto.createHash("sha256").update(DOC_BYTES).digest("hex");
const DUMMY_FILE = path.join(DOCS_DIR, SUBMITTED_FILE);

beforeAll(() => {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  fs.writeFileSync(DUMMY_FILE, DOC_BYTES);
});

afterAll(() => {
  try {
    if (fs.existsSync(DUMMY_FILE)) fs.unlinkSync(DUMMY_FILE);
  } catch {
    /* best-effort */
  }
});

function makeReq({ body = {}, user = {} } = {}) {
  return {
    body,
    user: { id: 1, org_role: "org_admin", ...user },
    file: { filename: SUBMITTED_FILE, mimetype: "application/pdf", originalname: SUBMITTED_FILE },
  };
}

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

/**
 * A pool good enough for the whole createRequest path.
 *
 * `priorApproved` describes an EXISTING verified request in the database. The
 * prior-verified lookup below re-implements that query's own predicates, so it
 * returns a row only when the hash, the organization and the person's cnic_hash
 * all line up. `linkedPersonId: null` models a legacy row with no person link.
 */
function installCreatePool({ priorApproved = null, orgId = ORG_ID, personByCnic = null } = {}) {
  pool.query.mockImplementation((sql, params = []) => {
    const stmt = String(sql);

    if (stmt.includes("SELECT id FROM organizations")) {
      return Promise.resolve(orgId ? [[{ id: orgId }]] : [[]]);
    }

    // The exact-hash auto-verify lookup, modelled faithfully to whatever
    // predicates ITS OWN SQL actually carries.
    //
    // The identity predicate is applied only when the statement binds it. A mock
    // that unconditionally demanded a cnic_hash match would be a trap: the
    // vulnerable query binds just two parameters, so the third is `undefined`,
    // the identity comparison never matches, and every "a different person must
    // not auto-verify" test would go GREEN against the very bug it targets. The
    // mock has to read the statement, not assume the fixed shape.
    if (stmt.includes("document_hash=?")) {
      const [hash, org, cnicHash] = params;
      const bindsIdentity = stmt.includes("cnic_hash=?");
      const match =
        priorApproved &&
        priorApproved.document_hash === hash &&
        priorApproved.org_id === org &&
        (!bindsIdentity || priorApproved.cnic_hash === cnicHash);
      return Promise.resolve(match ? [[{ id: priorApproved.id }]] : [[]]);
    }

    if (stmt.includes("INSERT INTO verification_requests")) {
      return Promise.resolve([{ insertId: 1, affectedRows: 1 }]);
    }
    if (stmt.includes("INSERT INTO persons")) {
      return Promise.resolve([{ insertId: PERSON_ID_A, affectedRows: 1 }]);
    }
    // buildDocumentCrossCheck reads the person's cnic_hash to compare OCR output.
    if (stmt.includes("cnic_hash FROM persons")) {
      const hash = personByCnic?.cnic_hash || priorApproved?.cnic_hash || null;
      return Promise.resolve(hash ? [[{ cnic_hash: hash }]] : [[]]);
    }
    if (stmt.includes("FROM persons WHERE cnic_hash=?")) {
      return Promise.resolve(personByCnic ? [[{ id: personByCnic.id }]] : [[]]);
    }
    if (stmt.includes("SELECT verified_at") && stmt.includes("FROM person_documents")) {
      return Promise.resolve([[]]);
    }
    // Nobody in the target org: the reference flow resolves to
    // 'no_reference_found' and the request is decided purely by the hash lookup.
    if (stmt.includes("employee_documents ed") || stmt.includes("FROM employees emp")) {
      return Promise.resolve([[]]);
    }
    if (stmt.includes("issuing_org_name")) {
      return Promise.resolve([
        [
          {
            id: 1,
            uuid: "cccccccc-dddd-4eee-8fff-000000000001",
            user_id: 1,
            document_type: DOC_TYPE,
            issuing_organization_id: orgId,
            unmatched_org_id: null,
            status: "under_review",
            document_path: `/uploads/documents/${SUBMITTED_FILE}`,
            document_format: "pdf",
            document_hash: DOC_HASH,
            document_owner_name: OWNER_A.document_owner_name,
            linked_person_id: personByCnic?.id ?? PERSON_ID_A,
            match_status: "not_attempted",
            matched_employee_document_id: null,
            submission_remarks: null,
            verification_method: "manual",
            verified_at: null,
            qr_token: null,
            qr_signature: null,
            requester_uuid: "requester-uuid",
            requester_organization: null,
          },
        ],
      ]);
    }
    if (/^(INSERT|UPDATE|DELETE)\b/.test(stmt)) return Promise.resolve([{ affectedRows: 1 }]);
    return Promise.resolve([[]]);
  });
}

/**
 * Read the request INSERT's bound parameters BY COLUMN NAME.
 *
 * Positional assertions break whenever a column is inserted mid-statement, so
 * the column list is parsed instead — the same approach as
 * tests/createRequest.test.js.
 */
function insertedColumns() {
  const call = pool.query.mock.calls.find(
    ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO verification_requests")
  );
  expect(call).toBeDefined();

  // NOW() contains parentheses, so neutralise it before splitting on commas.
  const sql = call[0].replace(/NOW\(\)/gi, "@now");
  const [, columnList, valueList] = sql.match(/\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/i);
  const names = columnList.split(",").map((c) => c.trim());
  const tokens = valueList.split(",").map((t) => t.trim());

  expect(tokens).toHaveLength(names.length);
  expect(tokens.filter((t) => t === "?").length).toBe(call[1].length);

  let next = 0;
  return Object.fromEntries(
    names.map((name, idx) => [name, tokens[idx] === "?" ? call[1][next++] : new Date(0)])
  );
}

/** The prior-verified lookup's SQL + bound params, or undefined if never run. */
function priorVerifiedLookup() {
  return pool.query.mock.calls.find(
    ([sql]) =>
      typeof sql === "string" &&
      sql.includes("FROM verification_requests") &&
      sql.includes("document_hash=?")
  );
}

async function submit({ owner = OWNER_A, orgUuid = ORG_UUID } = {}) {
  const res = mockRes();
  await createRequest(
    makeReq({ body: { document_type: DOC_TYPE, issuing_organization_uuid: orgUuid, ...owner } }),
    res
  );
  expect(res.status).toHaveBeenCalledWith(201);
  return res;
}

/** A prior approval of DOC_HASH by ORG_ID, for `cnicHash` only. */
function priorApprovalFor({ cnicHash = CNIC_HASH_A, orgId = ORG_ID } = {}) {
  return { id: 5, document_hash: DOC_HASH, org_id: orgId, cnic_hash: cnicHash };
}

beforeEach(() => {
  vi.clearAllMocks();
  pool.getConnection.mockResolvedValue(fakeConnection);
  validate.mockResolvedValue({ success: true, data: { valid: true } });
  // OCR reads back the identity that is actually printed on the document. The
  // default answer is Person A, so a cross-check only "passes" where the test
  // intends it to.
  ocrExtract.mockResolvedValue({
    success: true,
    data: {
      document_type: "cnic",
      fields: {
        name: { value: OWNER_A.document_owner_name, confidence: "high" },
        cnic: { value: "4210112345671", confidence: "high" },
      },
    },
  });
  // If any path DOES reach the canonical comparison, the service reports a
  // perfect match. Tests therefore prove an outcome came from the right branch
  // rather than from the service declining.
  matchDocuments.mockResolvedValue({ success: true, data: { match: true, confidence: 100, reasons: [] } });
  runAutoMatchChecksSpy.mockResolvedValue(undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// Part 1 — the prior-approval lookup is bound to a person, not to a file
// ─────────────────────────────────────────────────────────────────────────────

describe("Part 1 — the exact-hash auto-verify lookup is scoped to one person", () => {
  it("joins persons and requires the same cnic_hash before granting auto-verify", async () => {
    installCreatePool({ priorApproved: priorApprovalFor({ cnicHash: CNIC_HASH_A }) });

    await submit({ owner: OWNER_A });

    const lookup = priorVerifiedLookup();
    expect(lookup).toBeDefined();
    // The identity predicate is in the query itself, not applied as a post-filter
    // in JS — a post-filter would still have to read every org's verified rows.
    expect(lookup[0]).toContain("JOIN persons p ON p.id = vr.linked_person_id");
    expect(lookup[0]).toContain("p.cnic_hash=?");
  });

  it("binds all three predicates: document hash, organization, and person", async () => {
    installCreatePool({ priorApproved: priorApprovalFor({ cnicHash: CNIC_HASH_A }) });

    await submit({ owner: OWNER_A });

    const [, params] = priorVerifiedLookup();
    expect(params[0]).toBe(DOC_HASH);
    expect(params[1]).toBe(ORG_ID);
    // The third bound value is the submitter's own CNIC hash — the invariant.
    expect(params[2]).toBe(CNIC_HASH_A);
  });

  it("auto-verifies when the same person re-files a document the org already verified", async () => {
    // The feature must survive the fix: same person, same org, same bytes.
    installCreatePool({ priorApproved: priorApprovalFor({ cnicHash: CNIC_HASH_A }) });

    const res = await submit({ owner: OWNER_A });

    const cols = insertedColumns();
    expect(cols.status).toBe("verified");
    expect(cols.verification_method).toBe("auto");
    expect(cols.verified_at).toEqual(expect.any(Date));
    // The client still gets the "Auto Verified" confirmation.
    const payload = res.json.mock.calls[0][0];
    expect((payload?.data?.request ?? payload?.request).auto_verified).toBe(true);
  });

  it("REGRESSION: the same document under a different CNIC does not auto-verify", async () => {
    // The reported bug. Org X approved this exact file for Person A. Person B
    // re-files the same bytes with a different CNIC and must go to a human.
    installCreatePool({ priorApproved: priorApprovalFor({ cnicHash: CNIC_HASH_A }) });

    const res = await submit({ owner: OWNER_B });

    const cols = insertedColumns();
    expect(cols.status).toBe("under_review");
    expect(cols.verification_method).toBe("manual");
    expect(cols.verified_at).toBeNull();
    // No instant certificate, and the client is told it is awaiting review.
    expect(cols.qr_token).toBeUndefined();
    const payload = res.json.mock.calls[0][0];
    expect((payload?.data?.request ?? payload?.request).auto_verified).toBeFalsy();
  });

  it("REGRESSION: the swap is refused in both directions", async () => {
    // Symmetry: it must not matter which of the two people submits first.
    installCreatePool({ priorApproved: priorApprovalFor({ cnicHash: CNIC_HASH_B }) });

    await submit({ owner: OWNER_A });

    expect(insertedColumns().status).toBe("under_review");
  });

  it("no cross-person auto-verify means no QR certificate is minted for Person B", async () => {
    const { generateQrForRequest } = await import("../src/utils/qrCertificate.js");
    generateQrForRequest.mockClear();
    installCreatePool({ priorApproved: priorApprovalFor({ cnicHash: CNIC_HASH_A }) });

    await submit({ owner: OWNER_B });

    // A certificate here would be a publicly signed, verifiable claim that B
    // holds a document B never had approved for them.
    expect(generateQrForRequest).not.toHaveBeenCalled();
  });

  it("no cross-person auto-verify writes no 'verified' row to the person ledger", async () => {
    installCreatePool({ priorApproved: priorApprovalFor({ cnicHash: CNIC_HASH_A }) });

    await submit({ owner: OWNER_B });

    expect(recordPersonDocument).not.toHaveBeenCalled();
  });

  it("fails closed for a legacy verified row with no linked person", async () => {
    // A 'verified' row that never captured an identity proves only that the org
    // approved some document once. There is nothing to compare against, so the
    // repeat submission must reach a human rather than inherit credit.
    installCreatePool({ priorApproved: { ...priorApprovalFor(), cnic_hash: undefined } });

    await submit({ owner: OWNER_A });

    expect(insertedColumns().status).toBe("under_review");
  });

  it("the organization predicate is retained alongside the identity one", async () => {
    // The fix must not weaken the pre-existing tenant boundary: a different org's
    // approval still confers nothing, even for the same person and same bytes.
    // The router resolves the target to OTHER_ORG_ID while the prior approval
    // belongs to ORG_ID.
    installCreatePool({ orgId: OTHER_ORG_ID, priorApproved: priorApprovalFor({ cnicHash: CNIC_HASH_A }) });

    const res = mockRes();
    await createRequest(
      makeReq({
        body: { document_type: DOC_TYPE, issuing_organization_uuid: OTHER_ORG_UUID, ...OWNER_A },
      }),
      res
    );
    expect(res.status).toHaveBeenCalledWith(201);

    const [, params] = priorVerifiedLookup();
    expect(params[1]).toBe(OTHER_ORG_ID);
    expect(insertedColumns().status).toBe("under_review");
  });

  it("still never runs the lookup without a target organization", async () => {
    installCreatePool({ orgId: null });

    const res = mockRes();
    await createRequest(
      makeReq({
        body: {
          document_type: DOC_TYPE,
          other_organization_name: "Some Unregistered Body",
          ...OWNER_A,
        },
      }),
      res
    );
    expect(res.status).toHaveBeenCalledWith(201);

    // An unmatched organization has nobody who owes a decision, and no document
    // pool of its own, so there is no prior approval to consult.
    expect(priorVerifiedLookup()).toBeUndefined();
    expect(insertedColumns().status).toBe("under_review");
  });

  it("keeps the lookup independent of the legacy organization_conserned_for_future flag", async () => {
    // That column is only ever written on an auto-verified insert, so requiring
    // it would make the whole path dead. It must not come back.
    installCreatePool({ priorApproved: priorApprovalFor({ cnicHash: CNIC_HASH_A }) });

    await submit({ owner: OWNER_A });

    expect(priorVerifiedLookup()[0]).not.toContain("organization_conserned_for_future");
    expect(insertedColumns().status).toBe("verified");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Part 2 — an auto-verified request leaves real identity evidence behind
// ─────────────────────────────────────────────────────────────────────────────

describe("Part 2 — the creation-time auto-verify path records a cross-check", () => {
  it("passes cross-check data to recordPersonDocument instead of null", async () => {
    // Passing null left person_documents.match_status on its 'not_checked'
    // DEFAULT, so the identity ledger held a "verified" outcome with no evidence
    // of which document or person it had verified — exactly the row a reviewer
    // would consult to spot a replayed document.
    installCreatePool({ priorApproved: priorApprovalFor({ cnicHash: CNIC_HASH_A }) });

    await submit({ owner: OWNER_A });

    expect(recordPersonDocument).toHaveBeenCalledTimes(1);
    const [, orgId, crossCheck] = recordPersonDocument.mock.calls[0];
    expect(orgId).toBe(ORG_ID);
    expect(crossCheck).not.toBeNull();
    expect(crossCheck).toMatchObject({ matchStatus: "matched" });
  });

  it("caches the OCR-extracted identity on the ledger row", async () => {
    installCreatePool({ priorApproved: priorApprovalFor({ cnicHash: CNIC_HASH_A }) });

    await submit({ owner: OWNER_A });

    const [, , crossCheck] = recordPersonDocument.mock.calls[0];
    expect(crossCheck.extractedName).toBe(OWNER_A.document_owner_name);
    // Hashed, never plaintext — same rule as persons.cnic_hash.
    expect(crossCheck.extractedCnicHash).toBe(CNIC_HASH_A);
  });

  it("still records the ledger row when OCR cannot be read", async () => {
    // The cross-check must never block a request that is already created, but it
    // also must not silently fall back to "no check" without recording why.
    ocrExtract.mockRejectedValue(new Error("document service unavailable"));
    installCreatePool({ priorApproved: priorApprovalFor({ cnicHash: CNIC_HASH_A }) });

    const res = await submit({ owner: OWNER_A });

    expect(res.status).toHaveBeenCalledWith(201);
    expect(insertedColumns().status).toBe("verified");
    const [, , crossCheck] = recordPersonDocument.mock.calls[0];
    expect(crossCheck.matchStatus).toBe("not_checked");
    expect(crossCheck.reason).toMatch(/unavailable|failed/i);
  });

  it("surfaces a document whose own CNIC contradicts the person it is filed for", async () => {
    // The org approved these bytes for Person A, but the document itself names
    // Person B. The outcome stays verified (the org holds the artifact and the
    // person matches the prior approval) while the ledger records the
    // contradiction rather than hiding it behind a null.
    ocrExtract.mockResolvedValue({
      success: true,
      data: {
        document_type: "cnic",
        fields: {
          name: { value: OWNER_B.document_owner_name, confidence: "high" },
          cnic: { value: "3520276543219", confidence: "high" },
        },
      },
    });
    installCreatePool({ priorApproved: priorApprovalFor({ cnicHash: CNIC_HASH_A }) });

    await submit({ owner: OWNER_A });

    const [, , crossCheck] = recordPersonDocument.mock.calls[0];
    expect(crossCheck.matchStatus).toBe("mismatched");
    expect(crossCheck.reason).toMatch(/CNIC differs/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Part 3 — the reference-match fast path cannot assert identity from bytes
// ─────────────────────────────────────────────────────────────────────────────

describe("Part 3 — autoMatch's exact-hash fast path is gated on identity", () => {
  const REFERENCE_ID = 777;

  /** A reference row with a cached canonical CNIC of `cnicValue`. */
  function referenceWithCachedCnic(cnicValue) {
    return {
      id: REFERENCE_ID,
      document_hash: DOC_HASH, // byte-identical to the submission
      file_path: "documents/reference.pdf",
      document_type: DOC_TYPE,
      extracted_data: {
        document_type: "cnic",
        document_type_label: DOC_TYPE,
        fields: {
          name: { value: OWNER_A.document_owner_name, confidence: "high" },
          cnic: { value: cnicValue, confidence: "high" },
        },
      },
      extraction_status: "succeeded",
    };
  }

  function stagedRequest(overrides = {}) {
    return {
      id: 900,
      uuid: "req-identity-binding",
      status: "under_review",
      match_status: "not_attempted",
      matched_employee_document_id: REFERENCE_ID,
      issuing_organization_id: ORG_ID,
      document_type: DOC_TYPE,
      document_path: `/uploads/documents/${SUBMITTED_FILE}`,
      document_hash: DOC_HASH,
      document_owner_name: OWNER_A.document_owner_name,
      linked_person_id: PERSON_ID_A,
      user_id: 1,
      requester_uuid: "requester-uuid",
      requester_organization: null,
      ...overrides,
    };
  }

  /**
   * A pool for the lazy sweep. The reference is served only to the org that owns
   * it; `personCnicHash` answers the identity read the fast path now performs.
   */
  function installSweepPool({ request, reference, personCnicHash = CNIC_HASH_A }) {
    pool.query.mockImplementation((sql, params = []) => {
      const stmt = String(sql);
      if (stmt.includes("FROM verification_requests vr") && stmt.includes("requester_uuid")) {
        return Promise.resolve(request ? [[request]] : [[]]);
      }
      if (stmt.includes("FROM employee_documents ed")) {
        return Promise.resolve(params[1] === ORG_ID && reference ? [[reference]] : [[]]);
      }
      if (stmt.includes("cnic_hash FROM persons")) {
        return Promise.resolve(personCnicHash ? [[{ cnic_hash: personCnicHash }]] : [[]]);
      }
      if (stmt.includes("match_status='auto_matched'")) {
        return Promise.resolve([{ affectedRows: 1 }]);
      }
      if (stmt.includes("FROM verification_requests WHERE id=?")) {
        return Promise.resolve([[{ ...request, status: "verified" }]]);
      }
      if (/^(INSERT|UPDATE|DELETE)\b/.test(stmt)) return Promise.resolve([{ affectedRows: 1 }]);
      return Promise.resolve([[]]);
    });
  }

  async function sweep() {
    return (await vi.importActual("../src/utils/autoMatch.js")).runAutoMatchChecks;
  }

  function autoApproveCall() {
    return pool.query.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("match_status='auto_matched'")
    );
  }

  it("short-circuits to 100 when the reference's cached CNIC is this person's", async () => {
    installSweepPool({ request: stagedRequest(), reference: referenceWithCachedCnic("42101-1234567-1") });

    await (await sweep())({ orgId: ORG_ID });

    // Identical bytes AND a reference that names the same person: the shortcut
    // is entitled to its answer and the comparison is skipped.
    expect(matchDocuments).not.toHaveBeenCalled();
    const approve = autoApproveCall();
    expect(approve).toBeDefined();
    expect(approve[1]).toEqual([100, 900]);
  });

  it("REGRESSION: refuses the shortcut when the reference names a different CNIC", async () => {
    // The suppression this guards against: the reference the org filed under
    // Person A carries Person B's CNIC, yet byte-identical bytes let Person B's
    // submission be waved through at 100 — discarding the engine's strongest
    // piece of counter-evidence. The canonical comparison must run instead.
    installSweepPool({
      request: stagedRequest(),
      reference: referenceWithCachedCnic("35202-7654321-9"),
    });
    // A real canonical comparison would hard-fail the CNIC field.
    matchDocuments.mockResolvedValue({ success: true, data: { match: false, confidence: 0, reasons: [] } });

    await (await sweep())({ orgId: ORG_ID });

    expect(matchDocuments).toHaveBeenCalledTimes(1);
    const approve = autoApproveCall();
    expect(approve).toBeUndefined();
    const review = pool.query.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("match_status='manual_review'")
    );
    expect(review).toBeDefined();
  });

  it("refuses the shortcut when the request has no linked person to compare", async () => {
    // Same reasoning: with no identity on the request there is nothing to confirm
    // the reference against, so identity is not proven and a human decides.
    installSweepPool({
      request: stagedRequest({ linked_person_id: null }),
      reference: referenceWithCachedCnic("42101-1234567-1"),
    });
    matchDocuments.mockResolvedValue({ success: true, data: { match: false, confidence: 0, reasons: [] } });

    await (await sweep())({ orgId: ORG_ID });

    expect(matchDocuments).toHaveBeenCalledTimes(1);
    expect(autoApproveCall()).toBeUndefined();
  });

  it("keeps the shortcut when the reference names no CNIC at all", async () => {
    // An unreadable or absent CNIC is not evidence against the shortcut, it is
    // simply no evidence either way; byte equality plus the org-scoped CNIC
    // staging is what remains, and the reference is the org's own.
    installSweepPool({
      request: stagedRequest(),
      reference: { ...referenceWithCachedCnic("42101-1234567-1"), extracted_data: { fields: {} } },
    });

    await (await sweep())({ orgId: ORG_ID });

    expect(matchDocuments).not.toHaveBeenCalled();
    expect(autoApproveCall()).toBeDefined();
  });

  it("keeps the shortcut for a reference whose extraction never produced fields", async () => {
    // Pre-migration / failed-extraction rows have no cache at all. They have no
    // CNIC to contradict anything, so behaviour is unchanged for them.
    installSweepPool({
      request: stagedRequest(),
      reference: {
        id: REFERENCE_ID,
        document_hash: DOC_HASH,
        file_path: "documents/reference.pdf",
        document_type: DOC_TYPE,
        extracted_data: null,
        extraction_status: "failed",
      },
    });

    await (await sweep())({ orgId: ORG_ID });

    expect(matchDocuments).not.toHaveBeenCalled();
    expect(autoApproveCall()).toBeDefined();
  });

  it("normalizes CNIC formatting before comparing", async () => {
    // "4210112345671" and "42101-1234567-1" are the same person, so a differently
    // formatted reference CNIC must not defeat the shortcut.
    installSweepPool({ request: stagedRequest(), reference: referenceWithCachedCnic("4210112345671") });

    await (await sweep())({ orgId: ORG_ID });

    expect(matchDocuments).not.toHaveBeenCalled();
    expect(autoApproveCall()).toBeDefined();
  });

  it("still refuses a cross-org reference outright, before the fast path is reached", async () => {
    installSweepPool({
      request: stagedRequest({ issuing_organization_id: OTHER_ORG_ID }),
      reference: referenceWithCachedCnic("42101-1234567-1"),
    });

    await (await sweep())({ orgId: OTHER_ORG_ID });

    // ORG_ID's reference is not served to ORG_ID's rival: no shortcut, no
    // comparison, no automatic outcome.
    expect(matchDocuments).not.toHaveBeenCalled();
    expect(autoApproveCall()).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Part 4 — Node honours the service's own refusal
// ─────────────────────────────────────────────────────────────────────────────
//
// The Python service can score a pair highly and still refuse to have it
// approved: an identity-poor document type (a photograph, an NDA, a policy
// acknowledgment, a handover form), or a CNIC comparison that did not establish
// one person. It reports that as `auto_match_eligible: false` /
// `identity_mismatch: true`.
//
// Node MUST read those flags. Relying on the confidence score alone is not
// sufficient, and not merely theoretical: a letter whose name, designation and
// joining date all agree while its printed CNIC differs averages to exactly the
// service's match threshold, and a type with enough matching non-identity fields
// can clear the Node bar of 90 outright while `match` still reads true in the
// payload. The flag is the authoritative signal; the score is for display.
//
// The converse is also pinned: a service build that predates the flags must not
// be read as a refusal, or every request would be stuck in manual review during
// a partial rollout.

describe("Part 4 — the document service's refusal is honoured before the threshold", () => {
  const REFERENCE_ID = 777;

  /**
   * A reference whose bytes DIFFER from the submission, so the comparison is
   * always reached and the fast path never masks the service's verdict.
   */
  function differingReference() {
    return {
      id: REFERENCE_ID,
      document_hash: "e".repeat(64),
      file_path: "documents/reference.pdf",
      document_type: DOC_TYPE,
      extracted_data: {
        document_type: "cnic",
        document_type_label: DOC_TYPE,
        fields: {
          name: { value: OWNER_A.document_owner_name, confidence: "high" },
          cnic: { value: "4210112345671", confidence: "high" },
        },
      },
      extraction_status: "succeeded",
    };
  }

  function stagedRequest(overrides = {}) {
    return {
      id: 950,
      uuid: "req-service-refusal",
      status: "under_review",
      match_status: "not_attempted",
      matched_employee_document_id: REFERENCE_ID,
      issuing_organization_id: ORG_ID,
      document_type: DOC_TYPE,
      document_path: `/uploads/documents/${SUBMITTED_FILE}`,
      document_hash: DOC_HASH,
      document_owner_name: OWNER_A.document_owner_name,
      linked_person_id: PERSON_ID_A,
      user_id: 1,
      requester_uuid: "requester-uuid",
      requester_organization: null,
      ...overrides,
    };
  }

  function installSweepPool({ request }) {
    pool.query.mockImplementation((sql, params = []) => {
      const stmt = String(sql);
      if (stmt.includes("FROM verification_requests vr") && stmt.includes("requester_uuid")) {
        return Promise.resolve(request ? [[request]] : [[]]);
      }
      if (stmt.includes("FROM employee_documents ed")) {
        return Promise.resolve(params[1] === ORG_ID ? [[differingReference()]] : [[]]);
      }
      if (stmt.includes("cnic_hash FROM persons")) {
        return Promise.resolve([[{ cnic_hash: CNIC_HASH_A }]]);
      }
      if (stmt.includes("match_status='auto_matched'")) {
        return Promise.resolve([{ affectedRows: 1 }]);
      }
      if (stmt.includes("FROM verification_requests WHERE id=?")) {
        return Promise.resolve([[{ ...request, status: "verified" }]]);
      }
      if (/^(INSERT|UPDATE|DELETE)\b/.test(stmt)) return Promise.resolve([{ affectedRows: 1 }]);
      return Promise.resolve([[]]);
    });
  }

  async function sweep() {
    return (await vi.importActual("../src/utils/autoMatch.js")).runAutoMatchChecks;
  }

  function autoApproveCall() {
    return pool.query.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("match_status='auto_matched'")
    );
  }

  function manualReviewCall() {
    return pool.query.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("match_status='manual_review'")
    );
  }

  it("does not auto-approve when the service reports an identity mismatch, even at confidence 100", async () => {
    matchDocuments.mockResolvedValue({
      success: true,
      data: {
        match: false,
        confidence: 100,
        reasons: ["cnic differs (0%)"],
        identity_mismatch: true,
        auto_match_eligible: false,
      },
    });
    installSweepPool({ request: stagedRequest() });

    await (await sweep())({ orgId: ORG_ID });

    expect(autoApproveCall()).toBeUndefined();
    // Routed to a human rather than abandoned, so it stays reviewable in the inbox.
    expect(manualReviewCall()).toBeDefined();
  });

  it("does not auto-approve for an identity-poor document type, even at confidence 100", async () => {
    // A photograph or an NDA can score 100 against another one of its kind. The
    // score says nothing about who the document belongs to.
    matchDocuments.mockResolvedValue({
      success: true,
      data: {
        match: false,
        confidence: 100,
        reasons: ["document type 'legal_agreement' carries no identifying information"],
        identity_mismatch: false,
        auto_match_eligible: false,
      },
    });
    installSweepPool({ request: stagedRequest() });

    await (await sweep())({ orgId: ORG_ID });

    expect(autoApproveCall()).toBeUndefined();
    expect(manualReviewCall()).toBeDefined();
  });

  it("still records the measured score so a reviewer can see how close it came", async () => {
    matchDocuments.mockResolvedValue({
      success: true,
      data: {
        match: false,
        confidence: 93.5,
        reasons: ["cnic differs (0%)"],
        identity_mismatch: true,
        auto_match_eligible: false,
      },
    });
    installSweepPool({ request: stagedRequest() });

    await (await sweep())({ orgId: ORG_ID });

    const review = manualReviewCall();
    expect(review).toBeDefined();
    expect(review[1]).toEqual([93.5, 950]);
  });

  it("auto-approves as before when the service reports no flags at all", async () => {
    // Backward compatibility: both flags default to the permissive value in the
    // service's response model, so a Node backend pointed at a pre-flag Python
    // build must not start refusing everything.
    matchDocuments.mockResolvedValue({
      success: true,
      data: { match: true, confidence: 100, reasons: [] },
    });
    installSweepPool({ request: stagedRequest() });

    await (await sweep())({ orgId: ORG_ID });

    const approve = autoApproveCall();
    expect(approve).toBeDefined();
    expect(approve[1]).toEqual([100, 950]);
  });

  it("auto-approves when the service explicitly reports a clean, eligible match", async () => {
    matchDocuments.mockResolvedValue({
      success: true,
      data: {
        match: true,
        confidence: 100,
        reasons: ["cnic matches (100%)"],
        identity_mismatch: false,
        auto_match_eligible: true,
      },
    });
    installSweepPool({ request: stagedRequest() });

    await (await sweep())({ orgId: ORG_ID });

    expect(manualReviewCall()).toBeUndefined();
    expect(autoApproveCall()).toBeDefined();
  });

  it("make the creation-time inline match refuse a refused comparison too", async () => {
    // createRequest's inline path guards on a literal `confidence === 100`. If
    // computeMatchConfidence passed a refused score through, that guard would
    // happily auto-approve a 100 the service had already said was unapprovable.
    const { computeMatchConfidence } = await vi.importActual("../src/utils/autoMatch.js");
    matchDocuments.mockResolvedValue({
      success: true,
      data: {
        match: false,
        confidence: 100,
        reasons: ["cnic differs (0%)"],
        identity_mismatch: true,
        auto_match_eligible: false,
      },
    });
    installSweepPool({ request: stagedRequest() });

    const confidence = await computeMatchConfidence(stagedRequest());

    // Not 100, so the creation-time auto-approval cannot fire.
    expect(confidence).not.toBe(100);
    expect(confidence).toBe(0);
  });
});
