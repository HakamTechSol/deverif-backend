import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import mysql from "mysql2/promise";
import dotenv from "dotenv";
import { signAccessToken } from "../src/utils/jwt.js";
import { hasPermission } from "../src/utils/permissions.js";
import { purgeTestOrgs } from "./helpers/dbCleanup.js";

/**
 * DOES requireRole ACTUALLY CARRY feature_access?
 *
 * Asked as a standing question rather than a one-off, because the last audit found
 * this exact defect and a file-level grep cannot answer it. requireRole's SELECT
 * omitted feature_access while authUser's included it. Nothing on a requireRole
 * route read the column, so nothing failed, and the two middlewares simply disagreed.
 *
 * It would have bitten the moment a requirePermission() landed after requireRole:
 * parseFeatureAccess(undefined) returns the DEFAULTS, and for a default-deny
 * permission that means DENIED — so every sub-admin who had been granted it would
 * have been refused, with no error anywhere to explain why.
 *
 * WHY THIS IS A REAL DATABASE TEST RATHER THAN A MOCK.
 *
 * A mocked pool returns whatever the mock is told to, so it would happily answer a
 * query with a column it does not select and the test would pass. The failure mode
 * being guarded against is precisely a column missing from a SELECT string, and the
 * only thing that can catch that is executing the string. This also covers the round
 * trip — longtext JSON column -> mysql2 -> req.user -> parseFeatureAccess — which a
 * string comparison of the SELECT would not: a column can be selected and still
 * arrive unusable.
 *
 * It goes through a real signed token and the real middleware chain, because the
 * claim-vs-database question is the one that matters. requireRole deliberately
 * re-reads the user row rather than trusting the token, so a permission revoked a
 * second ago must take effect immediately.
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

/**
 * A distinctive map, so "the column came back" is distinguishable from "req.user
 * happens to have the right shape". Two keys on, two off.
 */
const FEATURE_ACCESS = {
  manage_separation: true,
  approve_expenses: true,
  manage_employees: false,
  approve_request: false,
};

let db;
let orgId;
let app;
const userUuids = {};

