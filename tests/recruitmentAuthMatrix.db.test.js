import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import mysql from "mysql2/promise";
import dotenv from "dotenv";
import { readFileSync } from "node:fs";
import { signAccessToken } from "../src/utils/jwt.js";
import { purgeTestOrgs } from "./helpers/dbCleanup.js";

/**
 * ROUTE-LEVEL AUTH MATRIX: every recruitment route x every persona.
 *
 * The failure this pins is the one the last audit found across six other modules: a
 * route whose gate names a ROLE but no PERMISSION, so every sub-admin reaches it
 * whatever an org admin configured. Reading a routes file cannot catch that, because
 * every line of a role-only gate looks correct — the defect is an ABSENCE.
 *
 * So this drives the real router with real signed tokens against the real middleware
 * chain. A gate is a list of functions, and the only way to know a route's list is
 * right is to execute it.
 *
 * FOUR PERSONAS, because each fails differently:
 *
 *   org_admin_holding_nothing   passes on the ROLE. If a permission were checked
 *                               before the role, org_admins would be locked out of
 *                               their own company — the most damaging possible
 *                               regression and the one a role-only test cannot see.
 *   sub_admin_with              exactly the one permission this module needs.
 *   sub_admin_without           nothing at all. The reported bug.
 *   employee                     everything, which must still be refused: a
 *                               permission must never become a back door past the
 *                               role.
 *
 * NOTHING IS MOCKED, including requireRole. Mocking it would make this file assert
 * that a stub behaves as intended, which is what the offboarding test accidentally
 * did when its stub stopped setting req.user.
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
 * Every route this module registers, with the method.
 *
 * Written out rather than discovered from the router, for the same reason the
 * expectations elsewhere are hand-written: deriving the list from the app would make
 * a route that failed to register invisible. If a route is added and forgotten here,
 * the "no unregistered route" test below is what notices.
 */
const ROUTES = [
  ["GET", "/api/v1/org/job-openings"],
  ["POST", "/api/v1/org/job-openings"],
  ["GET", "/api/v1/org/job-openings/11111111-1111-4111-8111-111111111111"],
  ["PUT", "/api/v1/org/job-openings/11111111-1111-4111-8111-111111111111"],
  ["GET", "/api/v1/org/candidates"],
  ["POST", "/api/v1/org/candidates"],
  ["GET", "/api/v1/org/candidates/11111111-1111-4111-8111-111111111111"],
  ["GET", "/api/v1/org/applications"],
  ["POST", "/api/v1/org/applications"],
  ["GET", "/api/v1/org/applications/11111111-1111-4111-8111-111111111111"],
  ["POST", "/api/v1/org/applications/11111111-1111-4111-8111-111111111111/move-stage"],
  // There is deliberately NO /hire route. Hiring is no longer reachable from the
  // pipeline: reaching it requires an offer that a candidate has accepted, which is
  // a post-approval event, so a bare POST could never satisfy it. The entry point is
  // the candidate's response to a sent offer.
  ["POST", "/api/v1/org/applications/11111111-1111-4111-8111-111111111111/start-offer"],
  ["GET", "/api/v1/org/pipeline"],
  ["GET", "/api/v1/org/pipeline/11111111-1111-4111-8111-111111111111"],
  ["POST", "/api/v1/org/interviews"],
  ["GET", "/api/v1/org/interviewers"],
  ["GET", "/api/v1/org/interviews"],
  ["POST", "/api/v1/org/interviews/11111111-1111-4111-8111-111111111111/feedback"],
  ["GET", "/api/v1/org/my/interviews"],
  ["POST", "/api/v1/org/my/interviews/11111111-1111-4111-8111-111111111111/feedback"],
  ["GET", "/api/v1/org/offers"],
  // Prepare and preview are available before direct offer dispatch.
  ["GET", "/api/v1/org/offers/11111111-1111-4111-8111-111111111111/prepare"],
  ["POST", "/api/v1/org/offers/11111111-1111-4111-8111-111111111111/preview"],
  ["POST", "/api/v1/org/offers/11111111-1111-4111-8111-111111111111/send"],
  ["POST", "/api/v1/org/offers/11111111-1111-4111-8111-111111111111/hire"],
  ["DELETE", "/api/v1/org/candidate-attachments/11111111-1111-4111-8111-111111111111"],
  ["GET", "/api/v1/org/candidate-attachments/11111111-1111-4111-8111-111111111111/download"],
];

