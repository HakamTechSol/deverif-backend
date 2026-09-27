import { describe, it, expect, vi, beforeEach } from "vitest";

// Rejecting a request is a statement about someone's document, so the reason is
// mandatory on that path. Frontend validation is a courtesy; these tests exist
// because the server must not depend on it — a request can arrive from any
// client, and a rejection with no reason is unactionable for the requester and
// indistinguishable from an oversight to support.

vi.mock("../src/config/db.js", () => ({ pool: { query: vi.fn() } }));

import { pool } from "../src/config/db.js";
import { verifyRequest } from "../src/controllers/verification.controller.js";

const ORG_ID = 20;
const USER_ID = 2;
const REQUEST_UUID = "ffffffff-aaaa-4bbb-8ccc-dddddddddddd";

// assertOrganizationActive(orgId) is the first query every reaching test sees.
const ORG_ACTIVE = [[{ subscription_status: "active", subscription_expiry: null }]];

function makeReq(body) {
  return {
    params: { uuid: REQUEST_UUID },
    body,
    user: { id: USER_ID, org_role: "org_admin", organization: ORG_ID },
  };
}
function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

/** Queue a lookup that returns an open request owned by ORG_ID. */
function queueOpenRequest() {
  pool.query.mockResolvedValueOnce(ORG_ACTIVE).mockResolvedValueOnce([
    [
      {
        id: 100,
        uuid: REQUEST_UUID,
        status: "under_review",
        issuing_organization_id: ORG_ID,
        user_id: USER_ID,
      },
    ],
  ]);
}

/** The UPDATE that finalizes the request. */
function updateCall() {
  return pool.query.mock.calls.find(([sql]) => String(sql).includes("SET status=?"));
}

beforeEach(() => {
  // mockReset, not clearAllMocks: several tests intentionally throw BEFORE
  // reaching the DB (the reject/empty-remarks and over-long-remarks cases), which
  // leaves their queued once-values unconsumed. mockClear keeps those queued
  // values, so they would leak into the next test and shift its query order —
  // producing confusing "object is not iterable" failures far from the cause.
  pool.query.mockReset();
});

describe("verifyRequest — a rejection requires verification remarks", () => {
  it("returns 400 when rejecting with no remarks field at all", async () => {
    queueOpenRequest();

    await expect(verifyRequest(makeReq({ status: "unverified" }), mockRes())).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("required when rejecting"),
    });
  });

  it("returns 400 when rejecting with an empty string", async () => {
    queueOpenRequest();

    await expect(
      verifyRequest(makeReq({ status: "unverified", verification_remarks: "" }), mockRes())
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("returns 400 when rejecting with whitespace only", async () => {
    queueOpenRequest();

    // A blank-looking textarea must not sneak past the check.
    await expect(
      verifyRequest(makeReq({ status: "unverified", verification_remarks: "   \n\t  " }), mockRes())
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("returns 400 when rejecting with a null value", async () => {
    queueOpenRequest();

    await expect(
      verifyRequest(makeReq({ status: "unverified", verification_remarks: null }), mockRes())
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects BEFORE the request lookup, so nothing is touched", async () => {
    // Only the status guard's own work should have run; the org-active check and
    // the request SELECT must not have been reached, and nothing was written.
    await expect(verifyRequest(makeReq({ status: "unverified" }), mockRes())).rejects.toMatchObject({
      statusCode: 400,
    });

    expect(updateCall()).toBeUndefined();
  });
});

describe("verifyRequest — a rejection with remarks still succeeds", () => {
  function queueRejection() {
    queueOpenRequest();
    pool.query
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE
      .mockResolvedValueOnce([[
        { id: 100, uuid: REQUEST_UUID, status: "unverified", issuing_organization_id: ORG_ID, user_id: USER_ID },
      ]]) // SELECT updated
      .mockResolvedValueOnce([[{ uuid: USER_ID, organization: ORG_ID }]]) // requester
      .mockResolvedValueOnce([[{ name: "Org B" }]]); // sender org name
  }

  it("finalizes the request and stores the reason", async () => {
    queueRejection();
    const res = mockRes();

    await verifyRequest(
      makeReq({ status: "unverified", verification_remarks: "The CNIC on the scan does not match." }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(200);
    const call = updateCall();
    expect(call).toBeDefined();
    // [status, verified_by, verification_remarks, uuid]
    expect(call[1][0]).toBe("unverified");
    expect(call[1][2]).toBe("The CNIC on the scan does not match.");
  });

  it("trims the stored reason so stray whitespace is not persisted", async () => {
    queueRejection();

    await verifyRequest(
      makeReq({ status: "unverified", verification_remarks: "  Blurred and cut off.  " }),
      mockRes()
    );

    expect(updateCall()[1][2]).toBe("Blurred and cut off.");
  });

  it("rejects a reason longer than the column can hold", async () => {
    // verification_remarks is varchar(500); a clear 400 beats a driver-level
    // truncation error.
    queueOpenRequest();

    await expect(
      verifyRequest(makeReq({ status: "unverified", verification_remarks: "x".repeat(501) }), mockRes())
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining("500 characters") });
  });
});

describe("verifyRequest — approving stays optional", () => {
  it("approves with no remarks at all", async () => {
    // Product intent confirmed: a clean match needs no justification, and
    // forcing one would only collect noise. Only the reject path is mandatory.
    queueOpenRequest();
    pool.query
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[
        { id: 100, uuid: REQUEST_UUID, status: "verified", issuing_organization_id: ORG_ID, user_id: USER_ID },
      ]])
      .mockResolvedValueOnce([[{ uuid: USER_ID, organization: ORG_ID }]])
      .mockResolvedValueOnce([[{ name: "Org B" }]]);

    const res = mockRes();
    await verifyRequest(makeReq({ status: "verified" }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    // No remarks means NULL in the column, not an empty string.
    expect(updateCall()[1][2]).toBeNull();
  });

  it("approves with remarks and stores them", async () => {
    queueOpenRequest();
    pool.query
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[
        { id: 100, uuid: REQUEST_UUID, status: "verified", issuing_organization_id: ORG_ID, user_id: USER_ID },
      ]])
      .mockResolvedValueOnce([[{ uuid: USER_ID, organization: ORG_ID }]])
      .mockResolvedValueOnce([[{ name: "Org B" }]]);

    await verifyRequest(makeReq({ status: "verified", verification_remarks: "Matches the registry." }), mockRes());

    expect(updateCall()[1][2]).toBe("Matches the registry.");
  });

  it("still rejects an over-long remark on the approve path", async () => {
    // The column limit is not conditional on the decision.
    queueOpenRequest();

    await expect(
      verifyRequest(makeReq({ status: "verified", verification_remarks: "x".repeat(501) }), mockRes())
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
