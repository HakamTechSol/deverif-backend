import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Asset service logic, mocked at the pool.
 *
 * The invariants asserted here are the ones a client can break by sending the
 * wrong field, so they belong at this level:
 *
 *   1. STATUS IS NEVER TAKEN FROM THE REQUEST. A client posting status:"assigned"
 *      on create must not be able to invent a holder. Status is derived from the
 *      active assignment rows, and only those writes may move it.
 *   2. TENANT ISOLATION. Every read and write carries organization_id, so a
 *      guessed uuid 404s instead of returning another org's inventory.
 *   3. ILLEGAL TRANSITIONS ARE REFUSED. Scrapping a held asset, assigning a
 *      retired one, closing a job twice — each must fail loudly rather than
 *      leaving the register contradicting itself.
 *
 * Database-enforced invariants (at most one open assignment) are NOT
 * asserted here, because a mocked pool cannot reject anything. Those live in
 * assets.db.test.js, which runs against a real database.
 */
vi.mock("../src/config/db.js", () => ({
  pool: {
    query: vi.fn(),
    getConnection: vi.fn(),
  },
}));
vi.mock("../src/utils/auditLog.js", () => ({ logAudit: vi.fn() }));

const { pool } = await import("../src/config/db.js");
const assets = await import("../src/services/assets.service.js");

const ORG = 7;
const OTHER_ORG = 99;
const ADMIN = "11111111-1111-4111-8111-111111111111";
const ASSET = "33333333-3333-4333-8333-333333333333";
const EMPLOYEE = "44444444-4444-4444-8444-444444444444";
const JOB = "55555555-5555-4555-8555-555555555555";

const assetRow = (over = {}) => ({
  id: 1,
  uuid: ASSET,
  organization_id: ORG,
  asset_tag: "AST-0001",
  name: "ThinkPad",
  model_details: null,
  serial_number: null,
  status: "available",
  notes: null,
  ...over,
});

/** Pool stub whose getConnection behaves like the real thing for our purposes. */
function useConnection() {
  const conn = {
    query: vi.fn(async () => [{ insertId: 1 }, []]),
    beginTransaction: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
    rollback: vi.fn(async () => {}),
    release: vi.fn(),
  };
  pool.getConnection.mockResolvedValue(conn);
  return conn;
}

