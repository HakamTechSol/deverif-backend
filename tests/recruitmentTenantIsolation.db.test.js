import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import mysql from "mysql2/promise";
import dotenv from "dotenv";
import { signAccessToken } from "../src/utils/jwt.js";
import { purgeTestOrgs } from "./helpers/dbCleanup.js";
import {
  createOpening,
  createCandidate,
  updateCandidateStage,
  getOpening,
  listOpenings,
} from "../src/services/recruitment.service.js";

/**
 * CROSS-TENANT ISOLATION, THROUGH THE REAL HTTP STACK.
 *
 * Driven over HTTP rather than by calling the service directly, because the question
 * is not "does the service scope by org" — it does, and the lifecycle test already
 * proves that — but "can a caller in org A reach org B's data by naming a uuid". That
 * depends on where the org comes from, and the org comes from the JWT via
 * req.scopeOrgId. A service-level test passes orgId by hand, which means it would
 * pass even if the controller read org from the request BODY instead.
 *
 * Two failure shapes are covered, and the second is the dangerous one:
 *
 *   READ   naming another tenant's uuid returns 404, not its contents.
 *   WRITE  naming another tenant's uuid changes nothing over there. A refused write
 *          is a 404 too — a 403 would confirm the row exists, which is itself a leak
 *          of the fact that somebody applied to a competitor.
 *
 * EVERY ENTITY IS NAMED EXPLICITLY rather than by looping a service's exports: the
 * point is coverage of the routes a caller can actually reach.
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

let db;
let app;
let tokenA;
let tokenB;

const ORGS = {};
const USERS = {};
/** uuids of things that belong to org B. Named so every read asserts on org B's data. */
const b = {};

beforeAll(async () => {
  if (!HAS_DB) return;
  db = await mysql.createConnection(cfg);

  for (const tag of ["A", "B"]) {
    const [org] = await db.query("INSERT INTO organizations (uuid, name) VALUES (UUID(), ?)", [
      `Tenant ${tag} ${Date.now()}`,
    ]);
    ORGS[tag] = org.insertId;
    // Free plan, active, no expiry — the subscription gate short-circuits on GET and
    // would otherwise fail every write with SUBSCRIPTION_INACTIVE, which is a plan
    // fact and not what this file is testing.
    await db.query(
      "UPDATE organizations SET subscription_status='active', subscription_plan_id=1, subscription_expiry=NULL WHERE id=?",
      [ORGS[tag]],
    );

    const uuid = crypto.randomUUID();
    await db.query(
      `INSERT INTO users (uuid, organization, full_name, email, cnic, status, org_role, feature_access)
       VALUES (?, ?, ?, ?, ?, 'active', 'org_admin', ?)`,
      [
        uuid,
        ORGS[tag],
        `Admin ${tag}`,
        `admin-${tag}-${uuid.slice(0, 8)}@example.com`,
        `35202-${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}-1`,
        JSON.stringify({ manage_recruitment: true }),
      ],
    );
    USERS[tag] = uuid;
    const token = signAccessToken({ userId: uuid, type: "user", role: "user", organization: ORGS[tag] });
    if (tag === "A") tokenA = token;
    else tokenB = token;
  }

  // Real rows, created through the real service in org B.
  b.opening = await createOpening({
    orgId: ORGS.B,
    title: "B's Confidential Role",
    status: "open",
  });
  b.candidate = await createCandidate({
    orgId: ORGS.B,
    openingUuid: b.opening.uuid,
    fullName: "B's Secret Candidate",
    email: "b-candidate@example.com",
  });
  b.candidateAtApplied = await createCandidate({
    orgId: ORGS.B,
    openingUuid: b.opening.uuid,
    fullName: "B's Second Candidate",
    email: "b-candidate-2@example.com",
  });
  b.aOpening = await createOpening({
    orgId: ORGS.A,
    title: "A's Own Role",
    status: "open",
  });
  b.aCandidate = await createCandidate({
    orgId: ORGS.A,
    openingUuid: b.aOpening.uuid,
    fullName: "A's Own Candidate",
    email: "a-candidate@example.com",
  });

  const router = (await import("../src/routes/index.js")).default;
  const { default: errorHandler } = await import("../src/middleware/errorHandler.js");
  app = express();
  app.use(express.json());
  // The /api/v1 prefix lives in app.js, not in routes/index.js.
  app.use("/api/v1", router);
  app.use(errorHandler);
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
for (const tag of ["A", "B"]) {
      await db.query("DELETE FROM attachments WHERE organization_id=?", [ORGS[tag]]);
      await db.query("DELETE FROM interviews WHERE organization_id=?", [ORGS[tag]]);
      // candidates RESTRICT on converted_employee_uuid -> employees, so employees first.
      await db.query("DELETE FROM candidates WHERE organization_id=?", [ORGS[tag]]);
      await db.query("DELETE FROM job_openings WHERE organization_id=?", [ORGS[tag]]);
      await db.query("DELETE FROM hr_letters WHERE organization_id=?", [ORGS[tag]]);
      await db.query("DELETE FROM employees WHERE organization_id=?", [ORGS[tag]]);
      await db.query("DELETE FROM users WHERE uuid=?", [USERS[tag]]);
    }
  
  } finally {
    await purgeTestOrgs(db, [ORGS.A, ORGS.B]);
    await db.end();
  }});

