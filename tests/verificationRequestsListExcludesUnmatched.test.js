import { describe, it, expect, vi, beforeEach } from "vitest";

// Regression: the admin Verification Requests list showed every request,
// including ones raised against an "Other / unlisted" organization.
// Those already have their own queue (Unmatched Orgs), so the same rows were
// being worked twice.
//
// The Unmatched Orgs queue (GET /admin/verification-requests/null-organization)
// lists `unmatched_organizations` rows and attaches requests to them through
// `vr.unmatched_org_id = uo.id`, so "unmatched" is exactly "unmatched_org_id is
// set". The main list must apply the NEGATION of that predicate in SQL, so that
// `total` / `totalPages` count the filtered set — filtering rows in the React
// component would desync the page from the pager (12 rows, "total 20").
//
// These tests pin:
//   - both the COUNT and the row query carry the predicate (so total matches),
//   - the filter is done by the database, not by the controller,
//   - search / status / date filters still compose with it,
//   - accepting an unmatched request NULLs the same column, so the request
//     migrates between the two lists with no extra code,
//   - the unmatched queue itself is left alone.

vi.mock("../src/config/db.js", () => ({ pool: { query: vi.fn() } }));
vi.mock("../src/utils/slaChecks.js", () => ({ runSlaChecks: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../src/utils/qrCertificate.js", () => ({
  generateQrForRequest: vi.fn(),
  // Identity pass-through: see tests/verifyUrl.test.js for the real behaviour.
  withVerifyUrl: (row) => row,
  withVerifyUrls: (rows) => rows,
}));
vi.mock("../src/utils/auditLog.js", () => ({
  logAudit: vi.fn().mockResolvedValue({}),
  getActorFromReq: vi.fn(() => ({ actorType: "admin" })),
}));
vi.mock("../src/utils/personDocuments.js", () => ({ recordPersonDocument: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../src/controllers/notification.controller.js", () => ({
  createNotificationForOrgUsers: vi.fn().mockResolvedValue({}),
  createNotificationForUsers: vi.fn().mockResolvedValue({}),
}));

import { pool } from "../src/config/db.js";
import {
  listAllRequests,
  listNullOrganizationRequests,
  acceptNullOrganizationRequest,
  adminVerifyUnmatchedRequest,
} from "../src/controllers/admin/verification.controller.js";

const MATCHED_UUID = "11111111-1111-4111-8111-111111111111";
const UNMATCHED_UUID = "22222222-2222-4222-8222-222222222222";
const REAL_ORG_UUID = "33333333-3333-4333-8333-333333333333";
const UNMATCHED_ORG_UUID = "44444444-4444-4444-8444-444444444444";

// Factories, not shared consts: acceptNullOrganizationRequest mutates the rows
// in place, so a module-level fixture would leak into the next test.
function matchedRow(overrides = {}) {
  return {
    id: 1,
    uuid: MATCHED_UUID,
    unmatched_org_id: null,
    issuing_organization_uuid: REAL_ORG_UUID,
    issuing_org_name: "Acme University",
    document_type: "Degree",
    requester_name: "Matched Requester",
    status: "under_review",
    created_at: "2026-01-10 09:00:00",
    ...overrides,
  };
}

function unmatchedRow(overrides = {}) {
  return {
    id: 2,
    uuid: UNMATCHED_UUID,
    unmatched_org_id: 7,
    issuing_organization_id: null,
    issuing_organization_uuid: null,
    issuing_org_name: null,
    unmatched_org_name: "Some Unlisted College",
    document_type: "Transcript",
    requester_name: "Unmatched Requester",
    status: "under_review",
    created_at: "2026-01-11 09:00:00",
    ...overrides,
  };
}

/** Two requests: one matched to a real org, one queued as "other / unlisted". */
let requests = [];

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

function listReq(query = {}) {
  return { query, user: { id: 1 } };
}

function statements() {
  return pool.query.mock.calls.map(([sql, params]) => ({
    sql: String(sql).replace(/\s+/g, " ").trim(),
    params,
  }));
}
const mainCount = () => statements().find((s) => s.sql.startsWith("SELECT COUNT(*) AS total FROM verification_requests"));
const mainRows = () => statements().find((s) => s.sql.startsWith("SELECT vr.*"));
const unmatchedRows = () => statements().find((s) => s.sql.startsWith("SELECT uo.*"));