beforeEach(() => {
  pool.query.mockReset();
  pool.getConnection.mockReset();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Inventory creation
// ---------------------------------------------------------------------------

describe("asset creation", () => {
  it("creates an asset by name without category input", async () => {
    const conn = useConnection();
    conn.query = vi.fn(async (sql) => {
      const statement = String(sql);
      if (statement.includes("COUNT(*) AS n FROM assets")) return [[{ n: 0 }], []];
      if (statement.includes("SELECT 1 AS x")) return [[], []];
      if (statement.includes("INSERT INTO assets")) return [{ insertId: 9 }, []];
      if (statement.includes("SELECT uuid FROM assets")) return [[{ uuid: ASSET }], []];
      return [[], []];
    });
    pool.query = vi.fn(async () => [[assetRow()], []]);

    await assets.createAsset({
      orgId: ORG,
      actorUuid: ADMIN,
      data: { name: "ThinkPad", status: "assigned" },
    });

    const insert = conn.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO assets"));
    expect(insert).toBeTruthy();
    expect(String(insert[0])).not.toContain("category_uuid");
    expect(insert[1]).toContain("AST-0001");
    expect(insert[1]).toContain("available");
    expect(insert[1]).not.toContain("assigned");
  });

  it("rolls back when the asset insert fails", async () => {
    const conn = useConnection();
    conn.query = vi.fn(async (sql) => {
      if (String(sql).includes("COUNT(*) AS n FROM assets")) return [[{ n: 0 }], []];
      if (String(sql).includes("SELECT 1 AS x")) return [[], []];
      if (String(sql).includes("INSERT INTO assets")) {
        throw Object.assign(new Error("insert failed"), { code: "ER_DUP_ENTRY" });
      }
      return [[], []];
    });

    await expect(
      assets.createAsset({ orgId: ORG, actorUuid: ADMIN, data: { name: "ThinkPad" } }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(conn.rollback).toHaveBeenCalled();
    expect(conn.commit).not.toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalled();
  });

  it("requires a non-empty asset name", async () => {
    await expect(
      assets.createAsset({ orgId: ORG, actorUuid: ADMIN, data: { name: "  " } }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(pool.getConnection).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

describe("assignment", () => {
  async function readyAsset(status = "available") {
    const conn = useConnection();
    // Stateful: once an assignment is inserted the open-assignment count must
    // read 1, otherwise syncStatus derives "available" and the derivation this
    // module is built around is never actually exercised.
    let assigned = false;
    conn.query = vi.fn(async (sql) => {
      const s = String(sql);
      if (s.includes("FROM assets a")) return [[assetRow({ status })], []];
      if (s.includes("FROM employees")) {
        return [[{ uuid: EMPLOYEE, full_name: "Kinza", linked_user_uuid: "user-uuid-1" }], []];
      }
      if (s.includes("INSERT INTO asset_assignments")) {
        assigned = true;
        return [{ insertId: 5 }, []];
      }
      if (s.includes("SELECT uuid FROM asset_assignments")) return [[{ uuid: "assign-1" }], []];
      if (s.includes("FROM asset_assignments WHERE asset_uuid")) {
        return [[{ n: assigned ? 1 : 0 }], []];
      }
      return [[], []];
    });
    return conn;
  }

  it("assigns an available asset and derives status=assigned", async () => {
    await readyAsset("available");
    const result = await assets.assignAsset({
      orgId: ORG,
      actorUuid: ADMIN,
      assetUuid: ASSET,
      employeeUuid: EMPLOYEE,
    });

    expect(result.status).toBe("assigned");
    expect(result.employee_name).toBe("Kinza");
  });

  it("reports whether the employee can actually see it on /my/assets", async () => {
    // /my/assets resolves the employee from the session via linked_user_uuid, so
    // this flag is the difference between "assigned" and "assigned but invisible
    // to the person holding it".
    await readyAsset("available");
    const linked = await assets.assignAsset({
      orgId: ORG,
      actorUuid: ADMIN,
      assetUuid: ASSET,
      employeeUuid: EMPLOYEE,
    });
    expect(linked.employee_has_portal_account).toBe(true);
  });

  it("flags an employee with no portal account so the UI can warn", async () => {
    // readyAsset installs its own query mock, so swap it afterwards.
    const conn = await readyAsset("available");
    let assigned = false;
    conn.query = vi.fn(async (sql) => {
      const s = String(sql);
      if (s.includes("FROM assets a")) return [[assetRow({ status: "available" })], []];
      if (s.includes("FROM employees")) {
        // Nobody to log in as, so /my/assets can never resolve this employee.
        return [[{ uuid: EMPLOYEE, full_name: "Kinza", linked_user_uuid: null }], []];
      }
      if (s.includes("INSERT INTO asset_assignments")) {
        assigned = true;
        return [{ insertId: 5 }, []];
      }
      if (s.includes("SELECT uuid FROM asset_assignments")) return [[{ uuid: "assign-1" }], []];
      if (s.includes("FROM asset_assignments WHERE asset_uuid")) {
        return [[{ n: assigned ? 1 : 0 }], []];
      }
      return [[], []];
    });

    const result = await assets.assignAsset({
      orgId: ORG,
      actorUuid: ADMIN,
      assetUuid: ASSET,
      employeeUuid: EMPLOYEE,
    });
    // The assignment still succeeds: withholding hardware over a login gap would
    // be worse. The caller just has to be told it is not yet visible.
    expect(result.status).toBe("assigned");
    expect(result.employee_has_portal_account).toBe(false);
  });

  it("scopes the asset lookup to the organization", async () => {
    const conn = await readyAsset("available");
    await assets.assignAsset({ orgId: ORG, actorUuid: ADMIN, assetUuid: ASSET, employeeUuid: EMPLOYEE });
    const lookup = conn.query.mock.calls.find(([sql]) => String(sql).includes("FROM assets a"));
    expect(lookup[1]).toEqual([ASSET, ORG]);
  });

  it("locks the row before reading status, so two clicks cannot both win", async () => {
    const conn = await readyAsset("available");
    await assets.assignAsset({ orgId: ORG, actorUuid: ADMIN, assetUuid: ASSET, employeeUuid: EMPLOYEE });
    const lookup = conn.query.mock.calls.find(([sql]) => String(sql).includes("FROM assets a"));
    expect(String(lookup[0])).toContain("FOR UPDATE");
  });

  it("refuses to assign an already-assigned asset", async () => {
    await readyAsset("assigned");
    await expect(
      assets.assignAsset({ orgId: ORG, actorUuid: ADMIN, assetUuid: ASSET, employeeUuid: EMPLOYEE }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("refuses to assign a retired asset", async () => {
    await readyAsset("retired");
    await expect(
      assets.assignAsset({ orgId: ORG, actorUuid: ADMIN, assetUuid: ASSET, employeeUuid: EMPLOYEE }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("refuses an employee from another organization", async () => {
    const conn = await readyAsset("available");
    conn.query = vi.fn(async (sql) => {
      const s = String(sql);
      if (s.includes("FROM assets a")) return [[assetRow({ status: "available" })], []];
      if (s.includes("FROM employees")) return [[], []];
      return [[], []];
    });
    await expect(
      assets.assignAsset({ orgId: ORG, actorUuid: ADMIN, assetUuid: ASSET, employeeUuid: EMPLOYEE }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("translates the database's duplicate-holder error into a 409", async () => {
    const conn = await readyAsset("available");
    conn.query = vi.fn(async (sql) => {
      const s = String(sql);
      if (s.includes("FROM assets a")) return [[assetRow({ status: "available" })], []];
      if (s.includes("FROM employees")) {
      return [[{ uuid: EMPLOYEE, full_name: "Kinza", linked_user_uuid: "user-uuid-1" }], []];
    }
      if (s.includes("INSERT INTO asset_assignments")) {
        throw Object.assign(new Error("dup"), { code: "ER_DUP_ENTRY" });
      }
      return [[], []];
    });

    // This is the generated-column guard firing. A raw driver code reaching the
    // client would be both ugly and unhelpful.
    await expect(
      assets.assignAsset({ orgId: ORG, actorUuid: ADMIN, assetUuid: ASSET, employeeUuid: EMPLOYEE }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

// ---------------------------------------------------------------------------
// Return
// ---------------------------------------------------------------------------

describe("return", () => {
  async function readyAsset() {
    const conn = useConnection();
    // A return closes the active assignment and frees the asset.
    let assigned = true;
    conn.query = vi.fn(async (sql) => {
      const s = String(sql);
      if (s.includes("FROM assets a")) return [[assetRow({ status: "assigned" })], []];
      if (s.includes("UPDATE asset_assignments")) {
        assigned = false;
        return [{ affectedRows: 1 }, []];
      }
      if (s.includes("FROM asset_assignments WHERE asset_uuid")) return [[{ n: assigned ? 1 : 0 }], []];
      return [[], []];
    });
    return conn;
  }

  it("closes the open assignment and frees the asset", async () => {
    await readyAsset();
    const result = await assets.returnAsset({ orgId: ORG, actorUuid: ADMIN, assetUuid: ASSET });
    expect(result.status).toBe("available");
  });

  it("rejects an unknown condition rather than storing it", async () => {
    await expect(
      assets.returnAsset({ orgId: ORG, actorUuid: ADMIN, assetUuid: ASSET, condition: "meh" }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("records a damaged condition without opening a repair workflow", async () => {
    const conn = await readyAsset();
    const result = await assets.returnAsset({
      orgId: ORG,
      actorUuid: ADMIN,
      assetUuid: ASSET,
      condition: "damaged",
      notes: "Cracked screen",
    });
    expect(result.status).toBe("available");
    const update = conn.query.mock.calls.find(([sql]) => String(sql).includes("UPDATE asset_assignments"));
    expect(update[1]).toContain("damaged");
    expect(conn.query.mock.calls.some(([sql]) => String(sql).includes("asset_maintenance"))).toBe(false);
  });

  it("refuses to return an asset nobody holds", async () => {
    const conn = await readyAsset();
    conn.query = vi.fn(async (sql) => {
      const s = String(sql);
      if (s.includes("FROM assets a")) return [[assetRow({ status: "available" })], []];
      if (s.includes("UPDATE asset_assignments")) return [{ affectedRows: 0 }, []];
      return [[], []];
    });
    await expect(
      assets.returnAsset({ orgId: ORG, actorUuid: ADMIN, assetUuid: ASSET }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("refuses to return a retired asset", async () => {
    const conn = await readyAsset();
    conn.query = vi.fn(async (sql) => {
      if (String(sql).includes("FROM assets a")) return [[assetRow({ status: "retired" })], []];
      return [[], []];
    });
    await expect(
      assets.returnAsset({ orgId: ORG, actorUuid: ADMIN, assetUuid: ASSET }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

// ---------------------------------------------------------------------------
// Retirement
// ---------------------------------------------------------------------------

describe("retirement", () => {
  it("scraps an available asset", async () => {
    const conn = useConnection();
    conn.query = vi.fn(async (sql) => {
      if (String(sql).includes("FROM assets a")) return [[assetRow({ status: "available" })], []];
      return [[], []];
    });
    const result = await assets.retireAsset({ orgId: ORG, actorUuid: ADMIN, assetUuid: ASSET, reason: "Written off" });
    expect(result.status).toBe("retired");
  });

  it("refuses to scrap an asset an employee is holding", async () => {
    const conn = useConnection();
    conn.query = vi.fn(async (sql) => {
      if (String(sql).includes("FROM assets a")) return [[assetRow({ status: "assigned" })], []];
      return [[], []];
    });
    await expect(
      assets.retireAsset({ orgId: ORG, actorUuid: ADMIN, assetUuid: ASSET }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("is idempotent-refusing, so a double click cannot silently succeed", async () => {
    const conn = useConnection();
    conn.query = vi.fn(async (sql) => {
      if (String(sql).includes("FROM assets a")) return [[assetRow({ status: "retired" })], []];
      return [[], []];
    });
    await expect(
      assets.retireAsset({ orgId: ORG, actorUuid: ADMIN, assetUuid: ASSET }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("keeps the retirement reason in the notes, for the audit trail", async () => {
    const conn = useConnection();
    conn.query = vi.fn(async (sql) => {
      if (String(sql).includes("FROM assets a")) return [[assetRow({ status: "available" })], []];
      return [[], []];
    });
    await assets.retireAsset({ orgId: ORG, actorUuid: ADMIN, assetUuid: ASSET, reason: "Written off" });
    const update = conn.query.mock.calls.find(([sql]) => String(sql).includes("UPDATE assets SET status='retired'"));
    expect(String(update[1])).toContain("Written off");
  });

});

// ---------------------------------------------------------------------------
// Listing and tenancy
// ---------------------------------------------------------------------------

describe("listing", () => {
  it("scopes every list query to the organization", async () => {
    pool.query.mockResolvedValueOnce([[{ total: 0 }], []]).mockResolvedValueOnce([[], []]);
    await assets.listAssets({ orgId: ORG, page: 1, limit: 20, offset: 0 });
    expect(pool.query.mock.calls[0][1]).toEqual([ORG]);
    expect(pool.query.mock.calls[1][1]).toContain(ORG);
  });

  it("keeps a search inside the organization", async () => {
    pool.query.mockResolvedValueOnce([[{ total: 0 }], []]).mockResolvedValueOnce([[], []]);
    await assets.listAssets({ orgId: ORG, page: 1, limit: 20, offset: 0, search: "AST" });
    const [sql, params] = pool.query.mock.calls[0];
    expect(String(sql)).toContain("a.organization_id = ?");
    expect(params).toContain(ORG);
  });

  it("rejects a status it does not recognise instead of filtering to nonsense", async () => {
    await expect(
      assets.listAssets({ orgId: ORG, page: 1, limit: 20, offset: 0, status: "lost" }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("shows the current holder inline, so the list answers 'who has this' without a click", async () => {
    pool.query.mockResolvedValueOnce([[{ total: 1 }], []]).mockResolvedValueOnce([
      [{ uuid: ASSET, status: "assigned", holder_name: "Kinza" }],
      [],
    ]);
    const page = await assets.listAssets({ orgId: ORG, page: 1, limit: 20, offset: 0 });
    expect(page.items[0].holder_name).toBe("Kinza");
  });

  it("summarises by status and excludes retired assets from the value total", async () => {
    pool.query
      .mockResolvedValueOnce([
        [
          { status: "available", n: 2, value: "1000.00" },
          { status: "retired", n: 1, value: "900.00" },
        ],
        [],
      ])
      ;

    const summary = await assets.assetSummary({ orgId: ORG });
    expect(summary.by_status.available).toBe(2);
    // A scrapped laptop is not part of what the company still owns.
    expect(summary.total_value).toBe(1000);
  });
});