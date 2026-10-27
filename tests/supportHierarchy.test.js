import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/config/db.js", () => ({ pool: { query: vi.fn() } }));

import { pool } from "../src/config/db.js";
import {
  createTicket,
  listOrgTickets,
  listAdminTickets,
  getOrgTicket,
  getAdminTicket,
  addOrgReply,
  updateTicketStatus,
} from "../src/controllers/support.controller.js";

const ORG_ID = 7;
const ORG_ADMIN_UUID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const EMPLOYEE_UUID = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const SUB_ADMIN_UUID = "cccccccc-3333-4333-8333-cccccccccccc";
const SYSTEM_ADMIN_UUID = "dddddddd-4444-4444-8444-dddddddddddd";
const TICKET_UUID = "eeeeeeee-5555-4555-8555-eeeeeeeeeeee";

const employee = {
  id: 2,
  uuid: EMPLOYEE_UUID,
  full_name: "Employee One",
  email: "employee@example.com",
  org_role: "employee",
  organization: ORG_ID,
};
const subAdmin = { ...employee, id: 3, uuid: SUB_ADMIN_UUID, org_role: "sub_admin" };
const orgAdmin = {
  id: 1,
  uuid: ORG_ADMIN_UUID,
  full_name: "Org Admin",
  email: "orgadmin@example.com",
  org_role: "org_admin",
  organization: ORG_ID,
};
const systemAdmin = {
  id: 9,
  uuid: SYSTEM_ADMIN_UUID,
  full_name: "System Admin",
  email: "sysadmin@example.com",
};

function orgTicket(over = {}) {
  return {
    id: 1,
    uuid: TICKET_UUID,
    subject: "Laptop issue",
    description: "It will not boot",
    category: "it",
    priority: "medium",
    status: "open",
    organization_id: ORG_ID,
    assigned_to_role: "org_admin",
    assigned_to_uuid: ORG_ADMIN_UUID,
    raised_by_uuid: EMPLOYEE_UUID,
    raised_by_role: "employee",
    raised_by_name: "Employee One",
    organization_name: "Acme",
    ...over,
  };
}

function systemTicket(over = {}) {
  return orgTicket({
    uuid: "ffffffff-6666-4666-8666-ffffffffffff",
    assigned_to_role: "system_admin",
    assigned_to_uuid: null,
    raised_by_uuid: ORG_ADMIN_UUID,
    raised_by_role: "org_admin",
    raised_by_name: "Org Admin",
    ...over,
  });
}

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

function statements() {
  return pool.query.mock.calls.map(([sql, params]) => ({
    sql: String(sql).replace(/\s+/g, " ").trim(),
    params,
  }));
}

const ticketInsert = () =>
  statements().find((s) => s.sql.startsWith("INSERT INTO support_tickets"));

let currentTicket;

beforeEach(() => {
  currentTicket = orgTicket();
  pool.query.mockReset();
  pool.query.mockImplementation(async (sql) => {
    const stmt = String(sql).replace(/\s+/g, " ").trim();

    if (stmt.includes("FROM support_tickets t") && stmt.includes("WHERE t.uuid=?")) {
      return [[currentTicket]];
    }
    if (
      stmt.startsWith("SELECT uuid FROM users") &&
      stmt.includes("org_role='org_admin'")
    ) {
      return [[{ uuid: ORG_ADMIN_UUID }]];
    }
    if (stmt.startsWith("SELECT uuid FROM admin_profiles")) {
      return [[{ uuid: SYSTEM_ADMIN_UUID }]];
    }
    if (stmt.startsWith("SELECT COUNT(*)")) return [[{ total: 1 }]];
    if (stmt.includes("UNION")) return [[{ uuid: EMPLOYEE_UUID }]];
    if (stmt.includes("FROM support_ticket_replies")) return [[]];
    if (
      stmt.startsWith("INSERT") ||
      stmt.startsWith("UPDATE") ||
      stmt.startsWith("SELECT 1")
    ) {
      return [{ affectedRows: 1 }];
    }
    return [[]];
  });
});

function orgReq(user, over = {}) {
  return {
    user,
    scopeOrgId: ORG_ID,
    body: {},
    query: {},
    params: { uuid: TICKET_UUID },
    headers: {},
    ...over,
  };
}

function adminReq(over = {}) {
  return {
    admin: systemAdmin,
    body: {},
    query: {},
    params: { uuid: TICKET_UUID },
    headers: {},
    ...over,
  };
}