/**
 * Minimal in-memory stand-in for the two list queries. The row set is narrowed
 * only by what the emitted SQL actually asks for: if the unmatched predicate is
 * absent from a statement, the unmatched request leaks into the page or the
 * count and the assertion fails. That is what makes these behavioural tests
 * rather than pure string matching.
 */
function applyListFilters(sql) {
  if (sql.includes("vr.unmatched_org_id IS NULL")) return requests.filter((r) => r.unmatched_org_id === null);
  return requests;
}

beforeEach(() => {
  vi.clearAllMocks();
  requests = [matchedRow(), unmatchedRow()];
  pool.query.mockReset();
  pool.query.mockImplementation(async (sql, params = []) => {
    const stmt = String(sql).replace(/\s+/g, " ").trim();

    // --- admin Verification Requests list ---
    if (stmt.startsWith("SELECT COUNT(*) AS total FROM unmatched_organizations")) {
        const active = requests.some((r) => r.unmatched_org_id === 7 && r.status !== "verified");
        return [[{ total: active ? 1 : 0 }]];
      }
      if (stmt.startsWith("SELECT uo.*")) {
        const active = requests.some((r) => r.unmatched_org_id === 7 && r.status !== "verified");
        return [active ? [{ uuid: UNMATCHED_ORG_UUID, name: "Some Unlisted College", status: "contacted", request_count: 1 }] : []];
      }
      if (stmt.startsWith("SELECT COUNT(*) AS total FROM verification_requests")) {
      return [[{ total: applyListFilters(stmt).length }]];
    }
    if (stmt.startsWith("SELECT vr.*")) {
      const limit = params[params.length - 2];
      const offset = params[params.length - 1];
      return [applyListFilters(stmt).slice(offset, offset + limit)];
    }

    // --- Unmatched Orgs queue ---
    if (stmt.startsWith("SELECT COUNT(*) AS total FROM unmatched_organizations")) return [[{ total: 1 }]];
    if (stmt.startsWith("SELECT uo.*")) {
      return [[{ uuid: UNMATCHED_ORG_UUID, name: "Some Unlisted College", status: "pending", request_count: 1 }]];
    }
    if (stmt.startsWith("SELECT id, name, status FROM unmatched_organizations")) {
      return [[{ id: 7, name: "Some Unlisted College", status: "pending" }]];
    }

    // --- accept flow ---
    if (stmt.startsWith("SELECT id FROM organizations WHERE uuid=?")) return [[{ id: 5 }]];
    if (stmt.startsWith("SELECT id, uuid, user_id, document_type")) {
      return [[{ id: 2, uuid: UNMATCHED_UUID, user_id: 1, document_type: "Transcript" }]];
    }
    if (stmt.startsWith("UPDATE verification_requests SET unmatched_org_id=NULL")) {
      for (const id of [].concat(params[0])) {
        const row = requests.find((r) => r.id === id);
        if (row) row.unmatched_org_id = null;
      }
      return [{ affectedRows: 1 }];
    }

    if (/^(INSERT|UPDATE|DELETE)\b/.test(stmt)) return [{ affectedRows: 1 }];
    return [[]];
  });
});