/**
 * Named after the TOKEN being sent, which is the thing that decides the caller's
 * organization. The previous names read as "acting as org B" while carrying org A's
 * token, and that inversion is what produced a backwards assertion in this file.
 */
const asOrgA = (method, path, body) =>
  request(app)[method.toLowerCase()](path).set("Authorization", `Bearer ${tokenA}`).send(body);
const asOrgB = (method, path, body) =>
  request(app)[method.toLowerCase()](path).set("Authorization", `Bearer ${tokenB}`).send(body);

// ---------------------------------------------------------------------------

describe.runIf(HAS_DB)("a caller in org A cannot name org B's data", () => {
  it("listing openings returns only org A's", async () => {
    const res = await asOrgA("GET", "/api/v1/org/job-openings");
    expect(res.status).toBe(200);
    const titles = res.body.data.items.map((o) => o.title);
    expect(titles).toContain("A's Own Role");
    expect(titles).not.toContain("B's Confidential Role");
  });

  it("listing candidates returns only org A's", async () => {
    const res = await asOrgA("GET", "/api/v1/org/candidates");
    expect(res.status).toBe(200);
    const names = res.body.data.items.map((c) => c.full_name);
    expect(names).toContain("A's Own Candidate");
    expect(names).not.toContain("B's Secret Candidate");
  });

  it("counting is scoped too, so the total cannot leak B's headcount", async () => {
    // The rows would be absent from `items` anyway; the TOTAL is the leak. A list that
    // reports 4 rows but shows 2 says something true about another tenant.
    const res = await asOrgA("GET", "/api/v1/org/candidates");
    expect(res.body.data.total).toBe(1);
  });

  it("offers list only org A's, and never B's candidate names", async () => {
    const res = await asOrgA("GET", "/api/v1/org/offers");
    expect(res.status).toBe(200);
    const names = res.body.data.items.map((o) => o.full_name);
    expect(names).not.toContain("B's Second Candidate");
  });

  it("reading org B's opening by uuid is a 404, not its contents", async () => {
    const res = await asOrgA("GET", `/api/v1/org/job-openings/${b.opening.uuid}`);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain("B's Confidential Role");
  });

  it("reading org B's candidate by uuid is a 404", async () => {
    const res = await asOrgA("GET", `/api/v1/org/candidates/${b.candidate.uuid}`);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain("b-candidate@example.com");
  });

  it("the pipeline for org B's opening is a 404", async () => {
    const res = await asOrgA("GET", `/api/v1/org/pipeline?opening_uuid=${b.opening.uuid}`);
    expect(res.status).toBe(404);
  });

  it("interviews cannot be listed by org B's candidate uuid", async () => {
    const res = await asOrgA("GET", `/api/v1/org/interviews?candidate_uuid=${b.candidate.uuid}`);
    expect(res.status).toBe(200);
    // An empty list is the right answer: the uuid is not visible, so it matches
    // nothing. Returning B's interviews would be the leak.
    expect(res.body.data.items).toEqual([]);
  });
});

