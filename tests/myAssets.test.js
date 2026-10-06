import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Employee self-service for assets: GET /api/v1/my/assets.
 *
 * THE ONE PROPERTY THAT MATTERS. The employee is derived from the JWT, so the
 * route takes no employee parameter at all. A caller who could name an id could
 * ask "what hardware does my colleague have", which is a small privacy leak and
 * an invitation to try other uuids.
 *
 * Also asserted: CURRENTLY assigned only, and no procurement figures. An
 * employee has no business seeing what the company paid for their laptop, and an
 * endpoint that returns purchase_cost is a way to read other people's salaries by
 * proxy once someone starts comparing.
 */
vi.mock("../src/config/db.js", () => ({
  pool: { query: vi.fn(), getConnection: vi.fn() },
}));
vi.mock("../src/utils/auditLog.js", () => ({ logAudit: vi.fn() }));

const { pool } = await import("../src/config/db.js");
const assets = await import("../src/services/assets.service.js");

const ORG = 5;
const OTHER_ORG = 77;
const USER = "99999999-9999-4999-8999-999999999999";
const EMPLOYEE = "44444444-4444-4444-8444-444444444444";

const row = (over = {}) => ({
  uuid: "33333333-3333-4333-8333-333333333333",
  assignment_uuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  asset_tag: "AST-0001",
  name: "ThinkPad T14",
  category_name: "Laptops",
  model_details: "T14 Gen 3",
  serial_number: "PF3XK9",
  warranty_expires_at: "2027-01-31",
  assigned_at: "2026-02-01 09:00:00",
  ...over,
});

beforeEach(() => {
  pool.query.mockReset();
  vi.clearAllMocks();
});

/** Answers the employee lookup, then the asset list. */
function withEmployeeAndRows(rows) {
  pool.query
    .mockResolvedValueOnce([[{ uuid: EMPLOYEE, full_name: "Kinza" }], []])
    .mockResolvedValueOnce([rows, []]);
}

describe("my assets", () => {
  it("resolves the employee from the session, scoped to the organization", async () => {
    withEmployeeAndRows([]);
    await assets.listMyAssets({ orgId: ORG, userUuid: USER });

    const lookup = String(pool.query.mock.calls[0][0]);
    expect(lookup).toContain("linked_user_uuid=?");
    expect(pool.query.mock.calls[0][1]).toEqual([ORG, USER]);
  });

  it("takes no employee uuid from the caller", async () => {
    // The function signature itself is the guarantee: there is nowhere to pass
    // one, so no caller can be tricked into asking about somebody else.
    expect(assets.listMyAssets.length).toBe(1);
    withEmployeeAndRows([]);
    await assets.listMyAssets({ orgId: ORG, userUuid: USER });

    const listSql = String(pool.query.mock.calls[1][0]);
    expect(listSql).not.toContain("req.body");
    expect(listSql).not.toContain("req.query");
  });

  it("scopes the asset list to BOTH the employee and the organization", async () => {
    withEmployeeAndRows([row()]);
    await assets.listMyAssets({ orgId: ORG, userUuid: USER });

    const [sql, params] = pool.query.mock.calls[1];
    expect(String(sql)).toContain("g.employee_uuid=?");
    expect(String(sql)).toContain("g.organization_id=?");
    expect(params).toContain(EMPLOYEE);
    expect(params).toContain(ORG);
  });

  it("returns only CURRENTLY assigned assets", async () => {
    withEmployeeAndRows([row()]);
    await assets.listMyAssets({ orgId: ORG, userUuid: USER });

    const sql = String(pool.query.mock.calls[1][0]);
    // A returned laptop is not "currently assigned to" anyone, and showing it
    // as theirs invites a support ticket about a device they do not have.
    expect(sql).toContain("g.returned_at IS NULL");
    expect(sql).toContain("a.status = 'assigned'");
  });

  it("does not expose purchase cost or vendor", async () => {
    withEmployeeAndRows([row()]);
    const [first] = await assets.listMyAssets({ orgId: ORG, userUuid: USER });

    const sql = String(pool.query.mock.calls[1][0]).toLowerCase();
    expect(sql).not.toContain("purchase_cost");
    expect(sql).not.toContain("vendor");

    // And the returned object carries none either, so a later query change
    // cannot leak it by accident.
    expect(first).not.toHaveProperty("purchase_cost");
    expect(first).not.toHaveProperty("vendor");
  });

  it("returns the fields the page actually shows", async () => {
    withEmployeeAndRows([row()]);
    const [first] = await assets.listMyAssets({ orgId: ORG, userUuid: USER });

    for (const key of [
      "asset_tag",
      "category_name",
      "model_details",
      "serial_number",
      "assigned_at",
    ]) {
      expect(first).toHaveProperty(key);
    }
  });

  it("returns an empty list for a user with no employee record", async () => {
    // A sub-admin or org admin who is not on the roster. Not an error: the
    // employee portal renders for every org user, and a 403 would break it.
    pool.query.mockResolvedValueOnce([[], []]);
    await expect(assets.listMyAssets({ orgId: ORG, userUuid: USER })).resolves.toEqual([]);
  });

  it("does not cross organizations when the same employee uuid exists elsewhere", async () => {
    withEmployeeAndRows([row()]);
    await assets.listMyAssets({ orgId: OTHER_ORG, userUuid: USER });
    // Both scopes are in the params, so a mismatch returns nothing rather than
    // another tenant's hardware.
    expect(pool.query.mock.calls[0][1]).toEqual([OTHER_ORG, USER]);
    expect(pool.query.mock.calls[1][1]).toContain(OTHER_ORG);
  });
});

describe("route surface", () => {
  it("exposes no parameter for selecting whose assets to read", () => {
    const src = readFileSyncSafe("src/routes/myAssets.routes.js");
    expect(src).toContain('router.get("/", selfService');
    // A :param on this route would be a way to ask about someone else.
    expect(src).not.toMatch(/router\.get\("\/:/);
    expect(src).not.toContain("employee_uuid");
  });

  it("is plan-gated on the same flag the staff routes use", () => {
    const src = readFileSyncSafe("src/routes/myAssets.routes.js");
    expect(src).toContain('requireModuleFeature("asset_management")');
  });

  it("uses authUser so req.user exists before the controller reads it", () => {
    const src = readFileSyncSafe("src/routes/myAssets.routes.js");
    expect(src).toContain("router.use(authUser)");
  });
});

function readFileSyncSafe(p) {
  // Imported lazily so the mocking above stays at the top of the file.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("node:fs").readFileSync(p, "utf8");
}