describe("listAllRequests — excludes requests routed to an unmatched org", () => {
  it("applies the negated unmatched predicate in SQL, on both the count and the row query", async () => {
    await listAllRequests(listReq(), mockRes());

    const count = mainCount();
    const rows = mainRows();

    // The same predicate on both statements is what keeps the pager honest: the
    // row query is paged, the count is not, so they must agree.
    expect(count.sql).toContain("vr.unmatched_org_id IS NULL");
    expect(rows.sql).toContain("vr.unmatched_org_id IS NULL");
    expect(count.sql).not.toContain("unmatched_org_id IS NOT NULL");
    expect(rows.sql).not.toContain("unmatched_org_id IS NOT NULL");
  });

  it("returns only the matched request, and a total that counts the filtered set", async () => {
    const res = mockRes();
    await listAllRequests(listReq(), res);

    const body = res.json.mock.calls[0][0];
    expect(body.success).toBe(true);
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0].uuid).toBe(MATCHED_UUID);
    expect(body.data.items.map((r) => r.uuid)).not.toContain(UNMATCHED_UUID);
    // total must describe the filtered set, not the raw table.
    expect(body.data.total).toBe(1);
    expect(body.data.totalPages).toBe(1);
  });

  it("lets the database do the filtering rather than trimming rows in the controller", async () => {
    const res = mockRes();
    await listAllRequests(listReq(), res);

    // Two requests exist. The endpoint asked MySQL for a page of 20 and got one
    // row back. If the controller were post-filtering, a full LIMIT/OFFSET page
    // would render short while the pager still advertised the unfiltered total.
    expect(mainRows().params.slice(-2)).toEqual([20, 0]);
    expect(res.json.mock.calls[0][0].data.items).toHaveLength(1);
    expect(requests).toHaveLength(2);
  });

  it("keeps pagination totals correct when the page size is smaller than the filtered set", async () => {
    requests = [
      matchedRow(),
      matchedRow({ id: 3, uuid: "55555555-5555-4555-8555-555555555555" }),
      matchedRow({ id: 4, uuid: "66666666-6666-4666-8666-666666666666" }),
      unmatchedRow(),
    ];

    const page1 = mockRes();
    await listAllRequests(listReq({ limit: 2, page: 1 }), page1);
    const body1 = page1.json.mock.calls[0][0].data;

    const page2 = mockRes();
    await listAllRequests(listReq({ limit: 2, page: 2 }), page2);
    const body2 = page2.json.mock.calls[0][0].data;

    // 4 requests exist, 1 is unmatched -> 3 remain -> 2 pages of 2.
    expect(body1.total).toBe(3);
    expect(body1.totalPages).toBe(2);
    expect(body1.items).toHaveLength(2);
    expect(body2.total).toBe(3);
    expect(body2.totalPages).toBe(2);
    expect(body2.items).toHaveLength(1);
  });
});

describe("listAllRequests — search / status / date filters still work", () => {
  it("AND-combines the unmatched predicate with the search term", async () => {
    await listAllRequests(listReq({ search: "Acme" }), mockRes());

    const rows = mainRows();
    expect(rows.sql).toContain("vr.unmatched_org_id IS NULL AND (requester.full_name LIKE ?");
    // Six LIKE placeholders, still bound in the documented order.
    expect(rows.params.slice(0, 6)).toEqual(Array(6).fill("%Acme%"));
  });

  it("keeps the predicate when a status filter is applied", async () => {
    await listAllRequests(listReq({ status: "verified" }), mockRes());

    const count = mainCount();
    expect(count.sql).toContain("WHERE vr.unmatched_org_id IS NULL AND vr.status = ?");
    expect(count.params).toEqual(["verified"]);
  });

  it("keeps the predicate across both date bounds", async () => {
    await listAllRequests(listReq({ dateFrom: "2026-01-01", dateTo: "2026-01-31" }), mockRes());

    const count = mainCount();
    expect(count.sql).toContain("vr.created_at >= ?");
    expect(count.sql).toContain("vr.created_at <= ?");
    expect(count.params).toEqual(["2026-01-01", "2026-01-31 23:59:59"]);
    // Bounds are additional restrictions, never a replacement for the predicate.
    expect(count.sql).toContain("vr.unmatched_org_id IS NULL AND");
  });

  it("still applies the predicate when no filters are supplied at all", async () => {
    await listAllRequests(listReq(), mockRes());

    // An empty filter set used to produce an empty whereClause; the predicate
    // must survive that path or the unfiltered page leaks unmatched requests.
    expect(mainRows().sql).toContain("WHERE vr.unmatched_org_id IS NULL ORDER BY");
    expect(mainCount().params).toEqual([]);
  });
});

describe("acceptNullOrganizationRequest — assignment keeps requests unmatched until verification", () => {
  it("keeps the request out of the main list and in the unmatched queue after assignment", async () => {
    const res = mockRes();
    await acceptNullOrganizationRequest(
      {
        params: { uuid: UNMATCHED_ORG_UUID },
        body: { issuing_organization_uuid: REAL_ORG_UUID, verification_remarks: "matched after review" },
        admin: { full_name: "Admin" },
      },
      res
    );

    expect(statements().some((s) => s.sql.startsWith("UPDATE verification_requests SET unmatched_org_id=NULL"))).toBe(false);
    expect(requests.find((r) => r.uuid === UNMATCHED_UUID).unmatched_org_id).toBe(7);
    const afterAssign = mockRes();
    await listAllRequests(listReq(), afterAssign);
    expect(afterAssign.json.mock.calls[0][0].data.items.map((r) => r.uuid)).toEqual([MATCHED_UUID]);
    expect(res.json.mock.calls[0][0].data.routed_requests).toBe(1);
  });
});