beforeAll(async () => {
  if (!HAS_DB) return;
  db = await mysql.createConnection(cfg);

  const [org] = await db.query("INSERT INTO organizations (uuid, name) VALUES (UUID(), ?)", [
    `RequireRole probe ${Date.now()}`,
  ]);
  orgId = org.insertId;

  // users has a NOT NULL cnic and a required uuid; see the schema. Created with the
  // minimum that satisfies it, plus the feature_access map under test.
  for (const [role, tag] of [
    ["sub_admin", "Permitted"],
    ["sub_admin", "Bare"],
    ["org_admin", "Admin"],
  ]) {
    const uuid = crypto.randomUUID();
    userUuids[tag] = uuid;
    const featureAccess =
      tag === "Permitted"
        ? JSON.stringify(FEATURE_ACCESS)
        : tag === "Bare"
          ? null // the legacy shape: a column that predates every permission
          : JSON.stringify({});
    await db.query(
      `INSERT INTO users (uuid, organization, full_name, email, cnic, status, org_role, feature_access)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      [
        uuid,
        orgId,
        `${tag} User`,
        `${tag.toLowerCase()}-${uuid.slice(0, 8)}@example.com`,
        `35202-${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}-${Math.floor(Math.random() * 9) + 1}`,
        role,
        featureAccess,
      ],
    );
  }

  // The REAL middleware chain: requireRole, then the REAL requirePermission
  // middleware, then a handler that reports what each layer actually saw.
  const requireRole = (await import("../src/middleware/requireRole.js")).default;
  const requirePermission = (await import("../src/middleware/requirePermission.js")).default;

  app = express();
  app.get(
    "/echo",
    requireRole("org_admin", "sub_admin"),
    (req, res) => res.json({ user: req.user }),
  );
  app.get(
    "/separation",
    requireRole("org_admin", "sub_admin"),
    requirePermission("manage_separation"),
    (req, res) => res.json({ ok: true }),
  );
  app.get(
    "/recruitment",
    requireRole("org_admin", "sub_admin"),
    requirePermission("manage_recruitment"),
    (req, res) => res.json({ ok: true }),
  );

  // Mounted so the 403 body is observable. Without it Express answers with its own
  // HTML error page and the test could assert only the status code — which would
  // leave the "names the missing permission" guarantee unpinned.
  //
  // `statusCode`, not `status` — that is ApiError's field name, and getting it wrong
  // here turns every 403 into a 500 and quietly hides the assertion it was added for.
  app.use((err, _req, res, _next) => {
    res.status(err.statusCode || 500).json({ message: err.message, code: err.code ?? null });
  });
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
for (const uuid of Object.values(userUuids)) {
      await db.query("DELETE FROM users WHERE uuid=?", [uuid]);
    }
  
  } finally {
    await purgeTestOrgs(db, [orgId]);
    await db.end();
  }});

function tokenFor(tag) {
  const row = userUuids[tag];
  expect(row, `no probe user seeded for "${tag}"`).toBeTruthy();
  // requireRole cross-checks the token organization claim against the live row and
  // refuses a mismatch, so the claim has to be present AND correct. Omitting it
  // fails as 403 rather than 401, which is why the earlier run was confusing.
  return signAccessToken({ userId: row, type: "user", role: "user", organization: orgId });
}

const echo = (tag) => request(app).get("/echo").set("Authorization", `Bearer ${tokenFor(tag)}`);

describe.runIf(HAS_DB)("requireRole really does load feature_access", () => {
  it("req.user.feature_access is present and carries the stored column", async () => {
    const res = await echo("Permitted");
    expect(res.status).toBe(200);

    // It arrives as a JSON STRING, because the column is longtext. Asserting the raw
    // wire shape deliberately: this is exactly what requirePermission receives, and
    // parseFeatureAccess is what has to survive it. A future change that made
    // middleware pre-parse the column would break the string branch silently.
    expect(typeof res.body.user.feature_access).toBe("string");
    expect(JSON.parse(res.body.user.feature_access)).toEqual(FEATURE_ACCESS);

    // And the whole point: the permission is readable, not merely present.
    expect(hasPermission(res.body.user, "manage_separation")).toBe(true);
    expect(hasPermission(res.body.user, "manage_assets")).toBe(false);
  });

  it("a user whose column is NULL gets null, not undefined and not a default map", async () => {
    // The distinction matters. `undefined` and `null` both fall through to the
    // defaults inside parseFeatureAccess, so they behave identically there — but only
    // because that function handles both. An accidental spread or a truthiness check
    // downstream would treat them differently, so the boundary is pinned here.
    const res = await echo("Bare");
    expect(res.status).toBe(200);
    expect(res.body.user.feature_access).toBeNull();
    expect("feature_access" in res.body.user).toBe(true);
    // NULL must resolve to the DEFAULTS: self-service on, delegated authority off.
    // Not an empty map — that would read as "nothing permitted at all", including
    // attendance and leave.
    expect(hasPermission(res.body.user, "attendance")).toBe(true);
    expect(hasPermission(res.body.user, "manage_separation")).toBe(false);
  });

  it("hasPermission reads the LIVE column, so a revocation takes effect at once", async () => {
    // requireRole re-reads the user row rather than trusting the token, so a
    // permission revoked a moment ago is not honoured until the token expires.
    const user = await db.query(
      "SELECT feature_access FROM users WHERE uuid=?",
      [userUuids.Permitted],
    );
    expect(hasPermission({ org_role: "sub_admin", feature_access: user[0][0].feature_access }, "manage_separation")).toBe(true);

    await db.query(
      "UPDATE users SET feature_access=? WHERE uuid=?",
      [JSON.stringify({ manage_separation: false }), userUuids.Permitted],
    );
    try {
      const after = await db.query("SELECT feature_access FROM users WHERE uuid=?", [userUuids.Permitted]);
      expect(hasPermission({ org_role: "sub_admin", feature_access: after[0][0].feature_access }, "manage_separation")).toBe(false);
    } finally {
      await db.query("UPDATE users SET feature_access=? WHERE uuid=?", [
        JSON.stringify(FEATURE_ACCESS),
        userUuids.Permitted,
      ]);
    }
  });

  it("an org_admin's own feature_access is loaded too, not short-circuited away", async () => {
    const res = await echo("Admin");
    expect(res.status).toBe(200);
    // org_admin passes on the role alone, so this column is never consulted for them —
    // but "never consulted" must not mean "not loaded", or the next gate that does
    // read it breaks for exactly this user.
    expect(JSON.parse(res.body.user.feature_access)).toEqual({});
  });
});

describe.runIf(HAS_DB)("requirePermission placed after requireRole behaves", () => {
  it("admits a sub-admin holding the permission", async () => {
    const res = await request(app)
      .get("/separation")
      .set("Authorization", `Bearer ${tokenFor("Permitted")}`);
    expect(res.status).toBe(200);
  });

  it("refuses a sub-admin without it, and names the permission", async () => {
    const res = await request(app)
      .get("/separation")
      .set("Authorization", `Bearer ${tokenFor("Bare")}`);
    expect(res.status).toBe(403);
    // A bare "forbidden" cannot tell the user whether they need a permission or a
    // different account.
    expect(res.body.message ?? res.body.error?.message ?? "").toContain("manage_separation");
  });

  it("admits an org_admin who holds none of it", async () => {
    const res = await request(app)
      .get("/separation")
      .set("Authorization", `Bearer ${tokenFor("Admin")}`);
    // The regression this whole file exists for: were the role gate and the
    // permission gate swapped, or the permission checked before the role, this would
    // be 403 and org_admins would be locked out of their own company.
    expect(res.status).toBe(200);
  });

  it("refuses a permission nobody has granted yet, rather than erroring on an unknown key", async () => {
    // manage_recruitment is added alongside this file's work; before it exists,
    // hasPermission on an unknown key must resolve to DENIED, not to undefined (which
    // would be falsy-but-silent) and not throw.
    const res = await request(app)
      .get("/recruitment")
      .set("Authorization", `Bearer ${tokenFor("Bare")}`);
    expect(res.status).toBe(403);
  });
});