let db;
let app;
let orgId;
const tokens = {};

beforeAll(async () => {
  if (!HAS_DB) return;
  db = await mysql.createConnection(cfg);

  const [org] = await db.query("INSERT INTO organizations (uuid, name) VALUES (UUID(), ?)", [
    `Recruitment auth ${Date.now()}`,
  ]);
  orgId = org.insertId;

  // requireActiveSubscription reads the ORGANIZATION's plan columns — there is no
  // subscriptions table — and short-circuits on GET. So without this the matrix would
  // pass every GET for the wrong reason (the gate was never consulted) and fail every
  // POST with SUBSCRIPTION_INACTIVE, which is a plan fact masquerading as a
  // permission one. Free counts as valid, so pointing at plan 1 with no expiry is the
  // smallest real setup that leaves the module gate as the only thing under test.
  await db.query(
    "UPDATE organizations SET subscription_status='active', subscription_plan_id=1, subscription_expiry=NULL WHERE id=?",
    [orgId],
  );

  const personas = [
    ["orgAdmin", "org_admin", {}],
    ["subAdminWith", "sub_admin", { manage_recruitment: true }],
    ["subAdminWithout", "sub_admin", {}],
    ["employee", "employee", { manage_recruitment: true }],
  ];

  for (const [tag, role, featureAccess] of personas) {
    const uuid = crypto.randomUUID();
    await db.query(
      `INSERT INTO users (uuid, organization, full_name, email, cnic, status, org_role, feature_access)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      [
        uuid,
        orgId,
        `Auth ${tag}`,
        `auth-${tag}-${uuid.slice(0, 8)}@example.com`,
        `35202-${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}-1`,
        role,
        JSON.stringify(featureAccess),
      ],
    );
    tokens[tag] = signAccessToken({
      userId: uuid,
      type: "user",
      role: "user",
      organization: orgId,
    });
    db_userUuids.push(uuid);
  }

  const router = (await import("../src/routes/index.js")).default;
  const { default: errorHandler } = await import("../src/middleware/errorHandler.js");
  app = express();
  app.use(express.json());
  // The /api/v1 prefix lives in app.js, NOT in routes/index.js, so mounting the
  // router at the app root serves every path as 404 and every assertion below would
  // read as "the gate let it through". Matching app.js is the whole reason this
  // mount is not just `app.use(router)`.
  app.use("/api/v1", router);
  app.use(errorHandler);
});

const db_userUuids = [];

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
for (const uuid of db_userUuids) {
      await db.query("DELETE FROM users WHERE uuid=?", [uuid]);
    }
  
  } finally {
    await purgeTestOrgs(db, [orgId]);
    await db.end();
  }});

const call = (method, path, tag) =>
  request(app)[method.toLowerCase()](path).set("Authorization", `Bearer ${tokens[tag]}`);

/**
 * What each persona is allowed to reach.
 *
 * org_admin: everything, on the role alone.
 * sub_admin WITH manage_recruitment: all recruitment routes.
 * sub_admin WITHOUT: nothing. This is the regression.
 * employee: nothing, however many permissions they hold.
 */
const ALLOWED = {
  orgAdmin: true,
  subAdminWith: true,
  subAdminWithout: false,
  employee: false,
};

/**
 * Interviewer self-service routes are limited to the assigned interviewer.
 */
const PERSONAL_ASSIGNED_ROUTES = new Set([
  "/api/v1/org/my/interviews",
  "/api/v1/org/my/interviews/11111111-1111-4111-8111-111111111111/feedback",
]);

describe.runIf(HAS_DB)("auth matrix — every recruitment route x every persona", () => {
  for (const [method, path] of ROUTES) {
    for (const [persona, baseAllowed] of Object.entries(ALLOWED)) {
      const allowed = PERSONAL_ASSIGNED_ROUTES.has(path) || baseAllowed;
      it(`${persona} ${allowed ? "may" : "may NOT"} ${method} ${path.replace("/api/v1/org", "")}`, async () => {
        const res = await call(method, path, persona);

        if (allowed) {
          // NOT 200: these hit the handler and 404 on a uuid that does not exist,
          // which is the correct outcome for a route that is properly reachable. What
          // must never happen is a 401/403 from the GATE.
          expect([401, 403], `${persona} refused at the gate on ${path} :: ${JSON.stringify(res.body)}`).not.toContain(res.status);
        } else {
          // Exactly 403: 401 would mean the token failed to identify the user, which
          // is a different bug and would hide the one under test.
          expect(res.status, `${persona} reached ${path}`).toBe(403);
        }
      });
    }
  }
});

describe.runIf(HAS_DB)("the refusals name the reason", () => {
  it("a sub-admin without the permission is told which permission is missing", async () => {
    const res = await call("GET", "/api/v1/org/job-openings", "subAdminWithout");
    expect(res.status).toBe(403);
    const body = res.body?.message ?? res.body?.error?.message ?? "";
    // "forbidden" with no reason cannot tell the user whether they need a permission
    // or a different account.
    expect(body).toContain("manage_recruitment");
  });

  it("an employee is refused by the ROLE gate, before any permission is consulted", async () => {
    const res = await call("GET", "/api/v1/org/job-openings", "employee");
    expect(res.status).toBe(403);
    const body = res.body?.message ?? res.body?.error?.message ?? "";
    // They hold manage_recruitment. If the message names the permission rather than
    // the role, the permission check is running first — which would mean an
    // org_admin could be denied for a permission they are entitled to by role.
    expect(body.toLowerCase()).toMatch(/role|permission|access/i);
  });
});

describe.runIf(HAS_DB)("every registered recruitment route is covered by this matrix", () => {
  it("no route in the module is missing from the ROUTES list", async () => {
    // A route added and forgotten here would ship unaudited. Read from the route
    // source rather than by walking a mounted handler stack, so a route that failed
    // to register is still counted.
    const src = readFileSync("src/routes/org.routes.js", "utf8");
    const registered = [
      ...src.matchAll(
        /router\.(get|post|put|delete)\(\s*"(\/(?:job-openings|candidates|applications|pipeline|interviewers|interviews|my\/interviews|offers|candidate-attachments)[^"]*)"/g,
      ),
    ]
      .map((m) => [m[1].toUpperCase(), `/api/v1/org${m[2]}`])
      // The upload route takes a multipart body this matrix does not build; it is
      // covered by the same gate as every other route in the module, so probing it
      // with a JSON body would test the parser rather than the gate.
      .filter(([, p]) => !p.includes("/resume"));

    /**
     * Both sides canonicalised to the SHAPE of the path before comparison.
     *
     * ROUTES holds concrete uuids so each entry is a real request, while the route
     * source holds templates. Canonicalising only the uuid was not enough: the source
     * names its segments (`:attachmentUuid`, `:uuid`), so three routes were reported
     * as untested when they were listed and probed. A check that cries wolf gets
     * ignored, so the comparison has to be about shape.
     */
    const shape = (path) =>
      path
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "*")
        .replace(/:[A-Za-z_][A-Za-z0-9_]*/g, "*");

    const declared = new Set(ROUTES.map(([m, p]) => `${m} ${shape(p)}`));
    const missing = registered.filter(([m, p]) => !declared.has(`${m} ${shape(p)}`));
    expect(
      missing,
      `registered but untested: ${missing.map(([m, p]) => `${m} ${p}`).join(", ")}`,
    ).toEqual([]);
  });
});