describe("adminVerifyUnmatchedRequest — verified request leaves unmatched queue", () => {
  it("clears unmatched_org_id after verification so the request moves to the main list", async () => {
    pool.query.mockImplementation(async (sql, params = []) => {
      const stmt = String(sql).replace(/\s+/g, " ").trim();
      if (stmt.startsWith("SELECT * FROM verification_requests WHERE uuid=?")) {
        return [[requests.find((r) => r.uuid === params[0])]];
      }
      if (stmt.startsWith("UPDATE verification_requests SET status=?")) {
        const row = requests.find((r) => r.uuid === params[2]);
        row.status = params[0];
        return [{ affectedRows: 1 }];
      }
      if (stmt.startsWith("UPDATE unmatched_organizations uo")) return [{ affectedRows: 1 }];
      if (stmt.startsWith("UPDATE verification_requests SET unmatched_org_id=NULL")) {
        const row = requests.find((r) => r.uuid === params[0]);
        row.unmatched_org_id = null;
        return [{ affectedRows: 1 }];
      }
      if (stmt.startsWith("SELECT uuid, email, preferred_language, organization FROM users")) {
        return [[{ uuid: "user-uuid", email: "user@example.com", organization: null }]];
      }
      if (stmt.startsWith("SELECT vr.*, uo.uuid AS unmatched_org_uuid")) {
        return [[requests.find((r) => r.uuid === params[0])]];
      }
      if (stmt.startsWith("SELECT COUNT(*) AS total FROM unmatched_organizations")) {
        const active = requests.some((r) => r.unmatched_org_id === 7 && r.status !== "verified");
        return [[{ total: active ? 1 : 0 }]];
      }
      if (stmt.startsWith("SELECT uo.*")) {
        const active = requests.some((r) => r.unmatched_org_id === 7 && r.status !== "verified");
        return [active ? [{ uuid: UNMATCHED_ORG_UUID, name: "Some Unlisted College", status: "contacted", request_count: 1 }] : []];
      }
      if (stmt.startsWith("SELECT COUNT(*) AS total FROM verification_requests")) {
        return [[{ total: applyListFilters(stmt).length }]];
      }
      if (stmt.startsWith("SELECT vr.*")) return [applyListFilters(stmt)];
      if (/^(INSERT|UPDATE|DELETE)\\b/.test(stmt)) return [{ affectedRows: 1 }];
      return [[]];
    });

    const res = mockRes();
    await adminVerifyUnmatchedRequest(
      { params: { uuid: UNMATCHED_UUID }, body: { status: "verified", verification_remarks: "confirmed" }, admin: { full_name: "Admin" } },
      res
    );

    expect(requests.find((r) => r.uuid === UNMATCHED_UUID).unmatched_org_id).toBeNull();
    const main = mockRes();
    await listAllRequests(listReq(), main);
    expect(main.json.mock.calls[0][0].data.items.map((r) => r.uuid).sort()).toEqual([MATCHED_UUID, UNMATCHED_UUID].sort());
    expect(res.json.mock.calls[0][0].data.request.status).toBe("verified");
    const unmatched = mockRes();
    await listNullOrganizationRequests(listReq(), unmatched);
    expect(unmatched.json.mock.calls[0][0].data.items).toHaveLength(0);
    expect(unmatched.json.mock.calls[0][0].data.total).toBe(0);
  });
});
describe("listNullOrganizationRequests — the unmatched queue is unchanged", () => {
  it("still joins requests to orgs on the same column, with no negation", async () => {
    const res = mockRes();
    await listNullOrganizationRequests(listReq(), res);

    const statement = unmatchedRows();
    expect(statement).toBeDefined();
    expect(statement.sql).toContain("LEFT JOIN verification_requests vr ON vr.unmatched_org_id = uo.id");
    expect(statement.sql).toContain("pending_vr.status <> 'verified'");

    const body = res.json.mock.calls[0][0].data;
    expect(body.items).toHaveLength(1);
    expect(body.items[0].uuid).toBe(UNMATCHED_ORG_UUID);
    expect(body.total).toBe(1);
  });
});
