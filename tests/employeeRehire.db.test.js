import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import crypto from "node:crypto";
import dotenv from "dotenv";
import mysql from "mysql2/promise";

import { purgeTestOrgs } from "./helpers/dbCleanup.js";
import { createEmployee } from "../src/controllers/admin/employees.controller.js";
import { createEmployeePortalInvite } from "../src/services/employeeAccess.service.js";
import { hireCandidate } from "../src/services/recruitment.service.js";

/**
 * CROSS-COMPANY REHIRING.
 *
 * `employees` is an employment record, not the person. When a person leaves
 * Company A and joins Company B, B must be able to store the same CNIC/email:
 * A's row is history (`ex_employee`), B's row is the current employment. The
 * global login account is still unique, so B links the existing account rather
 * than creating a second identity with the same CNIC.
 *
 * These are real-database tests because the rule is a query against
 * `employees.organization_id`/`status` and a transaction that moves
 * `users.organization`. Mocks would happily agree with either behaviour.
 */

vi.mock("../src/utils/mailer.js", () => ({
  sendInviteEmail: vi.fn(async () => ({})),
  sendLoginOtpEmail: vi.fn(async () => ({})),
  sendVerificationResultEmailToOrg: vi.fn(async () => ({})),
}));

dotenv.config({ quiet: true });

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

function readDbConfig() {
  return {
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || process.env.DB_PASS || "",
    database: process.env.DB_NAME,
  };
}

let db;
let orgAId;
let orgBId;
let adminUser;
let runTag;
let n = 0;

function nextIdentity() {
  n += 1;
  return {
    email: `rehire-${runTag}-${n}@example.com`,
    cnic: `42101${String(1000000 + n).padStart(8, "0")}`,
    phone: `03${String(100000000 + n).slice(1)}`,
  };
}

async function insertOrg(label) {
  const [result] = await db.query("INSERT INTO organizations (uuid, name) VALUES (UUID(), ?)", [
    `${label} ${runTag}`,
  ]);
  return result.insertId;
}

async function insertUser({ organizationId, fullName, email, cnic, phone, status = "active" }) {
  const [result] = await db.query(
    `INSERT INTO users
       (uuid, organization, full_name, email, phone, cnic, password, status, org_role, is_verified)
     VALUES (UUID(), ?, ?, ?, ?, ?, 'not-a-real-hash', ?, 'employee', 'yes')`,
    [organizationId, fullName, email, phone, cnic, status]
  );
  const [[row]] = await db.query("SELECT uuid FROM users WHERE id=?", [result.insertId]);
  return row.uuid;
}