describe("2-tier ticket routing", () => {
  it("routes an employee ticket to org_admin and assigns the organization admin", async () => {
    const res = mockRes();
    await createTicket(
      orgReq(employee, {
        body: { subject: "Laptop issue", description: "It will not boot", category: "it" },
      }),
      res,
    );

    const insert = ticketInsert();
    expect(insert.sql).toContain("assigned_to_role");
    expect(insert.sql).toContain("assigned_to_uuid");
    expect(insert.params).toContain("org_admin");
    expect(insert.params).toContain(ORG_ADMIN_UUID);
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("routes a sub-admin ticket to org_admin as well", async () => {
    const res = mockRes();
    await createTicket(
      orgReq(subAdmin, {
        body: { subject: "Payroll access", description: "Need access", category: "payroll" },
      }),
      res,
    );

    expect(ticketInsert().params).toContain("org_admin");
  });

  it("routes an org-admin ticket to system_admin", async () => {
    const res = mockRes();
    await createTicket(
      orgReq(orgAdmin, {
        body: { subject: "Plan change", description: "Upgrade please", category: "admin" },
      }),
      res,
    );

    const insert = ticketInsert();
    expect(insert.params).toContain("system_admin");
    expect(insert.params).toContain(null);
  });

  it("rejects an unknown category", async () => {
    const res = mockRes();
    await expect(
      createTicket(
        orgReq(employee, {
          body: { subject: "x", description: "y", category: "not-a-category" },
        }),
        res,
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("GET /support/tickets visibility", () => {
  it("scopes an employee to their own tickets only", async () => {
    const res = mockRes();
    await listOrgTickets(orgReq(employee), res);

    const count = statements().find((s) => s.sql.startsWith("SELECT COUNT(*)"));
    expect(count.sql).toContain("t.raised_by_uuid = ?");
    expect(count.params).toContain(EMPLOYEE_UUID);
    expect(count.sql).not.toContain("t.assigned_to_role = 'org_admin'");
  });

  it("scopes a sub-admin to their own tickets only", async () => {
    const res = mockRes();
    await listOrgTickets(orgReq(subAdmin), res);

    const count = statements().find((s) => s.sql.startsWith("SELECT COUNT(*)"));
    expect(count.sql).toContain("t.raised_by_uuid = ?");
    expect(count.params).toContain(SUB_ADMIN_UUID);
  });

  it("lets an org admin see organization inbound tickets plus their own outbound", async () => {
    const res = mockRes();
    await listOrgTickets(orgReq(orgAdmin), res);

    const count = statements().find((s) => s.sql.startsWith("SELECT COUNT(*)"));
    expect(count.sql).toContain("t.organization_id = ?");
    expect(count.sql).toContain("t.assigned_to_role = 'org_admin'");
    expect(count.sql).toContain("t.raised_by_uuid = ?");
    expect(count.params).toEqual([ORG_ID, ORG_ADMIN_UUID]);
  });

  it("restricts the system-admin list to the system_admin tier", async () => {
    const res = mockRes();
    await listAdminTickets(adminReq(), res);

    const count = statements().find((s) => s.sql.startsWith("SELECT COUNT(*)"));
    expect(count.sql).toContain("t.assigned_to_role = 'system_admin'");
  });

  it("does not let an employee open another employee's ticket", async () => {
    currentTicket = orgTicket({ raised_by_uuid: SUB_ADMIN_UUID });
    await expect(getOrgTicket(orgReq(employee), mockRes())).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it("lets an org admin open an employee's inbound ticket in their organization", async () => {
    const res = mockRes();
    await getOrgTicket(orgReq(orgAdmin), res);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("does not let a system admin open a tier-1 org ticket", async () => {
    currentTicket = orgTicket();
    await expect(getAdminTicket(adminReq(), mockRes())).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it("lets a system admin open an org-admin outbound ticket", async () => {
    currentTicket = systemTicket();
    const res = mockRes();
    await getAdminTicket(adminReq(), res);
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

describe("conversation and resolution", () => {
  it("records an org admin's reply to an employee ticket on the admin side", async () => {
    currentTicket = orgTicket();
    const res = mockRes();
    await addOrgReply(orgReq(orgAdmin, { body: { message: "Looking into it" } }), res);

    const insert = statements().find((s) =>
      s.sql.startsWith("INSERT INTO support_ticket_replies"),
    );
    expect(insert.params).toContain("admin");
  });

  it("records an employee's reply on the requester side", async () => {
    currentTicket = orgTicket();
    const res = mockRes();
    await addOrgReply(orgReq(employee, { body: { message: "Still broken" } }), res);

    const insert = statements().find((s) =>
      s.sql.startsWith("INSERT INTO support_ticket_replies"),
    );
    expect(insert.params).toContain("org_user");
  });

  it("lets an org admin resolve an inbound ticket", async () => {
    currentTicket = orgTicket();
    const res = mockRes();
    await updateTicketStatus(orgReq(orgAdmin, { body: { status: "resolved" } }), res);

    const update = statements().find((s) =>
      s.sql.startsWith("UPDATE support_tickets SET status=?"),
    );
    expect(update.params).toEqual(["resolved", TICKET_UUID]);
  });

  it("lets a system admin resolve a ticket routed to system_admin", async () => {
    currentTicket = systemTicket({ uuid: TICKET_UUID });
    const res = mockRes();
    await updateTicketStatus(adminReq({ body: { status: "closed" } }), res);

    const update = statements().find((s) =>
      s.sql.startsWith("UPDATE support_tickets SET status=?"),
    );
    expect(update.params).toEqual(["closed", currentTicket.uuid]);
  });

  it("does not let a system admin resolve a tier-1 ticket", async () => {
    currentTicket = orgTicket();
    await expect(
      updateTicketStatus(adminReq({ body: { status: "resolved" } }), mockRes()),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("does not let an employee change ticket status", async () => {
    currentTicket = orgTicket();
    await expect(
      updateTicketStatus(orgReq(employee, { body: { status: "resolved" } }), mockRes()),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});
