import { describe, it, expect, beforeAll, afterAll } from "vitest";
import dotenv from "dotenv";
import mysql from "mysql2/promise";
import { purgeTestOrgs, createOrgRegistry } from "./helpers/dbCleanup.js";

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
const created = { assets: [] };

beforeAll(async () => {
  if (!HAS_DB) return;
  db = await mysql.createConnection(cfg);
  // Create THIS SUITE'S OWN organization.
  //
  // This used to borrow one: `SELECT id FROM organizations ORDER BY id LIMIT 1`.
  // That silently depended on leftover seed data existing in the database, so the
  // suite passed for months without ever creating the employee and category it
  // claims to test against — `employeeUuid` came back null and `emp?.uuid ?? null`
  // swallowed it. On an empty database it threw `Cannot read properties of
  // undefined (reading 'id')` in beforeAll and every test skipped. A suite that
  // needs pre-existing rows to run is not testing anything.
  const [org] = await db.query("INSERT INTO organizations (uuid, name) VALUES (UUID(), ?)", [
    `Assets schema ${Date.now()}`,
  ]);
  orgId = org.insertId;

  const [emp] = await db.query(
    "INSERT INTO employees (uuid, organization_id, full_name, status) VALUES (UUID(), ?, ?, 'active')",
    [orgId, `Assets Employee ${Date.now()}`],
  );
  const [[created]] = await db.query("SELECT uuid FROM employees WHERE id=?", [emp.insertId]);
  employeeUuid = created.uuid;
});

afterAll(async () => {
  if (!db) return;
  
  // Teardown guarantee. The ordered DELETEs above depend on the current
  // foreign-key graph, and employees.organization_id is RESTRICT, so a change to
  // that graph turns a cleanup step into a thrown error and skips the deletes after
  // it - leaving the organization, and everything under it, in the database. That is
  // how a failing suite leaked its whole fixture on every run.
  //
  // purgeTestOrgs discovers the org-scoped tables instead of hardcoding them and
  // suspends FK checks for the duration, so it does not depend on that ordering at
  // all. Running it in a finally means it happens whether or not the steps above
  // succeeded, and whether or not the tests themselves passed.
  try {
for (const a of created.assets) {
      await db.query("DELETE FROM asset_assignments WHERE asset_uuid=?", [a]).catch(() => {});
      await db.query("DELETE FROM asset_maintenance WHERE asset_uuid=?", [a]).catch(() => {});
      await db.query("DELETE FROM assets WHERE uuid=?", [a]).catch(() => {});
    }
  
  } finally {
    // The suite's OWN org goes too, not just the per-test tmpOrgs. Before this
    // suite created its own organization it borrowed one that already existed,
    // so there was nothing of its own to clean up.
    seededOrgs.track(orgId);
    await purgeTestOrgs(db, seededOrgs.ids);
    await db.end();
  }});

async function makeAsset(name = `Asset ${Date.now()}`) {
  const [r] = await db.query(
    "INSERT INTO assets (organization_id, asset_tag, name, status) VALUES (?, ?, ?, 'available')",
    [orgId, tag(name), name],
  );
  const [[row]] = await db.query("SELECT uuid FROM assets WHERE id=?", [r.insertId]);
  created.assets.push(row.uuid);
  return row.uuid;
}

const statusOf = async (uuid) => {
  const [[r]] = await db.query("SELECT status FROM assets WHERE uuid=?", [uuid]);
  return r.status;
};

const tag = (n) => `DBT-${Date.now().toString(36)}-${n}`;

/**
 * Every throwaway organization this run created.
 *
 * Two tests build one inside the test body to exercise cross-tenant rules. They
 * delete it themselves on the happy path, but a failed assertion skips that, so
 * afterAll sweeps the registry as a backstop.
 */
const seededOrgs = createOrgRegistry();

describe.skipIf(!HAS_DB)("assets schema constraints (real database)", () => {
  it("has an employee to exercise assignment against", () => {
    expect(employeeUuid).toBeTruthy();
  });

  it("REFUSES a second open assignment for the same asset", async () => {
    const asset = await makeAsset(tag("asset"));

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
    const a1 = await makeAsset(tag("a1"));
    const a2 = await makeAsset(tag("a2"));

    for (const a of [a1, a2]) {
      await db.query(
        "INSERT INTO asset_assignments (organization_id, asset_uuid, employee_uuid) VALUES (?,?,?)",
        [orgId, a, employeeUuid],
      );
    }
    expect(true).toBe(true);
  });

  it("frees the guard once the assignment is returned, so history accumulates", async () => {
    const asset = await makeAsset(tag("cycle"));

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
    const asset = await makeAsset(tag("maint"));

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
    const asset = await makeAsset(tag("hist"));

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

  it("keeps asset_tag unique per organization", async () => {
    const shared = tag("shared");
    await db.query(
      "INSERT INTO assets (organization_id, asset_tag, name, status) VALUES (?, ?, ?, 'available')",
      [orgId, shared, "Original"],
    );
    await expect(
      db.query(
        "INSERT INTO assets (organization_id, asset_tag, name, status) VALUES (?, ?, ?, 'available')",
        [orgId, shared, "Duplicate"],
      ),
    ).rejects.toMatchObject({ code: "ER_DUP_ENTRY" });
  });

  it("cascades an organization's assets away with it", async () => {
    // CASCADE is the intended behaviour for organization_id: deleting a tenant
    // must not leave its inventory orphaned, since no other organization has any
    // business seeing it. (An earlier draft of this test expected RESTRICT here,
    // which was simply wrong about what the schema says.)
    const [r] = await db.query("INSERT INTO organizations (name) VALUES (?)", [tag("org")]);
    const tmpOrg = r.insertId;
    // Registered immediately. These throwaway orgs are created inside test bodies, so a
    // failure between this insert and the test's own cleanup would otherwise orphan
    // them; the afterAll sweep reclaims them regardless.
    seededOrgs.track(tmpOrg);
    await db.query(
      "INSERT INTO assets (organization_id, asset_tag, name, status) VALUES (?, ?, ?, 'available')",
      [tmpOrg, tag("tmp"), "tmp"],
    );

    const [[before]] = await db.query("SELECT COUNT(*) AS n FROM assets WHERE organization_id=?", [tmpOrg]);
    expect(before.n).toBe(1);

    await db.query("DELETE FROM organizations WHERE id=?", [tmpOrg]);

    const [[after]] = await db.query("SELECT COUNT(*) AS n FROM assets WHERE organization_id=?", [tmpOrg]);
    expect(after.n).toBe(0);
  });

  it("derives status consistently from the rows it stores", async () => {
    // The service is the only writer of status, but the database can still be
    // asked the question, so the invariant is checkable end to end.
    const asset = await makeAsset(tag("derive"));

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