async function insertEmployee({
  organizationId,
  fullName,
  email,
  cnic,
  phone,
  status,
  linkedUserUuid = null,
}) {
  const [result] = await db.query(
    `INSERT INTO employees
       (uuid, organization_id, employee_code, full_name, email, phone, cnic, status,
        is_platform_user, linked_user_uuid)
     VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      organizationId,
      `EMP-${runTag}-${++n}`,
      fullName,
      email,
      phone,
      cnic,
      status,
      linkedUserUuid ? "yes" : "no",
      linkedUserUuid,
    ]
  );
  const [[row]] = await db.query("SELECT uuid FROM employees WHERE id=?", [result.insertId]);
  return row.uuid;
}

/**
 * A candidate ready to be hired: an open opening, an accepted offer, and the
 * completed interview `hireCandidate` insists on. Inserted directly because the
 * offer lifecycle is covered elsewhere; these tests are about the identity rule
 * at the moment an employee row is created.
 */
async function seedHireableCandidate({ organizationId, identity, fullName = "Candidate" }) {
  const openingUuid = crypto.randomUUID();
  await db.query(
    `INSERT INTO job_openings
       (uuid, organization_id, title, location, employment_type, description, status, vacancies)
     VALUES (?, ?, 'Engineer', 'Lahore', 'full_time', 'Build things', 'open', 1)`,
    [openingUuid, organizationId]
  );
  const candidateUuid = crypto.randomUUID();
  await db.query(
    `INSERT INTO candidates
       (uuid, organization_id, job_opening_uuid, full_name, email, phone, cnic,
        stage, offer_status, offer_sent_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'offered', 'sent', NOW())`,
    [candidateUuid, organizationId, openingUuid, fullName, identity.email, identity.phone, identity.cnic]
  );
  await db.query(
    `INSERT INTO interviews
       (uuid, organization_id, candidate_uuid, scheduled_at, status, outcome)
     VALUES (UUID(), ?, ?, NOW(), 'completed', 'passed')`,
    [organizationId, candidateUuid]
  );
  return { candidateUuid, openingUuid };
}

function makeReq(body, organizationId) {
  return {
    body,
    scopeOrgId: organizationId,
    user: {
      id: 1,
      uuid: adminUser,
      full_name: "Org Admin",
      org_role: "org_admin",
      organization: organizationId,
    },
    admin: null,
    query: {},
    headers: {},
    ip: "127.0.0.1",
  };
}

function mockRes() {
  const res = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return res;
}

beforeAll(async () => {
  if (!HAS_DB) return;
  db = await mysql.createConnection(readDbConfig());
  runTag = Date.now();
  orgAId = await insertOrg("Rehire-A");
  orgBId = await insertOrg("Rehire-B");

  const [admin] = await db.query(
    `INSERT INTO users (uuid, organization, full_name, email, password, status, org_role, is_verified)
     VALUES (UUID(), ?, 'Admin', ?, 'not-a-real-hash', 'active', 'org_admin', 'yes')`,
    [orgBId, `admin-${runTag}@example.com`]
  );
  const [[adminRow]] = await db.query("SELECT uuid FROM users WHERE id=?", [admin.insertId]);
  adminUser = adminRow.uuid;
});

afterAll(async () => {
  if (!db) return;
  await purgeTestOrgs(db, [orgAId, orgBId]);
  await db.end();
});

describe.runIf(HAS_DB)("employee rehiring across organizations", () => {
  it("allows the same CNIC/email when the previous employment is ex_employee", async () => {
    const identity = nextIdentity();
    await insertEmployee({
      organizationId: orgAId,
      fullName: "Returning Person",
      ...identity,
      status: "ex_employee",
    });

    const res = mockRes();
    await createEmployee(
      makeReq({
        full_name: "Returning Person",
        ...identity,
        send_invite: false,
      }, orgBId),
      res
    );

    expect(res.status).toHaveBeenCalledWith(201);
    const [[row]] = await db.query(
      "SELECT uuid, organization_id, status FROM employees WHERE cnic=? AND organization_id=?",
      [identity.cnic, orgBId]
    );
    expect(row).toBeTruthy();
    expect(row.status).toBe("current_employee");
    expect(row.organization_id).toBe(orgBId);
  });

  it("refuses when the person is still current at another organization", async () => {
    const identity = nextIdentity();
    await insertEmployee({
      organizationId: orgAId,
      fullName: "Still Employed",
      ...identity,
      status: "current_employee",
    });

    await expect(
      createEmployee(
        makeReq({ full_name: "Still Employed", ...identity, send_invite: false }, orgBId),
        mockRes()
      )
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("currently employed at another organization"),
    });

    const [rows] = await db.query(
      "SELECT uuid FROM employees WHERE cnic=? AND organization_id=?",
      [identity.cnic, orgBId]
    );
    expect(rows).toHaveLength(0);
  });

  it("still refuses a duplicate current employee in the same organization", async () => {
    const identity = nextIdentity();
    await insertEmployee({
      organizationId: orgBId,
      fullName: "Current Employee",
      ...identity,
      status: "current_employee",
    });

    await expect(
      createEmployee(
        makeReq({ full_name: "Current Employee", ...identity, send_invite: false }, orgBId),
        mockRes()
      )
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("already exists in this organization"),
    });
  });

  it("allows a same-organization rehire after the old row is ex_employee", async () => {
    const identity = nextIdentity();
    await insertEmployee({
      organizationId: orgBId,
      fullName: "Old Employment",
      ...identity,
      status: "ex_employee",
    });

    const res = mockRes();
    await createEmployee(
      makeReq({ full_name: "New Employment", ...identity, send_invite: false }, orgBId),
      res
    );

    expect(res.status).toHaveBeenCalledWith(201);
    const [rows] = await db.query(
      "SELECT uuid, status FROM employees WHERE cnic=? AND organization_id=? ORDER BY id",
      [identity.cnic, orgBId]
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.status).sort()).toEqual(["current_employee", "ex_employee"]);
  });

  it("links the existing platform account, moves it to the new org and unlinks the old employment", async () => {
    const identity = nextIdentity();
    const userUuid = await insertUser({
      organizationId: orgAId,
      fullName: "Returning Person",
      ...identity,
      status: "active",
    });
    const oldEmployeeUuid = await insertEmployee({
      organizationId: orgAId,
      fullName: "Returning Person",
      ...identity,
      status: "ex_employee",
      linkedUserUuid: userUuid,
    });

    const res = mockRes();
    await createEmployee(
      makeReq({
        full_name: "Returning Person",
        ...identity,
        send_invite: true,
      }, orgBId),
      res
    );

    expect(res.status).toHaveBeenCalledWith(201);
    const body = res.json.mock.calls[0][0];
    expect(body.data.linked_existing_account).toBe(true);
    expect(body.message).toContain("Existing platform account linked");

    const [[user]] = await db.query(
      "SELECT organization, status FROM users WHERE uuid=?",
      [userUuid]
    );
    expect(user.organization).toBe(orgBId);
    expect(user.status).toBe("active");

    const [[newEmployee]] = await db.query(
      "SELECT uuid, linked_user_uuid, is_platform_user FROM employees WHERE cnic=? AND organization_id=?",
      [identity.cnic, orgBId]
    );
    expect(newEmployee.linked_user_uuid).toBe(userUuid);
    expect(newEmployee.is_platform_user).toBe("yes");

    const [[oldEmployee]] = await db.query(
      "SELECT linked_user_uuid, is_platform_user FROM employees WHERE uuid=?",
      [oldEmployeeUuid]
    );
    expect(oldEmployee.linked_user_uuid).toBeNull();
    expect(oldEmployee.is_platform_user).toBe("no");

    const [usersWithEmail] = await db.query("SELECT uuid FROM users WHERE email=?", [identity.email]);
    expect(usersWithEmail).toHaveLength(1);
  });

  it("refuses to link an existing account whose previous employment is still active", async () => {
    const identity = nextIdentity();
    const userUuid = await insertUser({
      organizationId: orgAId,
      fullName: "Active Elsewhere",
      ...identity,
      status: "active",
    });
    await insertEmployee({
      organizationId: orgAId,
      fullName: "Active Elsewhere",
      ...identity,
      status: "current_employee",
      linkedUserUuid: userUuid,
    });
    const newEmployeeUuid = await insertEmployee({
      organizationId: orgBId,
      fullName: "Active Elsewhere",
      ...identity,
      status: "current_employee",
    });

    const conn = await mysql.createConnection(readDbConfig());
    try {
      await conn.beginTransaction();
      await expect(
        createEmployeePortalInvite({
          conn,
          employeeUuid: newEmployeeUuid,
          organizationId: orgBId,
          fullName: "Active Elsewhere",
          email: identity.email,
          phone: identity.phone,
          cnic: identity.cnic,
          actorUuid: adminUser,
        })
      ).rejects.toMatchObject({
        statusCode: 409,
        message: expect.stringContaining("still active at another organization"),
      });
      await conn.rollback();
    } finally {
      await conn.end();
    }

    const [[user]] = await db.query("SELECT organization FROM users WHERE uuid=?", [userUuid]);
    expect(user.organization).toBe(orgAId);
    const [[newEmployee]] = await db.query(
      "SELECT linked_user_uuid FROM employees WHERE uuid=?",
      [newEmployeeUuid]
    );
    expect(newEmployee.linked_user_uuid).toBeNull();
  });

  it("refuses to link an account when the email belongs to a different CNIC/phone", async () => {
    const identity = nextIdentity();
    const otherIdentity = nextIdentity();
    await insertUser({
      organizationId: orgAId,
      fullName: "Different Person",
      email: identity.email,
      cnic: otherIdentity.cnic,
      phone: otherIdentity.phone,
      status: "active",
    });
    // Same email as the existing account, but a different CNIC/phone on the
    // employee record: this is exactly the identity mix-up the link must refuse.
    await insertEmployee({
      organizationId: orgAId,
      fullName: "Different Person",
      email: identity.email,
      cnic: otherIdentity.cnic,
      phone: otherIdentity.phone,
      status: "ex_employee",
    });

    await expect(
      createEmployee(
        makeReq(
          {
            full_name: "Claimant",
            email: identity.email,
            cnic: identity.cnic,
            phone: identity.phone,
            send_invite: true,
          },
          orgBId
        ),
        mockRes()
      )
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("different person"),
    });

    const [rows] = await db.query(
      "SELECT uuid FROM employees WHERE cnic=? AND organization_id=?",
      [identity.cnic, orgBId]
    );
    expect(rows).toHaveLength(0);
  });

  it("does not let recruitment hire a candidate who is still current at another organization", async () => {
    const identity = nextIdentity();
    const { candidateUuid } = await seedHireableCandidate({
      organizationId: orgBId,
      identity,
      fullName: "Poached Candidate",
    });
    await insertEmployee({
      organizationId: orgAId,
      fullName: "Poached Candidate",
      ...identity,
      status: "current_employee",
    });

    await expect(
      hireCandidate({
        orgId: orgBId,
        actorUuid: adminUser,
        candidateUuid,
        cnic: identity.cnic,
        offerAcceptance: true,
      })
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("currently employed at another organization"),
    });

    const [rows] = await db.query(
      "SELECT uuid FROM employees WHERE cnic=? AND organization_id=?",
      [identity.cnic, orgBId]
    );
    expect(rows).toHaveLength(0);
  });

  it("lets recruitment hire a former employee of another organization", async () => {
    const identity = nextIdentity();
    const { candidateUuid } = await seedHireableCandidate({
      organizationId: orgBId,
      identity,
      fullName: "Returning Candidate",
    });
    await insertEmployee({
      organizationId: orgAId,
      fullName: "Returning Candidate",
      ...identity,
      status: "ex_employee",
    });

    const result = await hireCandidate({
      orgId: orgBId,
      actorUuid: adminUser,
      candidateUuid,
      cnic: identity.cnic,
      offerAcceptance: true,
    });

    expect(result.employee_uuid).toBeTruthy();
    const [[row]] = await db.query(
      "SELECT status, organization_id FROM employees WHERE cnic=? AND organization_id=?",
      [identity.cnic, orgBId]
    );
    expect(row.status).toBe("current_employee");
    expect(row.organization_id).toBe(orgBId);
  });
});