describe.runIf(HAS_DB)("a write naming another tenant's uuid changes nothing", () => {
  it("cannot move org B's candidate along the pipeline", async () => {
    const res = await asOrgA(
      "POST",
      `/api/v1/org/applications/${b.candidate.uuid}/move-stage`,
      { stage: "screening" },
    );
    expect(res.status).toBe(404);

    // Read back directly, because a 404 from the handler proves nothing about the row.
    const candidate = await db.query("SELECT stage FROM candidates WHERE uuid=?", [
      b.candidate.uuid,
    ]);
    expect(candidate[0][0].stage).toBe("applied");
  });

  it("cannot hire org B's candidate into org A's roster", async () => {
    // The dangerous one. If it worked, org A would gain an employee it never hired,
    // and org B would lose a candidate from its pipeline.
    const res = await asOrgA("POST", `/api/v1/org/applications/${b.candidate.uuid}/hire`, {});
    expect(res.status).toBe(404);

    const emps = await db.query(
      "SELECT COUNT(*) AS n FROM employees WHERE organization_id=? AND full_name=?",
      [ORGS.A, "B's Secret Candidate"],
    );
    expect(Number(emps[0][0].n)).toBe(0);

    const after = await db.query("SELECT stage, converted_employee_uuid FROM candidates WHERE uuid=?", [
      b.candidate.uuid,
    ]);
    expect(after[0][0].stage).toBe("applied");
    expect(after[0][0].converted_employee_uuid).toBeNull();
  });

  it("cannot send org B's offer letter", async () => {
    // Walks to the candidate first, so a failure there proves nothing about the
    // letter. B's candidate is moved to offered in org B's own context below.
    // Walked all the way to `offered` in org B's OWN context first, so the send
    // attempt below fails on cross-tenant access rather than on the candidate simply
    // not having an offer letter yet. Written in sequence rather than as a .then()
    // chain, which referenced `moved` inside the statement that declared it.
    await updateCandidateStage({ orgId: ORGS.B, candidateUuid: b.candidateAtApplied.uuid, stage: "screening", conn: db });
    await updateCandidateStage({ orgId: ORGS.B, candidateUuid: b.candidateAtApplied.uuid, stage: "interview", conn: db });
    // `selected` is a required hop, not an optional one. ALLOWED_TRANSITIONS allows
    // interview -> selected -> offered only; jumping straight from `interview` to
    // `offered` is refused with a 409, because `selected` is the stage that means a
    // shortlist decision was actually made.
    await updateCandidateStage({ orgId: ORGS.B, candidateUuid: b.candidateAtApplied.uuid, stage: "selected", conn: db });
    await updateCandidateStage({ orgId: ORGS.B, candidateUuid: b.candidateAtApplied.uuid, stage: "offered", conn: db });

    const res = await asOrgA("POST", `/api/v1/org/offers/${b.candidateAtApplied.uuid}/send`, {});
    expect(res.status).toBe(404);
  });

  it("cannot edit org B's opening", async () => {
    const res = await asOrgA("PUT", `/api/v1/org/job-openings/${b.opening.uuid}`, {
      title: "HIJACKED",
    });
    expect(res.status).toBe(404);

    const opening = await getOpening({ orgId: ORGS.B, openingUuid: b.opening.uuid, conn: db });
    expect(opening.title).toBe("B's Confidential Role");
  });

  it("cannot file an application against org B's opening", async () => {
    // Not a 404 here: the opening EXISTS and the caller may name it, but the insert
    // must land in ORG A with A's candidate on it — never as an application to B's
    // vacancy, which would fill B's pipeline with someone B never received.
    const res = await asOrgA("POST", "/api/v1/org/applications", {
      opening_uuid: b.opening.uuid,
      full_name: "Injected Into B",
      email: "injected@example.com",
    });

    // The composite tenant foreign key on (organization_id, job_opening_uuid) is what
    // decides this, so the refusal comes from the database rather than from a check
    // the caller could be routed around.
    expect([404, 409]).toContain(res.status);

    const inB = await db.query(
      "SELECT COUNT(*) AS n FROM candidates WHERE job_opening_uuid=? AND email=?",
      [b.opening.uuid, "injected@example.com"],
    );
    expect(Number(inB[0][0].n)).toBe(0);
  });

  it("cannot delete org B's resume attachment", async () => {
    const attachmentUuid = crypto.randomUUID();
    await db.query(
      `INSERT INTO attachments (uuid, organization_id, entity_type, entity_uuid, category, file_name, file_path, file_size, mime_type)
       VALUES (?, ?, 'candidate', ?, 'candidate_resume', 'cv.pdf', 'x/y.pdf', 10, 'application/pdf')`,
      [attachmentUuid, ORGS.B, b.candidate.uuid],
    );

    const res = await asOrgA("DELETE", `/api/v1/org/candidate-attachments/${attachmentUuid}`);
    expect(res.status).toBe(404);

    const still = await db.query("SELECT deleted_at FROM attachments WHERE uuid=?", [attachmentUuid]);
    expect(still[0][0].deleted_at).toBeNull();

    await db.query("DELETE FROM attachments WHERE uuid=?", [attachmentUuid]);
  });
});

describe.runIf(HAS_DB)("isolation is symmetric", () => {
  it("org B is equally unable to reach org A's data", async () => {
    // One direction proves the query filters; both proves it does not simply default
    // to whichever org the fixture created first.
    const res = await asOrgB("GET", `/api/v1/org/candidates/${b.aCandidate.uuid}`);
    expect(res.status).toBe(404);
  });

  it("each org sees its OWN openings and never the other's", async () => {
    const [fromA, fromB] = await Promise.all([
      asOrgA("GET", "/api/v1/org/job-openings"),
      asOrgB("GET", "/api/v1/org/job-openings"),
    ]);
    // Each list contains its own role and NOT the other tenant's. Both halves, not
    // one: an assertion that only checked absence would pass on an empty list — which
    // is exactly what the first version of this test did, with the expectation
    // inverted.
    expect(fromA.body.data.items.map((o) => o.title)).toContain("A's Own Role");
    expect(fromA.body.data.items.map((o) => o.title)).not.toContain("B's Confidential Role");
    expect(fromB.body.data.items.map((o) => o.title)).toContain("B's Confidential Role");
    expect(fromB.body.data.items.map((o) => o.title)).not.toContain("A's Own Role");
  });
});
