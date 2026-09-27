import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// In-memory DB that actually implements transaction semantics.
//
// The regression being guarded is "a rejected document burns the org's daily
// quota". Asserting that needs the fake to distinguish two states that a plain
// call-recording mock conflates:
//
//   (a) the usage row was incremented and left committed, vs
//   (b) the usage row was incremented inside a transaction that then rolled back.
//
// So the fake mirrors InnoDB: queries mutate a per-transaction working copy,
// commit() promotes it to committed state, and rollback() discards it. Only the
// committed state is what `committedUsage()` reports, exactly like a re-read by
// a separate connection would see.
// ---------------------------------------------------------------------------
const { dbRef, validateMock } = vi.hoisted(() => ({ dbRef: { current: null }, validateMock: vi.fn() }));

vi.mock("../src/config/db.js", () => ({
  pool: {
    get query() {
      return dbRef.current.poolQuery;
    },
    getConnection: async () => dbRef.current.connection,
  },
}));

vi.mock("../src/utils/documentValidate.js", () => ({
  assertDocumentValid: validateMock,
  // The controller imports these as values, so a partial mock that omits them
  // breaks the module graph at import time.
  VALIDATION_PASSED: "passed",
  VALIDATION_FLAGGED: "flagged",
  VALIDATION_UNVALIDATED: "unvalidated",
}));
vi.mock("../src/utils/qrCertificate.js", () => ({
  generateQrForRequest: vi.fn().mockResolvedValue(undefined),
}));

import { createRequest } from "../src/controllers/verification.controller.js";
import { DOCS_DIR } from "../src/config/uploadPaths.js";
import { todayStr } from "../src/utils/requestQuota.js";

const REQUESTER_ORG = 7; // req.user.organization -> the org whose quota burns
const ORG_UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OWNER = { document_owner_name: "Asim Khan", document_owner_cnic: "42101-1234567-1" };

// Baseline: the org has already burned 3 of its 10 paid requests today.
const START_USAGE = { requests_used: 3, total_requests: 9 };

const DOC_FILENAME = `doc_quota_${process.pid}.pdf`;
const DUMMY_FILE = path.join(DOCS_DIR, DOC_FILENAME);

const CREATED_ROW = {
  id: 1,
  uuid: "cccccccc-dddd-4eee-8fff-000000000001",
  document_type: "Degree",
  status: "under_review",
  document_owner_name: OWNER.document_owner_name,
  issuing_organization_uuid: ORG_UUID,
  issuing_org_name: "Acme",
  unmatched_org_uuid: null,
  unmatched_org_name: null,
};

