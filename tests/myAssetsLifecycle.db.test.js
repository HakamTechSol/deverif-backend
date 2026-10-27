import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import dotenv from "dotenv";
import { purgeTestOrgs, createOrgRegistry } from "./helpers/dbCleanup.js";

/**
 * THE WHOLE CHAIN, against a real database: assign an asset to an employee, then
 * ask that employee's own endpoint what they hold.
 *
 * This is the test the module was missing. Every unit test passed while the page
 * was empty, because the unit tests mock pool.query - which returns rows for any
 * SQL string it is handed and therefore cannot notice that the JOIN key, the
 * "currently held" filter, or the user-to-employee lookup disagree with what the
 * assign path writes.
 *
 * The link between the two halves is invisible from either side:
 *
 *   assign writes        asset_assignments.employee_uuid = <employees.uuid>
 *   /my/assets reads     employees.linked_user_uuid     = <users.uuid>   (from the JWT)
 *                        asset_assignments.employee_uuid = <employees.uuid>
 *
 * Both hops have to agree or the employee sees an empty page while the asset is
 * unambiguously assigned and showing as "assigned" in the staff view.
 */

dotenv.config({ quiet: true });

function cfg() {
  return {
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME,
  };
}

const reachable = await (async () => {
  const mysql = (await import("mysql2/promise")).default;
  try {
    const c = await mysql.createConnection(cfg());
    await c.query("SELECT 1");
    await c.end();
    return true;
  } catch {
    return false;
  }
})();

let db;
let assets;
let tagN = 0;

beforeAll(async () => {
  if (!reachable) return;
  const mysql = (await import("mysql2/promise")).default;
  db = await mysql.createConnection(cfg());
  vi.resetModules();
  // Real service, real pool.
  assets = await import("../src/services/assets.service.js");
});

afterAll(async () => {
  // Safety net. The per-test `finally` blocks already purge, so in a healthy run
  // this finds nothing. It exists because this suite seeds an organization PER
  // TEST inside the test body: if a suite is interrupted, or a seed throws after
  // inserting its org but before the `try` is entered, the `finally` has nothing
  // to clean and the fixture would be orphaned for good. Sweeping the registry
  // reclaims anything the per-test path missed, on every run, pass or fail.
  await purgeTestOrgs(db, seededOrgs.ids);
  await db?.end();
});

/** Every organization this run created, whatever the individual tests did. */
const seededOrgs = createOrgRegistry();

/** Unique-per-run names so repeated or parallel runs cannot collide. */
const uniq = () => `IT${Date.now().toString(36)}${(tagN += 1)}`;

/** An org, employee and user that are ours alone and cleaned up afterwards. */
async function seedEmployee({ withPortalAccount = true } = {}) {
  const name = uniq();
  const [org] = await db.query("INSERT INTO organizations (name) VALUES (?)", [name]);
  const orgId = org.insertId;
  // Recorded immediately, before any child row exists, so the afterAll sweep
  // covers the window between this insert and the caller's try/finally.
  seededOrgs.track(orgId);

  const [emp] = await db.query(
    `INSERT INTO employees (organization_id, uuid, full_name, status)
     VALUES (?, UUID(), ?, 'active')`,
    [orgId, name],
  );

  let userUuid = null;
  if (withPortalAccount) {
    // users.organization is an FK to organizations.id despite the plain name.
    const [u] = await db.query(
      `INSERT INTO users (uuid, full_name, email, password, status, org_role, is_verified, organization)
       VALUES (UUID(), ?, ?, 'x', 'active', 'employee', 'yes', ?)`,
      [name, `${name}@test.local`, orgId],
    );
    userUuid = u.insertId;
    await db.query(
      "UPDATE employees SET linked_user_uuid=(SELECT uuid FROM users WHERE id=?) WHERE id=?",
      [userUuid, emp.insertId],
    );
  }

  const [[linked]] = await db.query("SELECT uuid, linked_user_uuid FROM employees WHERE id=?", [emp.insertId]);
  return { orgId, employeeUuid: linked.uuid, userUuid: linked.linked_user_uuid };
}

