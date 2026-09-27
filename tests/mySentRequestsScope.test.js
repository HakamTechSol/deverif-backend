import { describe, it, expect, vi, beforeEach } from "vitest";

// GET /verification-requests/my/sent used to scope on vr.user_id, which made a
// sub-admin's submissions invisible to their org_admin — the request was not
// merely hidden from a filter, it was simply absent from the org's own history.
//
// These tests pin the scope rule itself, and pin the one thing that would
// silently corrupt the page: the COUNT query and the row query MUST join and
// filter identically, or pagination lies (phantom pages, rows past the total).

vi.mock("../src/config/db.js", () => ({ pool: { query: vi.fn() } }));

import { pool } from "../src/config/db.js";
import { mySentRequests } from "../src/controllers/verification.controller.js";

const ORG_ID = 20;
const OTHER_ORG_ID = 99;
const ADMIN_UUID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

function req(user, query = {}) {
  return { user, query };
}

const orgAdmin = { id: 1, uuid: ADMIN_UUID, organization: ORG_ID, org_role: "org_admin" };
const subAdmin = { id: 2, uuid: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb", organization: ORG_ID, org_role: "sub_admin" };
const plainMember = { id: 3, uuid: "cccccccc-3333-4333-8333-cccccccccccc", organization: ORG_ID, org_role: "member" };
const noOrg = { id: 4, uuid: "dddddddd-4444-4444-8444-dddddddddddd", organization: null, org_role: "org_admin" };

/** The two SQL statements the controller issues, in order. */
function statements() {
  return pool.query.mock.calls.map(([sql, params]) => ({
    sql: String(sql),
    params,
    compact: String(sql).replace(/\s+/g, " ").trim(),
  }));
}

const countStmt = () => statements().find((s) => s.compact.startsWith("SELECT COUNT(*)"));
const rowStmt = () => statements().find((s) => s.compact.startsWith("SELECT vr.*"));

beforeEach(() => {
  pool.query.mockReset();
  pool.query.mockResolvedValueOnce([[{ total: 0 }]]).mockResolvedValueOnce([[]]);
});

describe("mySentRequests — org_admin sees the whole organization", () => {
  it("scopes by the requester's organization, not by their own user id", async () => {
    await mySentRequests(req(orgAdmin), mockRes());

    const count = countStmt();
    expect(count.compact).toContain("requester.organization = ?");
    // The bug being fixed: filtering to vr.user_id is what hid sub-admin rows.
    expect(count.compact).not.toContain("vr.user_id = ?");
    expect(count.params[0]).toBe(ORG_ID);
  });

  it("does not filter on the admin's own id anywhere in the query", async () => {
    await mySentRequests(req(orgAdmin), mockRes());

    for (const s of statements()) {
      expect(s.params).not.toContain(orgAdmin.id);
    }
  });

  it("joins users in the COUNT query, matching the row query", async () => {
    // Without the join in COUNT, `requester.organization` has nothing to resolve
    // against: SQL error, or — worse if someone "fixes" it by filtering on
    // vr.user_id — a total that disagrees with the rows.
    await mySentRequests(req(orgAdmin), mockRes());

    const count = countStmt();
    expect(count.compact).toContain("JOIN users requester ON requester.id = vr.user_id");
  });

  it("COUNT and row queries are consistent so the total matches the page", async () => {
    await mySentRequests(req(orgAdmin), mockRes());

    // The row query joins more tables (admin_locker, requester_org, uo) purely to
    // select extra display columns. That is safe only because they are all LEFT
    // joins on the row's own columns: they can neither drop nor duplicate rows.
    // The direction that actually matters is the other one — every table COUNT
    // joins must also exist in the row query, or the filter would resolve in one
    // and not the other and the two would disagree.
    const countJoins = countStmt().compact.match(/JOIN \w+ \w+/g) ?? [];
    const rowCompact = rowStmt().compact;
    for (const join of countJoins) {
      expect(rowCompact).toContain(join);
    }

    // Anything the row query adds on top must be a LEFT JOIN.
    const rowJoins = rowCompact.match(/(LEFT )?JOIN \w+ \w+/g) ?? [];
    for (const join of rowJoins) {
      if (!countJoins.includes(join.replace("LEFT ", ""))) {
        expect(join.startsWith("LEFT ")).toBe(true);
      }
    }
  });

  it("scopes by the SENDER's org, not the issuing org", async () => {
    // "Who sent it" and "who it was addressed to" are different questions. An
    // org admin manages the former; filtering on o.id (issuing) would show them
    // requests other orgs sent to their org instead.
    await mySentRequests(req(orgAdmin), mockRes());

    const s = countStmt().compact;
    expect(s).toContain("requester.organization");
    // The issuing org is joined for display only and must not appear in the scope.
    const wherePart = s.slice(s.indexOf("WHERE"));
    expect(wherePart).not.toMatch(/\bo\.id\b/);
    expect(wherePart).not.toContain("issuing_organization_id =");
  });
});

describe("mySentRequests — everyone else still sees only their own", () => {
  it("sub-admin is scoped to their own user id", async () => {
    await mySentRequests(req(subAdmin), mockRes());

    const count = countStmt();
    expect(count.compact).toContain("vr.user_id = ?");
    expect(count.compact).not.toContain("requester.organization = ?");
    expect(count.params[0]).toBe(subAdmin.id);
  });

  it("a regular member is scoped to their own user id", async () => {
    await mySentRequests(req(plainMember), mockRes());

    const count = countStmt();
    expect(count.compact).toContain("vr.user_id = ?");
    expect(count.params[0]).toBe(plainMember.id);
  });

  it("an org_admin with no organization falls back to their own requests", async () => {
    // Without an org there is nothing to widen to, and trusting a null scope
    // would be an unscoped query — a total leak of every request in the system.
    await mySentRequests(req(noOrg), mockRes());

    const count = countStmt();
    expect(count.compact).toContain("vr.user_id = ?");
    expect(count.params[0]).toBe(noOrg.id);
  });
});

describe("mySentRequests — filters still compose on top of the scope", () => {
  it("keeps search filters and binds them after the scope parameter", async () => {
    await mySentRequests(req(orgAdmin, { search: "passport" }), mockRes());

    const count = countStmt();
    expect(count.compact).toContain("LIKE ?");
    // Params: [orgId, like x4] — scope first, then filters.
    expect(count.params).toEqual([ORG_ID, "%passport%", "%passport%", "%passport%", "%passport%"]);
  });

  it("keeps the date range filters", async () => {
    await mySentRequests(req(orgAdmin, { dateFrom: "2026-01-01", dateTo: "2026-02-01" }), mockRes());

    const count = countStmt();
    expect(count.compact).toContain("vr.created_at >= ?");
    expect(count.compact).toContain("vr.created_at <= ?");
    expect(count.params[0]).toBe(ORG_ID);
    expect(count.params).toContain("2026-01-01");
    expect(count.params).toContain("2026-02-01 23:59:59");
  });

  it("paginates the row query after the filters", async () => {
    await mySentRequests(req(orgAdmin, { search: "x" }), mockRes());

    // Only the row query paginates — a COUNT must count the whole filtered set,
    // so LIMIT/OFFSET on it would break the total.
    expect(countStmt().compact).not.toContain("LIMIT");
    const row = rowStmt();
    expect(row.compact).toContain("LIMIT ? OFFSET ?");
    const limit = row.params[row.params.length - 2];
    const offset = row.params[row.params.length - 1];
    expect(Number.isInteger(limit)).toBe(true);
    expect(Number.isInteger(offset)).toBe(true);
  });

  it("passes no pagination params to the COUNT query", async () => {
    await mySentRequests(req(orgAdmin, { search: "x" }), mockRes());

    // [orgId, like x4] only — limit/offset belong to the row query alone.
    expect(countStmt().params).toHaveLength(5);
  });
});

describe("mySentRequests — response shape is unchanged", () => {
  it("still returns a paginated envelope", async () => {
    pool.query.mockReset();
    pool.query.mockResolvedValueOnce([[{ total: 7 }]]).mockResolvedValueOnce([
      [
        { uuid: "r1", document_type: "Degree" },
        { uuid: "r2", document_type: "Passport" },
      ],
    ]);

    const res = mockRes();
    await mySentRequests(req(orgAdmin), res);

    expect(res.status).toHaveBeenCalledWith(200);
    const payload = res.json.mock.calls[0][0];
    const data = payload?.data ?? payload;
    expect(data.total).toBe(7);
    expect(data.items).toHaveLength(2);
  });
});