function makeFakeDb({ startUsage = START_USAGE, failRequestInsert = false, quota = 10 } = {}) {
  // The only state a separate connection could ever observe.
  const committed = { usage: { ...startUsage }, requests: [] };
  const calls = { begin: 0, commit: 0, rollback: 0, release: 0, usageIncrements: 0 };
  let working = null; // null == no open transaction

  const clone = (v) => JSON.parse(JSON.stringify(v));

  const connectionQuery = vi.fn(async (sql) => {
    if (!working) {
      throw new Error("query ran on the transaction connection outside any transaction");
    }
    const stmt = String(sql).trim();

    // --- enforceRequestQuota ---
    if (stmt.includes("FROM organizations o")) {
      return [[{
        subscription_status: "active",
        subscription_expiry: "2099-01-01 00:00:00",
        // The production SELECT aliases daily_request_quota AS quota, and
        // enforceRequestQuota reads org.quota -- so the key must be `quota`.
        quota,
        is_free: 0,
      }]];
    }
    if (stmt.includes("INSERT INTO daily_request_usage")) return [{ affectedRows: 1 }];
    if (stmt.includes("SELECT requests_used")) return [[{ ...working.usage }]];
    if (stmt.includes("UPDATE daily_request_usage SET requests_used = requests_used + 1")) {
      working.usage.requests_used += 1;
      working.usage.total_requests += 1;
      calls.usageIncrements += 1;
      return [{ affectedRows: 1 }];
    }
    if (stmt.includes("UPDATE daily_request_usage SET total_requests = 1")) {
      working.usage.total_requests = 1;
      calls.usageIncrements += 1;
      return [{ affectedRows: 1 }];
    }

    // --- request creation ---
    if (stmt.includes("INSERT INTO verification_requests")) {
      if (failRequestInsert) {
        // Anything at all can fail here; a deadlock is the realistic case that
        // the old code could not recover from, because the quota had already
        // been committed on its own connection.
        throw new Error("ER_LOCK_DEADLOCK: Deadlock found when trying to get lock");
      }
      working.requests.push({ id: 1 });
      return [{ insertId: 1, affectedRows: 1 }];
    }
    if (stmt.includes("FROM employees")) return [[]]; // no reference match
    if (stmt.includes("SET match_status=")) return [{ affectedRows: 1 }];
    if (stmt.includes("FROM persons")) return [[]]; // person not seen before
    if (stmt.includes("INSERT INTO persons")) return [{ insertId: 99, affectedRows: 1 }];
    if (stmt.includes("SET linked_person_id")) return [{ affectedRows: 1 }];
    if (stmt.includes("issuing_org_name")) return [[{ ...CREATED_ROW }]];

    return [{ affectedRows: 1 }];
  });

  const connection = {
    query: connectionQuery,
    beginTransaction: vi.fn(async () => {
      calls.begin += 1;
      working = clone(committed);
    }),
    commit: vi.fn(async () => {
      calls.commit += 1;
      committed.usage = { ...working.usage };
      committed.requests = [...working.requests];
      working = null;
    }),
    rollback: vi.fn(async () => {
      calls.rollback += 1;
      working = null; // working copy discarded -> usage reverts
    }),
    release: vi.fn(() => {
      calls.release += 1;
    }),
  };

  // Reads/writes the controller performs OUTSIDE the transaction.
  const poolQuery = vi.fn(async (sql) => {
    const stmt = String(sql).trim();
    if (stmt.includes("SELECT id FROM organizations WHERE uuid=")) return [[{ id: 10 }]];
    if (stmt.includes("FROM verification_requests") && stmt.includes("document_hash=?")) return [[]];
    if (stmt.includes("INSERT INTO audit_logs")) return [{ affectedRows: 1 }];
    // Any other read returns no rows (e.g. the post-commit notification
    // recipient lookup); any other write reports a single affected row.
    if (/^(INSERT|UPDATE|DELETE)\b/.test(stmt)) return [{ affectedRows: 1 }];
    return [[]];
  });

  return {
    poolQuery,
    connection,
    calls,
    /** What a fresh connection would read: only committed state counts. */
    committedUsage: () => ({ ...committed.usage }),
    committedRequests: () => [...committed.requests],
  };
}

function makeReq() {
  return {
    body: { document_type: "Degree", issuing_organization_uuid: ORG_UUID, ...OWNER },
    user: { id: 1, org_role: "org_admin", organization: REQUESTER_ORG },
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
  dbRef.current = makeFakeDb();
  // A passing validation verdict (the new tiered shape), not a bare undefined:
  // the controller destructures { status, reason } from the resolved value.
  validateMock.mockResolvedValue({ status: "passed", reason: null, checkType: "structural", data: null });
});

// ---------------------------------------------------------------------------

describe("createRequest — rejected upload must not burn the daily quota", () => {
  it("leaves daily_request_usage unchanged when the document fails validation", async () => {
    dbRef.current = makeFakeDb();
    const db = dbRef.current;
    validateMock.mockRejectedValue(
      Object.assign(new Error("The scan is too dark or low-contrast to process"), { statusCode: 400 })
    );

    const before = db.committedUsage();
    await expect(createRequest(makeReq(), mockRes())).rejects.toThrow(/too dark or low-contrast/);

    // The whole point of the regression: the count is identical, i.e. neither
    // incremented-then-stuck nor decremented afterwards.
    expect(db.committedUsage()).toEqual(before);
    expect(db.committedUsage()).toEqual({ requests_used: 3, total_requests: 9 });
    expect(db.committedRequests()).toEqual([]);

    // Nothing was ever consumed, so there is no increment to undo.
    expect(db.calls.usageIncrements).toBe(0);
  });

  it("does not open a transaction at all for a document that fails validation", async () => {
    dbRef.current = makeFakeDb();
    const db = dbRef.current;
    validateMock.mockRejectedValue(Object.assign(new Error("cropped"), { statusCode: 400 }));

    await expect(createRequest(makeReq(), mockRes())).rejects.toThrow();

    // Validation is a pure external check, so it is evaluated before any row
    // lock is taken. This keeps a multi-second OCR call from pinning the org's
    // FOR UPDATE locks while still guaranteeing the quota is untouched.
    expect(db.calls.begin).toBe(0);
    expect(db.calls.usageIncrements).toBe(0);
    expect(db.committedUsage()).toEqual(START_USAGE);
  });
});