async function seedAsset(orgId, employeeUuid) {
  const [cat] = await db.query("INSERT INTO asset_categories (organization_id, name) VALUES (?, ?)", [
    orgId,
    uniq(),
  ]);
  const [[categoryUuid]] = await db.query("SELECT uuid FROM asset_categories WHERE id=?", [cat.insertId]);
  const [[emp]] = await db.query("SELECT uuid FROM employees WHERE uuid=?", [employeeUuid]);

  const [a] = await db.query(
    `INSERT INTO assets (organization_id, category_uuid, asset_tag, name, model_details, serial_number, status)
     VALUES (?, ?, ?, ?, ?, ?, 'available')`,
    [orgId, categoryUuid.uuid, uniq(), "ThinkPad", "T14 Gen 3", "SN-IT-1"],
  );
  const [[row]] = await db.query("SELECT uuid FROM assets WHERE id=?", [a.insertId]);
  return row.uuid;
}

/**
 * Delete an organization and everything under it.
 *
 * This used to be a bare `DELETE FROM organizations WHERE id=?` wrapped in
 * `.catch(() => {})`. That could never succeed: `employees.organization_id` is
 * RESTRICT, and seedEmployee always creates an employee, so the statement threw and
 * the catch swallowed it. Teardown reported success while removing nothing, and
 * every run of this file leaked its orgs, employees, users and assets.
 *
 * purgeTestOrgs discovers the org-scoped tables and clears them with FK checks
 * suspended, so it does not depend on a hand-maintained delete order.
 */
async function cleanup({ orgId }) {
  if (orgId === null || orgId === undefined) return;
  await purgeTestOrgs(db, [orgId]);
}

