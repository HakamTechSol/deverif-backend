import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Asset service logic, mocked at the pool.
 *
 * The invariants asserted here are the ones a client can break by sending the
 * wrong field, so they belong at this level:
 *
 *   1. STATUS IS NEVER TAKEN FROM THE REQUEST. A client posting status:"assigned"
 *      on create must not be able to invent a holder. Status is derived from the
 *      assignment and maintenance rows, and only those two writes may move it.
 *   2. TENANT ISOLATION. Every read and write carries organization_id, so a
 *      guessed uuid 404s instead of returning another org's inventory.
 *   3. ILLEGAL TRANSITIONS ARE REFUSED. Scrapping a held asset, assigning a
 *      retired one, closing a job twice — each must fail loudly rather than
 *      leaving the register contradicting itself.
 *
 * Database-enforced invariants (at most one open assignment / open job) are NOT
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
const CATEGORY = "22222222-2222-4222-8222-222222222222";
const ASSET = "33333333-3333-4333-8333-333333333333";
const EMPLOYEE = "44444444-4444-4444-8444-444444444444";
const JOB = "55555555-5555-4555-8555-555555555555";

const assetRow = (over = {}) => ({
  id: 1,
  uuid: ASSET,
  organization_id: ORG,
  category_uuid: CATEGORY,
  asset_tag: "AST-0001",
  name: "ThinkPad",
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
// Categories
// ---------------------------------------------------------------------------

describe("categories", () => {
  it("scopes the list to the organization", async () => {
    pool.query.mockResolvedValueOnce([[], []]);
    await assets.listCategories({ orgId: ORG });
    expect(pool.query.mock.calls[0][1]).toEqual([ORG]);
  });

  it("hides inactive categories unless asked", async () => {
    // `SELECT c.*` always brings is_active back; what matters is whether the
    // FILTER is applied. Note the call index: the second assertion reads the
    // SECOND query, not the first.
    pool.query.mockResolvedValue([[], []]);
    await assets.listCategories({ orgId: ORG });
    expect(String(pool.query.mock.calls[0][0])).toContain("c.is_active = 1");

    await assets.listCategories({ orgId: ORG, includeInactive: true });
    expect(String(pool.query.mock.calls[1][0])).not.toContain("c.is_active = 1");
  });

  it("counts the assets in each category, so an empty class is visible", async () => {
    pool.query.mockResolvedValueOnce([[{ uuid: CATEGORY, asset_count: 3 }], []]);
    const [row] = await assets.listCategories({ orgId: ORG });
    expect(row.asset_count).toBe(3);
  });

  it("requires a name", async () => {
    await expect(
      assets.createCategory({ orgId: ORG, actorUuid: ADMIN, data: { name: "  " } }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("reports a duplicate name as a conflict, not a 500", async () => {
    pool.query.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "ER_DUP_ENTRY" }));
    await expect(
      assets.createCategory({ orgId: ORG, actorUuid: ADMIN, data: { name: "Laptops" } }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("refuses to delete a category that still holds assets", async () => {
    // Deleting would either fail on the FK or cascade away a purchase history.
    pool.query.mockResolvedValueOnce([[{ n: 4 }], []]);
    await expect(
      assets.deleteCategory({ orgId: ORG, actorUuid: ADMIN, categoryUuid: CATEGORY }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(pool.query).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Inventory creation
// ---------------------------------------------------------------------------

describe("asset creation", () => {
  it("always starts available, whatever the client posts", async () => {
    const conn = useConnection();
    conn.query = vi.fn(async (sql) => {
      if (String(sql).includes("FROM asset_categories")) return [[{ uuid: CATEGORY, name: "Laptops", is_active: 1 }], []];
      if (String(sql).includes("COUNT(*) AS n FROM assets")) return [[{ n: 0 }], []];
      if (String(sql).includes("SELECT 1 AS x")) return [[], []];
      if (String(sql).includes("INSERT INTO assets")) return [{ insertId: 9 }, []];
      if (String(sql).includes("SELECT uuid FROM assets")) return [[{ uuid: ASSET }], []];
      return [[], []];
    });
    pool.query = vi.fn(async () => [[assetRow()], []]);

    await assets.createAsset({
      orgId: ORG,
      actorUuid: ADMIN,
      data: { name: "ThinkPad", category_uuid: CATEGORY, status: "assigned" },
    });

    const insert = conn.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO assets"));
    expect(insert).toBeTruthy();
    expect(insert[1]).toContain("available");
    expect(insert[1]).not.toContain("assigned");
  });

  it("allocates a tag when the client does not supply one", async () => {
    const conn = useConnection();
    conn.query = vi.fn(async (sql) => {
      const s = String(sql);
      if (s.includes("FROM asset_categories")) return [[{ uuid: CATEGORY, name: "Laptops", is_active: 1 }], []];
      if (s.includes("COUNT(*) AS n FROM assets")) return [[{ n: 4 }], []];
      if (s.includes("SELECT 1 AS x")) return [[], []];
      if (s.includes("INSERT INTO assets")) return [{ insertId: 9 }, []];
      if (s.includes("SELECT uuid FROM assets")) return [[{ uuid: ASSET }], []];
      return [[], []];
    });
    pool.query = vi.fn(async () => [[assetRow()], []]);

    await assets.createAsset({ orgId: ORG, actorUuid: ADMIN, data: { name: "ThinkPad", category_uuid: CATEGORY } });

    const insert = conn.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO assets"));
    expect(insert[1]).toContain("AST-0005");
  });

  it("rejects an asset in an inactive category", async () => {
    const conn = useConnection();
    conn.query = vi.fn(async (sql) => {
      if (String(sql).includes("FROM asset_categories")) {
        return [[{ uuid: CATEGORY, name: "Old Laptops", is_active: 0 }], []];
      }
      return [[], []];
    });

    await expect(
      assets.createAsset({ orgId: ORG, actorUuid: ADMIN, data: { name: "ThinkPad", category_uuid: CATEGORY } }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(conn.rollback).toHaveBeenCalled();
  });

  it("rolls back on failure rather than leaving a partial asset", async () => {
    const conn = useConnection();
    conn.query = vi.fn(async (sql) => {
      const s = String(sql);
      if (s.includes("FROM asset_categories")) return [[{ uuid: CATEGORY, name: "Laptops", is_active: 1 }], []];
      if (s.includes("COUNT(*) AS n FROM assets")) return [[{ n: 0 }], []];
      if (s.includes("SELECT 1 AS x")) return [[], []];
      // Fail at the INSERT, which is the duplicate-tag path.
      if (s.includes("INSERT INTO assets")) {
        throw Object.assign(new Error("dup"), { code: "ER_DUP_ENTRY" });
      }
      return [[], []];
    });

    await expect(
      assets.createAsset({ orgId: ORG, actorUuid: ADMIN, data: { name: "ThinkPad", category_uuid: CATEGORY } }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(conn.rollback).toHaveBeenCalled();
    expect(conn.commit).not.toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalled();
  });

  it("requires a category", async () => {
    const conn = useConnection();
    await expect(
      assets.createAsset({ orgId: ORG, actorUuid: ADMIN, data: { name: "ThinkPad" } }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(conn.rollback).toHaveBeenCalled();
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
    let openJobs = 0;
    conn.query = vi.fn(async (sql) => {
      const s = String(sql);
      if (s.includes("FROM assets a")) return [[assetRow({ status })], []];
      if (s.includes("FROM employees")) return [[{ uuid: EMPLOYEE, full_name: "Kinza" }], []];
      if (s.includes("INSERT INTO asset_assignments")) {
        assigned = true;
        return [{ insertId: 5 }, []];
      }
      if (s.includes("SELECT uuid FROM asset_assignments")) return [[{ uuid: "assign-1" }], []];
      if (s.includes("FROM asset_maintenance WHERE asset_uuid")) {
        return [[{ n: openJobs }], []];
      }
      if (s.includes("INSERT INTO asset_maintenance")) {
        openJobs = 1;
        return [{ insertId: 3 }, []];
      }
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

  it("refuses to assign an asset that is in for repair", async () => {
    await readyAsset("maintenance");
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
      if (s.includes("FROM employees")) return [[{ uuid: EMPLOYEE, full_name: "Kinza" }], []];
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
    // Stateful for the same reason as the assign helper: an open job inserted on
    // a damaged return must change what syncStatus derives.
    let assigned = true;
    let openJobs = 0;
    conn.query = vi.fn(async (sql) => {
      const s = String(sql);
      if (s.includes("FROM assets a")) return [[assetRow({ status: "assigned" })], []];
      if (s.includes("UPDATE asset_assignments")) {
        assigned = false;
        return [{ affectedRows: 1 }, []];
      }
      if (s.includes("INSERT INTO asset_maintenance")) {
        openJobs = 1;
        return [{ insertId: 3 }, []];
      }
      if (s.includes("SELECT uuid FROM asset_maintenance")) return [[{ uuid: "job-1" }], []];
      if (s.includes("FROM asset_maintenance WHERE asset_uuid")) return [[{ n: openJobs }], []];
      if (s.includes("FROM asset_assignments WHERE asset_uuid")) return [[{ n: assigned ? 1 : 0 }], []];
      return [[], []];
    });
    return conn;
  }

  it("closes the open assignment and frees the asset", async () => {
    await readyAsset();
    const result = await assets.returnAsset({ orgId: ORG, actorUuid: ADMIN, assetUuid: ASSET });
    expect(result.status).toBe("available");
    expect(result.opened_maintenance_uuid).toBeNull();
  });

  it("rejects an unknown condition rather than storing it", async () => {
    await expect(
      assets.returnAsset({ orgId: ORG, actorUuid: ADMIN, assetUuid: ASSET, condition: "meh" }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("opens a maintenance job when it comes back damaged", async () => {
    const conn = await readyAsset();
    const result = await assets.returnAsset({
      orgId: ORG,
      actorUuid: ADMIN,
      assetUuid: ASSET,
      condition: "damaged",
      notes: "Cracked screen",
    });

    expect(result.opened_maintenance_uuid).toBe("job-1");
    // Damaged means it must NOT read as freely available.
    expect(result.status).toBe("maintenance");
    expect(
      conn.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO asset_maintenance")),
    ).toBe(true);
  });

  it("records the condition, since it is what decides whether repair follows", async () => {
    const conn = await readyAsset();
    await assets.returnAsset({ orgId: ORG, actorUuid: ADMIN, assetUuid: ASSET, condition: "needs_maintenance" });
    const update = conn.query.mock.calls.find(([sql]) => String(sql).includes("UPDATE asset_assignments"));
    expect(update[1]).toContain("needs_maintenance");
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
// Maintenance
// ---------------------------------------------------------------------------

describe("maintenance", () => {
  async function readyAsset(status = "available") {
    const conn = useConnection();
    let openJobs = 0;
    conn.query = vi.fn(async (sql) => {
      const s = String(sql);
      if (s.includes("FROM assets a")) return [[assetRow({ status })], []];
      if (s.includes("INSERT INTO asset_maintenance")) {
        openJobs = 1;
        return [{ insertId: 3 }, []];
      }
      if (s.includes("SELECT uuid FROM asset_maintenance")) return [[{ uuid: JOB }], []];
      if (s.includes("FROM asset_maintenance WHERE asset_uuid")) return [[{ n: openJobs }], []];
      if (s.includes("FROM asset_assignments WHERE asset_uuid")) return [[{ n: 0 }], []];
      return [[], []];
    });
    return conn;
  }

  it("sending an asset for repair moves it to maintenance", async () => {
    await readyAsset("available");
    const result = await assets.reportMaintenance({
      orgId: ORG,
      actorUuid: ADMIN,
      assetUuid: ASSET,
      data: { title: "Screen replacement", vendor: "FixIt", cost: 120 },
    });
    expect(result.status).toBe("maintenance");
  });

  it("stores the vendor and the cost actually paid", async () => {
    const conn = await readyAsset("available");
    await assets.reportMaintenance({
      orgId: ORG,
      actorUuid: ADMIN,
      assetUuid: ASSET,
      data: { title: "Battery", vendor: "FixIt", cost: 89.5 },
    });
    const insert = conn.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO asset_maintenance"));
    expect(insert[1]).toContain("FixIt");
    expect(insert[1]).toContain(89.5);
  });

  it("requires a title", async () => {
    await readyAsset();
    await expect(
      assets.reportMaintenance({ orgId: ORG, actorUuid: ADMIN, assetUuid: ASSET, data: {} }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("refuses a second open job on the same asset", async () => {
    const conn = await readyAsset("maintenance");
    conn.query = vi.fn(async (sql) => {
      const s = String(sql);
      if (s.includes("FROM assets a")) return [[assetRow({ status: "maintenance" })], []];
      if (s.includes("INSERT INTO asset_maintenance")) {
        throw Object.assign(new Error("dup"), { code: "ER_DUP_ENTRY" });
      }
      return [[], []];
    });
    await expect(
      assets.reportMaintenance({ orgId: ORG, actorUuid: ADMIN, assetUuid: ASSET, data: { title: "Again" } }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("completing a job returns the asset to available", async () => {
    const conn = useConnection();
    conn.query = vi.fn(async (sql) => {
      const s = String(sql);
      if (s.includes("FROM asset_maintenance WHERE uuid")) {
        return [[{ uuid: JOB, asset_uuid: ASSET, status: "open" }], []];
      }
      if (s.includes("FROM asset_maintenance WHERE asset_uuid")) return [[{ n: 0 }], []];
      if (s.includes("FROM asset_assignments WHERE asset_uuid")) return [[{ n: 0 }], []];
      return [[], []];
    });

    const result = await assets.completeMaintenance({ orgId: ORG, actorUuid: ADMIN, jobUuid: JOB });
    expect(result.status).toBe("available");
  });

  it("returns a still-held asset to assigned, not to available", async () => {
    // A borrowed company laptop sent for servicing is real. Forcing
    // "available" would strip a live assignment.
    const conn = useConnection();
    conn.query = vi.fn(async (sql) => {
      const s = String(sql);
      if (s.includes("FROM asset_maintenance WHERE uuid")) {
        return [[{ uuid: JOB, asset_uuid: ASSET, status: "open" }], []];
      }
      if (s.includes("FROM asset_maintenance WHERE asset_uuid")) return [[{ n: 0 }], []];
      if (s.includes("FROM asset_assignments WHERE asset_uuid")) return [[{ n: 1 }], []];
      return [[], []];
    });

    const result = await assets.completeMaintenance({ orgId: ORG, actorUuid: ADMIN, jobUuid: JOB });
    expect(result.status).toBe("assigned");
  });

  it("refuses to close a job that is already closed", async () => {
    const conn = useConnection();
    conn.query = vi.fn(async (sql) => {
      if (String(sql).includes("FROM asset_maintenance WHERE uuid")) {
        return [[{ uuid: JOB, asset_uuid: ASSET, status: "completed" }], []];
      }
      return [[], []];
    });
    await expect(
      assets.completeMaintenance({ orgId: ORG, actorUuid: ADMIN, jobUuid: JOB }),
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

  it("refuses to scrap an asset that is in for repair", async () => {
    const conn = useConnection();
    conn.query = vi.fn(async (sql) => {
      if (String(sql).includes("FROM assets a")) return [[assetRow({ status: "maintenance" })], []];
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

  it("reinstate derives the status from the rows rather than assuming available", async () => {
    const conn = useConnection();
    conn.query = vi.fn(async (sql) => {
      const s = String(sql);
      if (s.includes("FROM assets a")) return [[assetRow({ status: "retired" })], []];
      if (s.includes("FROM asset_maintenance WHERE asset_uuid")) return [[{ n: 1 }], []];
      if (s.includes("FROM asset_assignments WHERE asset_uuid")) return [[{ n: 0 }], []];
      return [[], []];
    });
    const result = await assets.reinstateAsset({ orgId: ORG, actorUuid: ADMIN, assetUuid: ASSET });
    expect(result.status).toBe("maintenance");
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
      [{ uuid: ASSET, status: "assigned", holder_name: "Kinza", open_jobs: 0 }],
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
      .mockResolvedValueOnce([[[{ n: "150.00" }]], []]);

    const summary = await assets.assetSummary({ orgId: ORG });
    expect(summary.by_status.available).toBe(2);
    // A scrapped laptop is not part of what the company still owns.
    expect(summary.total_value).toBe(1000);
    expect(summary.maintenance_spend).toBe(150);
  });
});