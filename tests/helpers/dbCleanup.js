/**
 * Leak-proof teardown for the *.db.test.js suites.
 *
 * WHY THIS EXISTS. The suites each create an organization plus a tree of children,
 * and each used to delete that tree with a hand-ordered list of `DELETE FROM ...`
 * statements followed by `DELETE FROM organizations`. Two things made that leak:
 *
 *   1. It is order-dependent, and the order depends on the CURRENT foreign-key
 *      graph. `employees.organization_id` is RESTRICT, so deleting the org before
 *      the employees throws - and in at least one suite that throw was swallowed by
 *      `.catch(() => {})`, so teardown "succeeded" while deleting nothing. That suite
 *      leaked its entire fixture on every run, passing or failing.
 *   2. The final delete was the last statement of each test body, so any failed
 *      assertion skipped it. A suite whose tests fail leaves its org, employees,
 *      users and assets in the database forever, and the next run's counts silently
 *      include them.
 *
 * WHAT THIS DOES. It discovers the org-scoped tables from information_schema rather
 * than hardcoding them - so it cannot drift when a migration adds one - and clears
 * them with FK enforcement suspended for the duration. Suspension is scoped to this
 * dedicated test connection and restored in a `finally`, so a failure mid-teardown
 * cannot leave checks off.
 *
 * Deleting by a SET OF ORGS means a suite that seeds several tenants cleans all of
 * them in one call, including ones seeded inside a test that then failed.
 */

/** Tables with an organization_id column, discovered rather than assumed. */
async function orgScopedTables(db) {
  const [rows] = await db.query(
    `SELECT table_name AS t
       FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND column_name = 'organization_id'
      ORDER BY table_name`,
  );
  return rows.map((r) => r.t);
}

/**
 * Delete every row belonging to any of `orgIds`, then close the connection.
 *
 * Always attempts the organization delete itself, even when a child delete throws,
 * and never throws: teardown that reports failure tells you nothing you can act on
 * and only masks the assertion that actually failed.
 *
 * @returns {Promise<{orgs:number, rows:number}>} counts, for logging only.
 */
export async function purgeTestOrgs(db, orgIds) {
  const ids = [...new Set((orgIds ?? []).filter((v) => v !== null && v !== undefined))];
  const result = { orgs: 0, rows: 0 };
  if (!db || !ids.length) return result;

  const placeholders = ids.map(() => "?").join(",");

  try {
    await db.query("SET FOREIGN_KEY_CHECKS = 0");

    for (const table of await orgScopedTables(db)) {
      // `payment` uses SET NULL and a few tables are shared infrastructure; a
      // missing table here would be a hard error, so each is isolated.
      try {
        const [res] = await db.query(
          `DELETE FROM \`${table}\` WHERE organization_id IN (${placeholders})`,
          ids,
        );
        result.rows += res?.affectedRows ?? 0;
      } catch {
        // A table that cannot be cleaned is not a reason to abandon the rest;
        // the org delete below is what actually reclaims the fixture.
      }
    }

    // `users.organization` is an FK named `organization`, not `organization_id`,
    // so the loop above never sees it. These rows would otherwise survive the org
    // delete and accumulate.
    try {
      const [res] = await db.query(`DELETE FROM users WHERE organization IN (${placeholders})`, ids);
      result.rows += res?.affectedRows ?? 0;
    } catch {
      /* best effort */
    }

    try {
      const [res] = await db.query(`DELETE FROM organizations WHERE id IN (${placeholders})`, ids);
      result.orgs = res?.affectedRows ?? 0;
    } catch {
      /* best effort */
    }
  } finally {
    // MUST be restored. Leaving it off would silently disable FK enforcement for
    // whatever runs on this connection next.
    try {
      await db.query("SET FOREIGN_KEY_CHECKS = 1");
    } catch {
      /* connection is going away anyway */
    }
  }

  return result;
}

/**
 * Registry for suites that create organizations inside individual tests, where a
 * failure means the per-test `finally` may be the only thing that knows about them.
 *
 *   const reg = createOrgRegistry();
 *   const orgId = await reg.track(await insertOrg());
 *   afterAll(async () => purgeTestOrgs(db, reg.ids));
 */
export function createOrgRegistry() {
  const ids = [];
  return {
    ids,
    /** Record an org id (or a `{orgId}` / `{organizationId}` object) for later purge. */
    track(value) {
      const id = typeof value === "object" && value !== null ? value.orgId ?? value.organizationId ?? value.id : value;
      if (id !== null && id !== undefined && !ids.includes(id)) ids.push(id);
      return id;
    },
    trackAll(values) {
      for (const v of values ?? []) this.track(v);
      return ids;
    },
  };
}