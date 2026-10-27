import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * authUser is the org-scope publisher for every route that does NOT also run
 * requireRole — the whole employee self-service family: /my/assets, /my/leaves,
 * /my/attendance, /my/salary.
 *
 * Until this was pinned, only requireRole set req.scopeOrgId, so a controller
 * reading it on an authUser-only route got undefined. Nothing throws on
 * undefined: it becomes `organization_id = NULL`, matches no employee, and the
 * endpoint answers 200 with an empty list. That is how /my/assets told an
 * employee holding AST-0007 that they held nothing, while every staff view
 * showed the assignment sitting there assigned to them.
 *
 * The response looked like a correct answer, which is why this asserts the
 * middleware's published state rather than any endpoint's body.
 */
vi.mock("../src/config/db.js", () => ({ pool: { query: vi.fn() } }));
vi.mock("../src/utils/jwt.js", () => ({ verifyAccessToken: vi.fn() }));
vi.mock("../src/utils/tokenBlacklist.js", () => ({ isBlacklisted: vi.fn() }));

import { pool } from "../src/config/db.js";
import { verifyAccessToken } from "../src/utils/jwt.js";
import { isBlacklisted } from "../src/utils/tokenBlacklist.js";
import authUser from "../src/middleware/authUser.js";

const ORG_ID = 7;
const USER_UUID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";

function run() {
  const req = { headers: { authorization: `Bearer ${USER_UUID}` } };
  const next = vi.fn();
  return { req, next, done: authUser(req, {}, next) };
}

const userRow = { uuid: USER_UUID, organization: ORG_ID, status: "active" };

beforeEach(() => {
  vi.clearAllMocks();
  verifyAccessToken.mockReturnValue({ userId: USER_UUID, type: "user", role: "user" });
  isBlacklisted.mockResolvedValue(false);
  pool.query.mockResolvedValueOnce([[]]); // the linked employees row
  pool.query.mockResolvedValueOnce([[userRow]]);
});

describe("authUser publishes the org scope", () => {
  it("sets req.scopeOrgId to the user's organization", async () => {
    const { req, next, done } = run();
    await done;

    expect(next).toHaveBeenCalledWith();
    expect(req.user).toMatchObject({ uuid: USER_UUID });
    // The bug: this was undefined on every authUser-only route.
    expect(req.scopeOrgId).toBe(ORG_ID);
  });

  it("sets it from the LIVE user row, not from the token", async () => {
    // requireRole cross-checks the JWT's organization claim against the row and
    // rejects a mismatch. authUser is the only publisher on routes without it,
    // so the row is the only trustworthy source.
    verifyAccessToken.mockReturnValue({
      userId: USER_UUID,
      type: "user",
      role: "user",
      organization: 999,
    });

    const { req, done } = run();
    await done;

    expect(req.scopeOrgId).toBe(ORG_ID);
    expect(req.scopeOrgId).not.toBe(999);
  });

  it("leaves scopeOrgId undefined for a user with no organization", async () => {
    // Better an undefined scope than a fabricated one: downstream the module gate
    // answers 403 ("User has no organization") instead of querying NULL.
    pool.query.mockReset();
    pool.query.mockResolvedValueOnce([[]]);
    pool.query.mockResolvedValueOnce([[{ ...userRow, organization: null }]]);

    const { req, next, done } = run();
    await done;

    expect(next).toHaveBeenCalledWith();
    expect(req.user.organization).toBeNull();
    expect(req.scopeOrgId ?? null).toBeNull();
  });
});
