import { describe, it, expect, beforeAll, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * The mount path is part of the API contract, and nothing was asserting it.
 *
 * /my/assets shipped mounted at /my-assets. Every unit test passed, the route
 * file was correct, the controller was correct, and the endpoint still 404'd for
 * the client - because router.use() records its path in the layer's regexp, which
 * no test was reading, while the frontend asked for the other path.
 *
 * This dispatches a REAL request through the real router. That is the only kind
 * of check that can catch a mount/consumer disagreement: a test that reads the
 * route file or the controller proves nothing about the URL the server answers.
 *
 * authUser / requireActiveSubscription / requireModuleFeature are replaced so the
 * request reaches routing rather than the auth stack. The point is the PATH, and
 * letting a test fail on a missing token or an inactive plan would hide that.
 */
const mocks = [
  "../src/middleware/authUser.js",
  "../src/middleware/requireActiveSubscription.js",
  "../src/middleware/requireModuleFeature.js",
];

vi.mock("../src/middleware/authUser.js", () => ({
  default: (req, _res, next) => {
    req.user = {
      uuid: "99999999-9999-4999-8999-999999999999",
      role: "employee",
      org_id: 5,
    };
    req.scopeOrgId = 5;
    next();
  },
}));vi.mock("../src/middleware/requireActiveSubscription.js", () => ({
  default: (_req, _res, next) => next(),
}));
vi.mock("../src/middleware/requireModuleFeature.js", () => ({
  default: () => (_req, _res, next) => next(),
}));

const employeeLookups = [];

vi.mock("../src/config/db.js", () => ({
  pool: {
    query: vi.fn(async (sql, params) => {
      const s = String(sql);
      if (s.includes("linked_user_uuid")) {
        employeeLookups.push(params);
        // Scoped like the real row: an employee in another organization is not
        // this session's employee, and returning one anyway would hide exactly
        // the bug the next test is here to catch.
        return params?.[0] === 5
          ? [[{ uuid: "44444444-4444-4444-8444-444444444444", full_name: "Kinza" }], []]
          : [[], []];
      }
      if (s.includes("asset_assignments")) {
        return [
          [
            {
              uuid: "55555555-5555-4555-8555-555555555555",
              assignment_uuid: "66666666-6666-4666-8666-666666666666",
              asset_tag: "AST-0007",
              name: "testing",
              category_name: "Testing",
              assigned_at: "2026-10-06 00:00:00",
            },
          ],
          [],
        ];
      }
      return [[], []];
    }),
    getConnection: vi.fn(),
  },
}));

let app;

// The whole router index is imported on purpose - reading the route file proves
// nothing about the URL the server answers, which is the bug this file exists
// for. That import pulls in every controller in the app, so under full-suite load
// it outruns vitest's default 10s hook timeout. The budget is raised rather than
// the import narrowed: narrowing it to the myAssets router would delete the very
// disagreement this test is able to see.
beforeAll(async () => {
  const router = (await import("../src/routes/index.js")).default;
  app = express();
  app.use(express.json());
  // Same prefix the real server mounts under.
  app.use("/api/v1", router);
  app.use((_req, res) => res.status(404).json({ success: false, message: "Route not found" }));
}, 60_000);

describe("GET /api/v1/my/assets is routed", () => {
  it("is NOT a 404", async () => {
    // The assertion that failed in production: a valid session on the URL the
    // client actually requests.
    const res = await request(app).get("/api/v1/my/assets");

    expect(res.status, `got ${res.status}: ${JSON.stringify(res.body)}`).not.toBe(404);
    expect(res.status).toBe(200);
  });

  it("returns a list shaped for the employee page", async () => {
    const res = await request(app).get("/api/v1/my/assets");
    expect(res.body).toMatchObject({ success: true });
    expect(Array.isArray(res.body.data?.items)).toBe(true);
  });

  it("is NOT routed at the hyphenated path, which would silently split the API", async () => {
    // Not a wish: a second alias would be a second thing to keep in sync. This
    // documents that /my-assets does not exist, so the mistake cannot come back
    // as an accidental "fix".
    const res = await request(app).get("/api/v1/my-assets");
    expect(res.status).toBe(404);
  });

  it("takes no employee parameter, so there is nothing to tamper with", async () => {
    const res = await request(app).get("/api/v1/my/assets");
    expect(res.status).toBe(200);
    // No query or path input could change whose hardware is returned.
    const other = await request(app).get("/api/v1/my/assets?employee_uuid=someone-else");
    expect(other.status).toBe(200);
  });

  /**
   * THE BUG THIS FILE WAS BLIND TO.
   *
   * The mock above set req.scopeOrgId itself, so the request resolved an employee
   * and the list came back populated. The real authUser did not set it - only
   * requireRole ever did - so on this route req.scopeOrgId was undefined. That
   * does not throw: employeeForUser runs `organization_id = NULL`, matches no
   * row, and the endpoint answered 200 with an empty list. Every employee with a
   * real assignment saw "Nothing assigned to you" while staff saw it assigned.
   *
   * So the assertion is on the org id that REACHED the database, not on the
   * response. A response-only test passes while the query is scoped to nothing.
   */
  it("scopes the employee lookup to a real organization id, never NULL", async () => {
    employeeLookups.length = 0;
    const res = await request(app).get("/api/v1/my/assets");

    expect(res.status).toBe(200);
    expect(employeeLookups.length).toBeGreaterThan(0);
    for (const params of employeeLookups) {
      expect(typeof params[0], `orgId reached the query as ${params[0]}`).toBe("number");
      expect(params[0]).not.toBeNull();
    }
  });

  it("returns the assigned asset rather than an empty list", async () => {
    const res = await request(app).get("/api/v1/my/assets");
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0]).toMatchObject({ asset_tag: "AST-0007" });
  });
});