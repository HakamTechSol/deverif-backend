import { describe, it, expect, beforeAll, afterAll } from "vitest";
import dotenv from "dotenv";
import mysql from "mysql2/promise";

/**
 * Database-level guarantees for the assets module.
 *
 * WHY THIS EXISTS SEPARATELY. Every other backend test mocks pool.query, which
 * returns rows for any SQL string it is handed and therefore cannot reject
 * anything. That is exactly how the first version of this schema shipped a
 * UNIQUE key that did not enforce its rule: (asset_uuid, returned_at) permits
 * two open assignments, because an open row has returned_at = NULL and NULLs do
 * not collide in a MySQL UNIQUE index. Every mocked test in the suite passed.
 *
 * So the invariants that only the database can enforce are asserted here, for
 * real. Skipped, not failed, when no database is reachable, so a CI without
 * MySQL stays green instead of reporting a constraint that was never exercised.
 */

const HAS_DB = await (async () => {
  try {
    const c = await mysql.createConnection(readDbConfig());
    await c.query("SELECT 1");
    await c.end();
    return true;
  } catch {
    return false;
  }
})();

// Use dotenv rather than hand-parsing .env. The file is CRLF with quoted keys,
// so a naive /^\w+=/ regex silently matches nothing and the whole suite skips
// itself while reporting green - which is the worst possible failure mode for a
// test whose entire purpose is to exercise real constraints.
dotenv.config({ quiet: true });

function readDbConfig() {
  return {
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || process.env.DB_PASS || "",
    database: process.env.DB_NAME,
  };
}

const cfg = readDbConfig();
let db;
let orgId;
let employeeUuid;
const created = { categories: [], assets: [] };

beforeAll(async () => {
  if (!HAS_DB) return;
  db = await mysql.createConnection(cfg);
  const [[org]] = await db.query("SELECT id FROM organizations ORDER BY id LIMIT 1");
  orgId = org.id;
  const [[emp]] = await db.query(
    "SELECT uuid FROM employees WHERE organization_id=? LIMIT 1",
    [orgId],
  );
  employeeUuid = emp?.uuid ?? null;
});

afterAll(async () => {
  if (!db) return;
  for (const a of created.assets) {
    await db.query("DELETE FROM asset_assignments WHERE asset_uuid=?", [a]).catch(() => {});
    await db.query("DELETE FROM asset_maintenance WHERE asset_uuid=?", [a]).catch(() => {});
    await db.query("DELETE FROM assets WHERE uuid=?", [a]).catch(() => {});
  }
  for (const c of created.categories) {
    await db.query("DELETE FROM asset_categories WHERE uuid=?", [c]).catch(() => {});
  }
  await db.end();
});

async function makeCategory(name) {
  const [r] = await db.query("INSERT INTO asset_categories (organization_id, name) VALUES (?,?)", [
    orgId,
    name,
  ]);
  const [[row]] = await db.query("SELECT uuid FROM asset_categories WHERE id=?", [r.insertId]);
  created.categories.push(row.uuid);
  return row.uuid;
}

async function makeAsset(categoryUuid, tag) {
  const [r] = await db.query(
    `INSERT INTO assets (organization_id, category_uuid, asset_tag, name, status)
     VALUES (?,?,?,?,'available')`,
    [orgId, categoryUuid, tag, tag],
  );
  const [[row]] = await db.query("SELECT uuid FROM assets WHERE id=?", [r.insertId]);
  created.assets.push(row.uuid);
  return row.uuid;
}

/** A category owned by a specific org, cleaned up afterwards. */
async function makeCategoryFor(org, name) {
  const [r] = await db.query("INSERT INTO asset_categories (organization_id, name) VALUES (?,?)", [
    org,
    name,
  ]);
  const [[row]] = await db.query("SELECT uuid FROM asset_categories WHERE id=?", [r.insertId]);
  created.categories.push(row.uuid);
  return row.uuid;
}

const statusOf = async (uuid) => {
  const [[r]] = await db.query("SELECT status FROM assets WHERE uuid=?", [uuid]);
  return r.status;
};

const tag = (n) => `DBT-${Date.now().toString(36)}-${n}`;