describe.skipIf(!reachable)("assign -> /my/assets, against a real database", () => {
  it("an assigned asset appears immediately for that employee", async () => {
    const seed = await seedEmployee();
    try {
      const assetUuid = await seedAsset(seed.orgId, seed.employeeUuid);

      // Before: nothing.
      expect(await assets.listMyAssets({ orgId: seed.orgId, userUuid: seed.userUuid })).toEqual([]);

      await assets.assignAsset({
        orgId: seed.orgId,
        actorUuid: null,
        assetUuid,
        employeeUuid: seed.employeeUuid,
      });

      // After: the employee sees it, with no extra step in between.
      const rows = await assets.listMyAssets({ orgId: seed.orgId, userUuid: seed.userUuid });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        uuid: assetUuid,
        model_details: "T14 Gen 3",
        serial_number: "SN-IT-1",
      });
      expect(rows[0].asset_tag).toBeTruthy();
      expect(rows[0].category_name).toBeTruthy();
      expect(rows[0].assigned_at).toBeTruthy();
    } finally {
      await cleanup(seed);
    }
  });

  it("disappears again once returned", async () => {
    const seed = await seedEmployee();
    try {
      const assetUuid = await seedAsset(seed.orgId, seed.employeeUuid);
      await assets.assignAsset({
        orgId: seed.orgId,
        actorUuid: null,
        assetUuid,
        employeeUuid: seed.employeeUuid,
      });
      expect(await assets.listMyAssets({ orgId: seed.orgId, userUuid: seed.userUuid })).toHaveLength(1);

      await assets.returnAsset({ orgId: seed.orgId, actorUuid: null, assetUuid, condition: "good" });
      // A returned laptop is not "currently assigned", and showing it as theirs
      // invites a support ticket about a device they do not have.
      expect(await assets.listMyAssets({ orgId: seed.orgId, userUuid: seed.userUuid })).toEqual([]);
    } finally {
      await cleanup(seed);
    }
  });

  it("is not visible to a DIFFERENT employee in the same organization", async () => {
    const first = await seedEmployee();
    const second = await seedEmployee();
    let other = null;
    try {
      // Move the second employee into the FIRST org, which is the interesting
      // case: the filter has to be the employee, not merely the tenant. A
      // tenant-only filter would hand colleague B colleague A's laptop.
      other = await seedEmployee();
      await db.query("UPDATE employees SET organization_id=? WHERE uuid=?", [
        first.orgId,
        other.employeeUuid,
      ]);
      await db.query("UPDATE users SET organization=? WHERE uuid=?", [first.orgId, other.userUuid]);

      const assetUuid = await seedAsset(first.orgId, first.employeeUuid);
      await assets.assignAsset({
        orgId: first.orgId,
        actorUuid: null,
        assetUuid,
        employeeUuid: first.employeeUuid,
      });

      expect(await assets.listMyAssets({ orgId: first.orgId, userUuid: first.userUuid })).toHaveLength(1);
      expect(await assets.listMyAssets({ orgId: first.orgId, userUuid: other.userUuid })).toEqual([]);
      expect(await assets.listMyAssets({ orgId: first.orgId, userUuid: second.userUuid })).toEqual([]);
    } finally {
      await cleanup(first);
      await cleanup(second);
      await cleanup({ orgId: other?.orgId });
    }
  });

  it("is not visible across organizations even with the same employee uuid shape", async () => {
    const a = await seedEmployee();
    const b = await seedEmployee();
    try {
      const assetUuid = await seedAsset(a.orgId, a.employeeUuid);
      await assets.assignAsset({
        orgId: a.orgId,
        actorUuid: null,
        assetUuid,
        employeeUuid: a.employeeUuid,
      });

      expect(await assets.listMyAssets({ orgId: a.orgId, userUuid: a.userUuid })).toHaveLength(1);
      expect(await assets.listMyAssets({ orgId: b.orgId, userUuid: b.userUuid })).toEqual([]);
    } finally {
      await cleanup(a);
      await cleanup(b);
    }
  });

  it("returns nothing for an employee with no portal account", async () => {
    // The real-world gap: HR assigns a laptop to someone who has no login, and
    // because /my/assets resolves the employee FROM the JWT, that person can
    // never see it. The endpoint is right to return empty; the fix belongs in the
    // assign flow warning about it.
    const seed = await seedEmployee({ withPortalAccount: false });
    try {
      expect(seed.userUuid).toBeNull();
      const assetUuid = await seedAsset(seed.orgId, seed.employeeUuid);
      await assets.assignAsset({
        orgId: seed.orgId,
        actorUuid: null,
        assetUuid,
        employeeUuid: seed.employeeUuid,
      });

      // With no user to ask as, there is nothing to return.
      expect(await assets.listMyAssets({ orgId: seed.orgId, userUuid: null })).toEqual([]);
    } finally {
      await cleanup(seed);
    }
  });

  it("hides an asset that is on a repair bench", async () => {
    const seed = await seedEmployee();
    try {
      const assetUuid = await seedAsset(seed.orgId, seed.employeeUuid);
      await assets.assignAsset({
        orgId: seed.orgId,
        actorUuid: null,
        assetUuid,
        employeeUuid: seed.employeeUuid,
      });
      expect(await assets.listMyAssets({ orgId: seed.orgId, userUuid: seed.userUuid })).toHaveLength(1);

      const { maintenance_uuid } = await assets.reportMaintenance({
        orgId: seed.orgId,
        actorUuid: null,
        assetUuid,
        data: { title: "Screen" },
      });
      expect(maintenance_uuid).toBeTruthy();

      // Belt and braces behind the syncStatus invariant: exposing a broken
      // laptop as usable is worse than hiding it.
      expect(await assets.listMyAssets({ orgId: seed.orgId, userUuid: seed.userUuid })).toEqual([]);

      await assets.completeMaintenance({
        orgId: seed.orgId,
        actorUuid: null,
        jobUuid: maintenance_uuid,
        data: {},
      });
      // Repaired and still legitimately held, so it comes back.
      expect(await assets.listMyAssets({ orgId: seed.orgId, userUuid: seed.userUuid })).toHaveLength(1);
    } finally {
      await cleanup(seed);
    }
  });
});