describe("createRequest — quota consumption and request INSERT are one transaction", () => {
  it("rolls the quota back when the request INSERT fails after the quota was consumed", async () => {
    dbRef.current = makeFakeDb({ failRequestInsert: true });
    const db = dbRef.current;
    const before = db.committedUsage();

    await expect(createRequest(makeReq(), mockRes())).rejects.toThrow(/ER_LOCK_DEADLOCK/);

    // The increment happened inside the transaction...
    expect(db.calls.usageIncrements).toBe(1);
    // ...and was undone, so the persisted count never moved.
    expect(db.committedUsage()).toEqual(before);
    expect(db.committedRequests()).toEqual([]);

    expect(db.calls.rollback).toBe(1);
    expect(db.calls.commit).toBe(0);
    expect(db.calls.release).toBe(1);
  });

  it("leaves the quota unchanged and inserts nothing when the org is out of quota", async () => {
    // START_USAGE.requests_used (3) is already at the plan quota of 3.
    dbRef.current = makeFakeDb({ startUsage: { requests_used: 3, total_requests: 9 }, quota: 3 });
    const db = dbRef.current;
    const before = db.committedUsage();

    await expect(createRequest(makeReq(), mockRes())).rejects.toThrow(
      expect.objectContaining({ statusCode: 429 })
    );

    expect(db.committedUsage()).toEqual(before);
    expect(db.committedRequests()).toEqual([]);
    expect(db.calls.usageIncrements).toBe(0);
    // enforceRequestQuota must not commit/rollback on a connection it does not
    // own; the controller's catch block is the single place that unwinds.
    expect(db.calls.rollback).toBe(1);
    expect(db.calls.commit).toBe(0);
    expect(db.calls.release).toBe(1);
  });

  it("still consumes the quota and commits the request on the happy path", async () => {
    dbRef.current = makeFakeDb();
    const db = dbRef.current;
    const res = mockRes();

    await createRequest(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(201);
    // Control case: the fix must not make quota consumption a no-op.
    expect(db.committedUsage()).toEqual({ requests_used: 4, total_requests: 10 });
    expect(db.committedRequests()).toHaveLength(1);
    expect(db.calls.usageIncrements).toBe(1);
    expect(db.calls.commit).toBe(1);
    expect(db.calls.rollback).toBe(0);
    expect(db.calls.release).toBe(1);
  });

  it("runs the quota consumption and the request INSERT on the same connection", async () => {
    dbRef.current = makeFakeDb();
    const db = dbRef.current;

    await createRequest(makeReq(), mockRes());

    // Quota statement and the request INSERT must both be issued on the
    // transaction connection, never on the shared pool.
    const onConnection = db.connection.query.mock.calls.map(([sql]) => String(sql));
    expect(onConnection.some((s) => s.includes("UPDATE daily_request_usage SET requests_used"))).toBe(true);
    expect(onConnection.some((s) => s.includes("INSERT INTO verification_requests"))).toBe(true);

    // Neither of those may leak onto the pool, or they would escape the
    // transaction and be committed immediately.
    const onPool = db.poolQuery.mock.calls.map(([sql]) => String(sql));
    expect(onPool.some((s) => s.includes("UPDATE daily_request_usage"))).toBe(false);
    expect(onPool.some((s) => s.includes("INSERT INTO verification_requests"))).toBe(false);
  });

  it("scopes the usage bucket to today's date so the counter stays per-day", async () => {
    dbRef.current = makeFakeDb();
    const db = dbRef.current;

    await createRequest(makeReq(), mockRes());

    const usageCall = db.connection.query.mock.calls.find(([sql]) =>
      String(sql).includes("SELECT requests_used")
    );
    expect(usageCall[1]).toEqual([REQUESTER_ORG, todayStr()]);
  });
});