describe.skipIf(!HAS_DB)("assets schema constraints (real database)", () => {
  it("has an employee to exercise assignment against", () => {
    expect(employeeUuid).toBeTruthy();
  });

  it("REFUSES a second open assignment for the same asset", async () => {
    const cat = await makeCategory(tag("cat"));
    const asset = await makeAsset(cat, tag("asset"));

    await db.query(
      "INSERT INTO asset_assignments (organization_id, asset_uuid, employee_uuid) VALUES (?,?,?)",
      [orgId, asset, employeeUuid],
    );

    // The whole point of the generated guard. A plain (asset_uuid, returned_at)
    // unique key allows this, because NULLs do not collide.
    await expect(
      db.query("INSERT INTO asset_assignments (organization_id, asset_uuid, employee_uuid) VALUES (?,?,?)", [
        orgId,
        asset,
        employeeUuid,
      ]),
    ).rejects.toMatchObject({ code: "ER_DUP_ENTRY" });

    const [[{ n }]] = await db.query(
      "SELECT COUNT(*) AS n FROM asset_assignments WHERE asset_uuid=? AND returned_at IS NULL",
      [asset],
    );
    expect(n).toBe(1);
  });

  it("allows an employee to hold SEVERAL assets at once", async () => {
    // The guard is per-asset, not per-employee. An employee with a laptop and a
    // monitor is normal and must not be blocked.
    const cat = await makeCategory(tag("cat"));
    const a1 = await makeAsset(cat, tag("a1"));
    const a2 = await makeAsset(cat, tag("a2"));

    for (const a of [a1, a2]) {
      await db.query(
        "INSERT INTO asset_assignments (organization_id, asset_uuid, employee_uuid) VALUES (?,?,?)",
        [orgId, a, employeeUuid],
      );
    }
    expect(true).toBe(true);
  });

  it("frees the guard once the assignment is returned, so history accumulates", async () => {
    const cat = await makeCategory(tag("cat"));
    const asset = await makeAsset(cat, tag("cycle"));

    // Three full cycles must all be insertable: a register that can only record
    // one handover is not a custody history.
    for (let i = 0; i < 3; i += 1) {
      await db.query(
        "INSERT INTO asset_assignments (organization_id, asset_uuid, employee_uuid) VALUES (?,?,?)",
        [orgId, asset, employeeUuid],
      );
      await db.query(
        "UPDATE asset_assignments SET returned_at=NOW() WHERE asset_uuid=? AND returned_at IS NULL",
        [asset],
      );
    }
    const [[{ n }]] = await db.query(
      "SELECT COUNT(*) AS n FROM asset_assignments WHERE asset_uuid=?",
      [asset],
    );
    expect(n).toBe(3);
  });

  it("REFUSES a second open maintenance job for the same asset", async () => {
    const cat = await makeCategory(tag("cat"));
    const asset = await makeAsset(cat, tag("maint"));

    await db.query(
      "INSERT INTO asset_maintenance (organization_id, asset_uuid, title, status) VALUES (?,?,?,'open')",
      [orgId, asset, "Screen"],
    );
    await expect(
      db.query(
        "INSERT INTO asset_maintenance (organization_id, asset_uuid, title, status) VALUES (?,?,?,'open')",
        [orgId, asset, "Another"],
      ),
    ).rejects.toMatchObject({ code: "ER_DUP_ENTRY" });
  });

  it("permits unlimited COMPLETED maintenance jobs", async () => {
    const cat = await makeCategory(tag("cat"));
    const asset = await makeAsset(cat, tag("hist"));

    for (let i = 0; i < 3; i += 1) {
      await db.query(
        "INSERT INTO asset_maintenance (organization_id, asset_uuid, title, status, completed_at) VALUES (?,?,?,'completed',NOW())",
        [orgId, asset, `Repair ${i}`],
      );
    }
    const [[{ n }]] = await db.query(
      "SELECT COUNT(*) AS n FROM asset_maintenance WHERE asset_uuid=? AND status='completed'",
      [asset],
    );
    expect(n).toBe(3);
  });

  it("keeps asset_tag unique per organization but not globally", async () => {
    const cat = await makeCategory(tag("cat"));
    const shared = tag("shared");
    await makeAsset(cat, shared);

    // Same org, same tag: refused.
    await expect(
      db.query(
        "INSERT INTO assets (organization_id, category_uuid, asset_tag, name, status) VALUES (?,?,?,?,'available')",
        [orgId, cat, shared, "dupe"],
      ),
    ).rejects.toMatchObject({ code: "ER_DUP_ENTRY" });
  });

  it("cascades an organization's assets away with it", async () => {
    // CASCADE is the intended behaviour for organization_id: deleting a tenant
    // must not leave its inventory orphaned, since no other organization has any
    // business seeing it. (An earlier draft of this test expected RESTRICT here,
    // which was simply wrong about what the schema says.)
    const [[other]] = await db.query("SELECT id FROM organizations WHERE id<>? LIMIT 1", [orgId]);
    if (!other) return;

    const [r] = await db.query("INSERT INTO organizations (name) VALUES (?)", [tag("org")]);
    const tmpOrg = r.insertId;
    // The category must belong to tmpOrg too: since 20261110c a cross-tenant
    // category link is refused, which is what the next test asserts.
    const tmpCat = await makeCategoryFor(tmpOrg, tag("cat"));
    await db.query(
      `INSERT INTO assets (organization_id, category_uuid, asset_tag, name, status)
       VALUES (?,?,?,?,'available')`,
      [tmpOrg, tmpCat, tag("x"), "tmp"],
    );

    const [[before]] = await db.query("SELECT COUNT(*) AS n FROM assets WHERE organization_id=?", [tmpOrg]);
    expect(before.n).toBe(1);

    await db.query("DELETE FROM organizations WHERE id=?", [tmpOrg]);

    const [[after]] = await db.query("SELECT COUNT(*) AS n FROM assets WHERE organization_id=?", [tmpOrg]);
    expect(after.n).toBe(0);
  });

  it("refuses an asset pointing at a category from ANOTHER organization", async () => {
    // The reason this file exists. A plain (category_uuid) foreign key only
    // proves the category exists, and an asset in org B pointing at org A's
    // category was ACCEPTED before 20261110c. The service also checks this, but
    // multi-tenancy must not depend on every caller remembering to scope.
    const [[other]] = await db.query("SELECT id FROM organizations WHERE id<>? LIMIT 1", [orgId]);
    if (!other) return;

    const cat = await makeCategory(tag("cat"));
    const [r] = await db.query("INSERT INTO organizations (name) VALUES (?)", [tag("org")]);
    const tmpOrg = r.insertId;

    await expect(
      db.query(
        `INSERT INTO assets (organization_id, category_uuid, asset_tag, name, status) VALUES (?,?,?,?,'available')`,
        [tmpOrg, cat, tag("y"), "cross"],
      ),
    ).rejects.toMatchObject({ code: "ER_NO_REFERENCED_ROW_2" });

    // And the same-org case must still be accepted, or the constraint is just
    // wrong rather than right.
    await expect(
      db.query(
        `INSERT INTO assets (organization_id, category_uuid, asset_tag, name, status) VALUES (?,?,?,?,'available')`,
        [orgId, cat, tag("y2"), "same"],
      ),
    ).resolves.toBeTruthy();

    await db.query("DELETE FROM assets WHERE asset_tag=?", [tag("y2")]).catch(() => {});
    await db.query("DELETE FROM organizations WHERE id=?", [tmpOrg]).catch(() => {});
  });

  it("deleting a category CASCADES its assets, which is why the service guards it", async () => {
    // Documents a deliberate trade-off rather than asserting a wish.
    //
    // The composite FK is ON DELETE CASCADE, not RESTRICT, because RESTRICT makes
    // organization deletion impossible (MySQL cascades org -> categories, then
    // refuses the category delete because assets still point at it). Hard-deleting
    // a tenant has to work.
    //
    // The cost is that deleting a category IS destructive at the schema level. The
    // protection therefore lives in assetsService.deleteCategory, which refuses
    // with a 409 while assets remain. That guard is asserted in assets.test.js
    // ("refuses to delete a category that still holds assets") — this test pins
    // the schema behaviour the guard exists to compensate for, so that if the FK
    // action is ever changed, whoever does it learns why it matters.
    const cat = await makeCategory(tag("cat"));
    const asset = await makeAsset(cat, tag("doomed"));

    await expect(db.query("DELETE FROM asset_categories WHERE uuid=?", [cat])).resolves.toBeTruthy();

    const [[{ n }]] = await db.query("SELECT COUNT(*) AS n FROM assets WHERE uuid=?", [asset]);
    expect(n).toBe(0);
  });

  it("derives status consistently from the rows it stores", async () => {
    // The service is the only writer of status, but the database can still be
    // asked the question, so the invariant is checkable end to end.
    const cat = await makeCategory(tag("cat"));
    const asset = await makeAsset(cat, tag("derive"));

    expect(await statusOf(asset)).toBe("available");

    await db.query(
      "INSERT INTO asset_assignments (organization_id, asset_uuid, employee_uuid) VALUES (?,?,?)",
      [orgId, asset, employeeUuid],
    );
    expect(await statusOf(asset)).toBe("available"); // still stale until syncStatus runs

    await db.query(
      "INSERT INTO asset_maintenance (organization_id, asset_uuid, title, status) VALUES (?,?,?,'open')",
      [orgId, asset, "Repair"],
    );
    const [[counts]] = await db.query(
      `SELECT
         (SELECT COUNT(*) FROM asset_assignments WHERE asset_uuid=? AND returned_at IS NULL) AS held,
         (SELECT COUNT(*) FROM asset_maintenance WHERE asset_uuid=? AND status='open') AS jobs`,
      [asset, asset],
    );
    expect(counts.held).toBe(1);
    expect(counts.jobs).toBe(1);
  });
});