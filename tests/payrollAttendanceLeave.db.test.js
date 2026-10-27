import { describe, it, expect, beforeAll, afterAll } from "vitest";
import dotenv from "dotenv";
import mysql from "mysql2/promise";
import { purgeTestOrgs } from "./helpers/dbCleanup.js";
import { seedPayrollBaseline, seedPayrollPolicy } from "./helpers/payrollPolicy.js";

import {
  createSalaryComponent,
  updateSalaryComponent,
  toggleSalaryComponentStatus,
  listSalaryComponents,
} from "../src/controllers/org/salaryComponents.controller.js";
import {
  assignEmployeeSalaryComponent,
  listEmployeeSalaryComponents,
  updateEmployeeSalaryComponent,
} from "../src/controllers/org/employeeSalaryComponents.controller.js";
import { setLeaveAllocation } from "../src/controllers/org/leaveAllocation.controller.js";
import { createLeave, decideLeave } from "../src/controllers/leave.controller.js";
import {
  addAllowedIp,
  checkIn,
  checkOut,
  manualEntry,
} from "../src/controllers/attendance.controller.js";
import {
  createOvertimeRequest,
  decideOvertimeRequest,
} from "../src/controllers/org/overtime.controller.js";
import { previewPayroll, generatePayroll } from "../src/controllers/salary.controller.js";

/**
 * THE FOUR CONNECTED HR MODULES, TESTED AS ONE CHAIN.
 *
 * Salary components were tested as catalog CRUD (if at all), attendance and
 * leave were tested as their own features, and payroll was tested as an
 * arithmetic function. Nothing drove the actual join:
 *
 *   component catalog -> employee assignment -> payroll line
 *   leave request -> admin approval -> balance decrement -> payroll deduction
 *   attendance entry -> attended/absent/late counts -> payroll deduction
 *   overtime approval -> approved hours -> payroll earning
 *
 * These modules only mean anything together: an approved leave day that never
 * reaches payroll is a leave system, not an HR system, and a component assigned
 * to an employee that never appears on their payslip is a catalog, not pay.
 *
 * Real database, not mocks. Every rule under test is a join or an arithmetic
 * result that MySQL computes (DATE columns, DECIMAL totals, enum statuses). A
 * mocked pool would agree with whatever the code already does, including the
 * bugs. The suite runs against one org per concern, with a fresh employee per
 * test so no assertion depends on the order of the file.
 *
 * Skipped, not failed, when no database is reachable.
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

const MONTH = 10;
const YEAR = 2026;
const BASIC = 30000;
/** October 2026 has 22 Mon-Fri weekdays, matching the seeded work week. */
const WORKING_DAYS = 22;
const PER_DAY = Math.round((BASIC / WORKING_DAYS) * 100) / 100;
const HOURLY = Math.round((PER_DAY / 8) * 100) / 100;
const money = (n) => Math.round(Number(n) * 100) / 100;

/** Every Mon-Fri in October 2026, derived so it cannot drift from the calendar. */
function weekdaysOfMonth() {
  const out = [];
  for (let d = 1; d <= 31; d += 1) {
    const date = new Date(Date.UTC(YEAR, MONTH - 1, d));
    const dow = date.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(`${YEAR}-10-${String(d).padStart(2, "0")}`);
  }
  return out;
}
const WEEKDAYS = weekdaysOfMonth();

let db;
let orgId;
let otherOrgId;
let adminUser;
let otherEmployeeUuid;
let unpaidTypeId;
let paidTypeId;
let runTag;
let n = 0;
const employeeUuids = [];
const orgsToPurge = [];

beforeAll(async () => {
  if (!HAS_DB) return;
  db = await mysql.createConnection(cfg);
  runTag = Date.now();

  // Main tenant: complete payroll baseline (Mon-Fri week + confirmed policy).
  const [org] = await db.query("INSERT INTO organizations (uuid, name) VALUES (UUID(), ?)", [
    `Payroll-Attendance-Leave ${runTag}`,
  ]);
  orgId = org.insertId;
  orgsToPurge.push(orgId);
  await seedPayrollBaseline(db, orgId);

  // The admin who approves leave, overtime and runs payroll. A REAL users row:
  // salary_components.created_by and salary_records.created_by are FKs to users(id).
  adminUser = await insertUser({
    org: orgId,
    name: `Payroll Admin ${runTag}`,
    email: `payroll-admin-${runTag}@example.com`,
    role: "org_admin",
  });

  // The two leave types the paid/unpaid split is built around.
  const [unpaid] = await db.query(
    `INSERT INTO leave_types (organization_id, name, days_allowed_per_year, is_paid)
     VALUES (?, 'Unpaid Leave', 0, 'no')`,
    [orgId],
  );
  unpaidTypeId = unpaid.insertId;

  const [paid] = await db.query(
    `INSERT INTO leave_types (organization_id, name, days_allowed_per_year, is_paid)
     VALUES (?, 'Sick Leave', 0, 'yes')`,
    [orgId],
  );
  paidTypeId = paid.insertId;

  // A second tenant, used to prove every read and write is org-scoped.
  const [otherOrg] = await db.query("INSERT INTO organizations (uuid, name) VALUES (UUID(), ?)", [
    `Payroll Other Tenant ${runTag}`,
  ]);
  otherOrgId = otherOrg.insertId;
  orgsToPurge.push(otherOrgId);
  const otherTenantEmployee = await newEmployee({ name: "OtherTenant", org: otherOrgId, platform: false });
  otherEmployeeUuid = otherTenantEmployee.uuid;

  // Manual attendance is capped to a backdate window. These fixtures are for a
  // fixed October 2026 payroll period, so widen the window rather than making
  // every attendance assertion depend on the day the suite happens to run.
  process.env.MANUAL_ATTENDANCE_MAX_AGE_DAYS = "3650";
});

afterAll(async () => {
  if (!db) return;
  try {
    for (const uuid of employeeUuids) {
      await db.query("DELETE FROM employees WHERE uuid=?", [uuid]);
    }
  } finally {
    await purgeTestOrgs(db, orgsToPurge);
    await db.end();
  }
});

// ---------------------------------------------------------------------------
// Fixtures + request doubles
// ---------------------------------------------------------------------------

function fakeRes() {
  const res = {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      return res;
    },
    setHeader(key, value) {
      res.headers[key] = value;
      return res;
    },
    send(payload) {
      res.sent = payload;
      return res;
    },
  };
  return res;
}

async function call(handler, req) {
  const res = fakeRes();
  await handler(req, res);
  return res;
}

function adminReq(overrides = {}) {
  return {
    scopeOrgId: orgId,
    user: adminUser,
    headers: {},
    ip: "127.0.0.1",
    body: {},
    query: {},
    params: {},
    ...overrides,
  };
}

function employeeReq(employee, overrides = {}) {
  return {
    user: employee.user,
    headers: {},
    ip: "::1",
    body: {},
    query: {},
    params: {},
    ...overrides,
  };
}

async function insertUser({ org, name, email, role }) {
  const [result] = await db.query(
    `INSERT INTO users (uuid, organization, full_name, email, password, status, org_role)
     VALUES (UUID(), ?, ?, ?, 'not-a-real-hash', 'active', ?)`,
    [org, name, email, role],
  );
  const [rows] = await db.query("SELECT id, uuid, full_name, org_role FROM users WHERE id=?", [
    result.insertId,
  ]);
  return {
    id: rows[0].id,
    uuid: rows[0].uuid,
    full_name: rows[0].full_name,
    org_role: rows[0].org_role,
    organization: org,
  };
}

/**
 * A fresh employee with its own linked platform user and salary history.
 * `allocations` is [{ typeId, days }].
 */
async function newEmployee({ name = "Probe", org = orgId, basic = BASIC, platform = true, allocations = [] } = {}) {
  n += 1;
  const email = `payroll-${runTag}-${n}@example.com`;
  let user = null;

  if (platform) {
    user = await insertUser({ org, name: `${name} ${n}`, email, role: "employee" });
  }

  const [emp] = await db.query(
    `INSERT INTO employees
       (uuid, full_name, email, organization_id, status, is_platform_user, linked_user_uuid, joining_date)
     VALUES (UUID(), ?, ?, ?, 'current_employee', ?, ?, '2024-01-01')`,
    [`${name} ${n}`, email, org, user ? "yes" : "no", user?.uuid ?? null],
  );
  const [rows] = await db.query("SELECT uuid FROM employees WHERE id=?", [emp.insertId]);
  const uuid = rows[0].uuid;
  employeeUuids.push(uuid);

  if (basic > 0) {
    await db.query(
      `INSERT INTO employee_salary_history
         (uuid, employee_uuid, year, basic_salary, effective_from, effective_to)
       VALUES (UUID(), ?, ?, ?, '2026-01-01', NULL)`,
      [uuid, YEAR, basic],
    );
  }

  for (const allocation of allocations) {
    await db.query(
      `INSERT INTO employee_leave_allocations
         (uuid, employee_uuid, leave_type_id, year, allocated_days, used_days, remaining_days)
       VALUES (UUID(), ?, ?, ?, ?, 0, ?)`,
      [uuid, allocation.typeId, YEAR, allocation.days, allocation.days],
    );
  }

  return { uuid, user, email };
}

/** Insert attendance on every working day except the excluded dates. */
async function attendAll(uuid, skip = []) {
  const skipped = new Set(skip);
  for (const date of WEEKDAYS) {
    if (skipped.has(date)) continue;
    await db.query(
      `INSERT INTO attendance_records
         (uuid, employee_uuid, organization_id, date, check_in_at, status, is_manual, created_at)
       VALUES (UUID(), ?, ?, ?, ?, 'checked_in', 'no', NOW())`,
      [uuid, orgId, date, `${date} 08:55:00`],
    );
  }
}

async function approveLeaveDirect(uuid, leaveTypeId, startDate, endDate) {
  await db.query(
    `INSERT INTO leave_requests
       (uuid, employee_uuid, leave_type_id, start_date, end_date, status, approved_at)
     VALUES (UUID(), ?, ?, ?, ?, 'approved', NOW())`,
    [uuid, leaveTypeId, startDate, endDate],
  );
}

async function createComponent(payload, req = adminReq()) {
  const res = await call(createSalaryComponent, { ...req, body: payload });
  expect(res.statusCode).toBe(201);
  return res.body.data.component;
}

async function assignComponent(employeeUuid, component, amount, req = adminReq()) {
  const res = await call(assignEmployeeSalaryComponent, {
    ...req,
    params: { uuid: employeeUuid },
    body: { salary_component_id: component.id, amount },
  });
  expect(res.statusCode).toBe(201);
  return res.body.data.assignments;
}

async function preview(employeeUuid, { org = orgId } = {}) {
  const res = await call(
    previewPayroll,
    adminReq({
      scopeOrgId: org,
      body: { month: MONTH, year: YEAR, employee_uuids: [employeeUuid] },
    }),
  );
  expect(res.statusCode).toBe(200);
  const item = res.body.data.items.find((i) => i.employee_uuid === employeeUuid);
  expect(item).toBeTruthy();
  return item;
}

const lineOf = (previewItem, source) => previewItem.lines.find((l) => l.source === source);

async function generate(employeeUuids, { regenerate = false } = {}) {
  return call(
    generatePayroll,
    adminReq({
      body: { month: MONTH, year: YEAR, employee_uuids: employeeUuids, regenerate },
    }),
  );
}

async function salaryRecordOf(employeeUuid) {
  const [rows] = await db.query(
    `SELECT * FROM salary_records
      WHERE organization_id=? AND employee_uuid=? AND month=? AND year=?`,
    [orgId, employeeUuid, MONTH, YEAR],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Salary component catalog -> employee assignment -> payslip
// ---------------------------------------------------------------------------

describe.runIf(HAS_DB)("salary components reach the payslip", () => {
  it("a fixed allowance, a percentage allowance and a deduction all appear on the payslip", async () => {
    const emp = await newEmployee({ name: "Components" });
    await attendAll(emp.uuid);

    const transport = await createComponent({
      name: `Transport ${runTag}`,
      type: "allowance",
      default_value: 5000,
    });
    const tax = await createComponent({
      name: `Tax ${runTag}`,
      type: "deduction",
      default_value: 1000,
    });
    const rent = await createComponent({
      name: `House Rent ${runTag}`,
      type: "allowance",
      is_percentage: true,
      default_value: 10,
    });

    await assignComponent(emp.uuid, transport, 5000);
    await assignComponent(emp.uuid, tax, 1000);
    await assignComponent(emp.uuid, rent, 10);

    const listed = await call(listEmployeeSalaryComponents, {
      ...adminReq(),
      params: { uuid: emp.uuid },
    });
    expect(listed.body.data.assignments).toHaveLength(3);

    const p = await preview(emp.uuid);
    expect(p.lines.filter((l) => l.source === "component")).toHaveLength(3);

    const transportLine = p.lines.find((l) => l.label === `Transport ${runTag}`);
    const taxLine = p.lines.find((l) => l.label === `Tax ${runTag}`);
    const rentLine = p.lines.find((l) => l.label === `House Rent ${runTag}`);
    expect(taxLine?.type).toBe("deduction");
    expect(Number(transportLine?.amount)).toBe(5000);
    expect(Number(taxLine?.amount)).toBe(1000);
    expect(Number(rentLine?.amount)).toBe(3000);

    expect(Number(p.allowances)).toBe(8000);
    expect(Number(p.deductions)).toBe(1000);
    expect(Number(p.net_salary)).toBe(37000);
  });

  it("assigning the same catalog component twice is refused, not double-paid", async () => {
    const emp = await newEmployee({ name: "DuplicateComponent" });
    await attendAll(emp.uuid);
    const component = await createComponent({
      name: `Mobile Allowance ${runTag}`,
      type: "allowance",
      default_value: 2000,
    });
    await assignComponent(emp.uuid, component, 2000);

    await expect(
      call(assignEmployeeSalaryComponent, {
        ...adminReq(),
        params: { uuid: emp.uuid },
        body: { salary_component_id: component.id, amount: 9999 },
      }),
    ).rejects.toMatchObject({ statusCode: 409 });

    const p = await preview(emp.uuid);
    expect(Number(p.allowances)).toBe(2000);
  });

  it("deactivating an employee's assignment removes it from the next preview", async () => {
    const emp = await newEmployee({ name: "DeactivateAssignment" });
    await attendAll(emp.uuid);
    const component = await createComponent({
      name: `Fuel Allowance ${runTag}`,
      type: "allowance",
      default_value: 2500,
    });
    const assignments = await assignComponent(emp.uuid, component, 2500);
    const assignmentUuid = assignments[0].uuid;

    expect(Number((await preview(emp.uuid)).allowances)).toBe(2500);

    const updated = await call(updateEmployeeSalaryComponent, {
      ...adminReq(),
      params: { uuid: emp.uuid, assignUuid: assignmentUuid },
      body: { is_active: false },
    });
    expect(updated.statusCode).toBe(200);

    const p = await preview(emp.uuid);
    expect(p.lines.some((l) => l.label === `Fuel Allowance ${runTag}`)).toBe(false);
    expect(Number(p.allowances)).toBe(0);
    expect(Number(p.net_salary)).toBe(BASIC);
  });

  it("deactivating the CATALOG component stops future payroll applying it", async () => {
    // The status toggle says it stops the component being applied to future
    // payroll generations. An assignment remains active, so the payroll query
    // has to respect the catalog's is_active flag as well as the assignment's.
    const emp = await newEmployee({ name: "DeactivateCatalog" });
    await attendAll(emp.uuid);
    const component = await createComponent({
      name: `Internet Allowance ${runTag}`,
      type: "allowance",
      default_value: 1800,
    });
    await assignComponent(emp.uuid, component, 1800);

    expect(Number((await preview(emp.uuid)).allowances)).toBe(1800);

    const toggled = await call(toggleSalaryComponentStatus, {
      ...adminReq(),
      params: { uuid: component.uuid },
    });
    expect(toggled.statusCode).toBe(200);
    expect(Number(toggled.body.data.component.is_active)).toBe(0);

    const p = await preview(emp.uuid);
    expect(p.lines.some((l) => l.label === `Internet Allowance ${runTag}`)).toBe(false);
    expect(Number(p.allowances)).toBe(0);
    expect(Number(p.net_salary)).toBe(BASIC);
  });

  it("updating the assignment amount changes the next preview", async () => {
    const emp = await newEmployee({ name: "UpdateAmount" });
    await attendAll(emp.uuid);
    const component = await createComponent({
      name: `Utility Allowance ${runTag}`,
      type: "allowance",
      default_value: 1000,
    });
    const assignments = await assignComponent(emp.uuid, component, 1000);

    await call(updateEmployeeSalaryComponent, {
      ...adminReq(),
      params: { uuid: emp.uuid, assignUuid: assignments[0].uuid },
      body: { amount: 4500 },
    });

    const p = await preview(emp.uuid);
    const line = p.lines.find((l) => l.label === `Utility Allowance ${runTag}`);
    expect(Number(line.amount)).toBe(4500);
    expect(Number(p.allowances)).toBe(4500);
  });

  it("catalog filters and tenant scoping hold", async () => {
    await createComponent(
      { name: `Filter Allowance ${runTag}`, type: "allowance", default_value: 1 },
    );
    const allowances = await call(listSalaryComponents, {
      ...adminReq(),
      query: { type: "allowance" },
    });
    expect(allowances.statusCode).toBe(200);
    expect(allowances.body.data.items.every((c) => c.type === "allowance")).toBe(true);

    const otherComponent = await createComponent({
      name: `Other Tenant Component ${runTag}`,
      type: "allowance",
      default_value: 1,
    });
    // Assigning this org's component to another tenant's employee is a 404:
    // the employee is not in scope, and the component is not a back door.
    await expect(
      call(assignEmployeeSalaryComponent, {
        ...adminReq(),
        params: { uuid: otherEmployeeUuid },
        body: { salary_component_id: otherComponent.id, amount: 1 },
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

// ---------------------------------------------------------------------------
// Leave request -> approval -> balance -> payroll
// ---------------------------------------------------------------------------

describe.runIf(HAS_DB)("leave requests reach the payslip", () => {
  it("an approved UNPAID leave request moves from absence to one unpaid-leave deduction", async () => {
    const emp = await newEmployee({
      name: "UnpaidLeaveFlow",
      allocations: [{ typeId: unpaidTypeId, days: 10 }],
    });
    // Works the whole month except the two days being requested, so the only
    // variable under test is the leave decision.
    await attendAll(emp.uuid, ["2026-10-06", "2026-10-07"]);

    const before = await preview(emp.uuid);
    expect(before.attendance.absent_days).toBe(2);
    expect(before.attendance.unpaid_leave_days).toBe(0);
    expect(Number(lineOf(before, "auto_absenteeism")?.amount)).toBe(money(PER_DAY * 2));

    const submitted = await call(createLeave, employeeReq(emp, {
      body: {
        leave_type_id: unpaidTypeId,
        start_date: "2026-10-06",
        end_date: "2026-10-07",
        reason: "Family emergency",
      },
    }));
    expect(submitted.statusCode).toBe(201);
    expect(submitted.body.data.leaveRequest.status).toBe("pending");
    const leaveUuid = submitted.body.data.leaveRequest.uuid;

    // PENDING leave changes nothing: payroll only counts an approved request.
    const pending = await preview(emp.uuid);
    expect(pending.attendance.unpaid_leave_days).toBe(0);
    expect(pending.attendance.absent_days).toBe(2);

    const decided = await call(decideLeave, adminReq({
      params: { uuid: leaveUuid },
      body: { status: "approved" },
    }));
    expect(decided.statusCode).toBe(200);
    expect(decided.body.data.leaveRequest.status).toBe("approved");

    const [alloc] = await db.query(
      "SELECT allocated_days, used_days, remaining_days FROM employee_leave_allocations WHERE employee_uuid=? AND leave_type_id=? AND year=?",
      [emp.uuid, unpaidTypeId, YEAR],
    );
    expect(alloc[0].used_days).toBe(2);
    expect(alloc[0].remaining_days).toBe(8);

    const after = await preview(emp.uuid);
    expect(after.attendance.unpaid_leave_days).toBe(2);
    // The same two days are now LEAVE, not absence: charged exactly once.
    expect(after.attendance.absent_days).toBe(0);
    const leaveLine = lineOf(after, "auto_unpaid_leave");
    expect(leaveLine).toBeTruthy();
    expect(Number(leaveLine.amount)).toBe(money(PER_DAY * 2));
    expect(Number(leaveLine.basis_value)).toBe(2);
    expect(Number(after.deductions)).toBe(Number(before.deductions));
  });

  it("a REJECTED request leaves the balance and the payslip untouched", async () => {
    const emp = await newEmployee({
      name: "RejectedLeave",
      allocations: [{ typeId: unpaidTypeId, days: 10 }],
    });
    await attendAll(emp.uuid);

    const submitted = await call(createLeave, employeeReq(emp, {
      body: {
        leave_type_id: unpaidTypeId,
        start_date: "2026-10-12",
        end_date: "2026-10-12",
        reason: "Appointment",
      },
    }));
    const leaveUuid = submitted.body.data.leaveRequest.uuid;

    const pending = await preview(emp.uuid);
    expect(Number(pending.deductions)).toBe(0);

    const decided = await call(decideLeave, adminReq({
      params: { uuid: leaveUuid },
      body: { status: "rejected" },
    }));
    expect(decided.statusCode).toBe(200);
    expect(decided.body.data.leaveRequest.status).toBe("rejected");

    const [alloc] = await db.query(
      "SELECT used_days, remaining_days FROM employee_leave_allocations WHERE employee_uuid=? AND leave_type_id=? AND year=?",
      [emp.uuid, unpaidTypeId, YEAR],
    );
    expect(alloc[0].used_days).toBe(0);
    expect(alloc[0].remaining_days).toBe(10);

    const after = await preview(emp.uuid);
    expect(after.lines.some((l) => l.source === "auto_unpaid_leave")).toBe(false);
    expect(Number(after.deductions)).toBe(0);
  });

  it("approving beyond the remaining balance is refused atomically", async () => {
    const emp = await newEmployee({
      name: "InsufficientLeave",
      allocations: [{ typeId: unpaidTypeId, days: 1 }],
    });
    await attendAll(emp.uuid);

    // Submission is allowed while ANY balance remains; the approval is the
    // gate that has to count the requested days.
    const submitted = await call(createLeave, employeeReq(emp, {
      body: {
        leave_type_id: unpaidTypeId,
        start_date: "2026-10-06",
        end_date: "2026-10-07",
        reason: "Two days on one day's balance",
      },
    }));
    expect(submitted.statusCode).toBe(201);
    const leaveUuid = submitted.body.data.leaveRequest.uuid;

    await expect(
      call(decideLeave, adminReq({ params: { uuid: leaveUuid }, body: { status: "approved" } })),
    ).rejects.toMatchObject({ statusCode: 409 });

    const [alloc] = await db.query(
      "SELECT used_days, remaining_days FROM employee_leave_allocations WHERE employee_uuid=? AND leave_type_id=? AND year=?",
      [emp.uuid, unpaidTypeId, YEAR],
    );
    expect(alloc[0].used_days).toBe(0);
    expect(alloc[0].remaining_days).toBe(1);

    const [request] = await db.query("SELECT status FROM leave_requests WHERE uuid=?", [leaveUuid]);
    expect(request[0].status).toBe("pending");

    const p = await preview(emp.uuid);
    expect(p.lines.some((l) => l.source === "auto_unpaid_leave")).toBe(false);

    // The admin can still reject it, and that must succeed.
    const rejected = await call(decideLeave, adminReq({
      params: { uuid: leaveUuid },
      body: { status: "rejected" },
    }));
    expect(rejected.body.data.leaveRequest.status).toBe("rejected");
  });

  it("submission is blocked when the employee has no allocation for that type", async () => {
    const emp = await newEmployee({ name: "NoAllocation", allocations: [] });
    await expect(
      call(createLeave, employeeReq(emp, {
        body: {
          leave_type_id: unpaidTypeId,
          start_date: "2026-10-06",
          end_date: "2026-10-06",
          reason: "No balance",
        },
      })),
    ).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/balance remaining/i) });
  });

  it("org admins review leave but cannot submit it for themselves", async () => {
    await expect(
      call(createLeave, {
        user: adminUser,
        headers: {},
        ip: "127.0.0.1",
        body: { leave_type_id: unpaidTypeId, start_date: "2026-10-06", end_date: "2026-10-06" },
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("an approved PAID leave day excuses absence and costs nothing", async () => {
    const emp = await newEmployee({
      name: "PaidLeaveFlow",
      allocations: [{ typeId: paidTypeId, days: 10 }],
    });

    const before = await preview(emp.uuid);
    expect(before.attendance.absent_days).toBe(WORKING_DAYS);

    const submitted = await call(createLeave, employeeReq(emp, {
      body: {
        leave_type_id: paidTypeId,
        start_date: "2026-10-12",
        end_date: "2026-10-12",
        reason: "Sick",
      },
    }));
    const leaveUuid = submitted.body.data.leaveRequest.uuid;
    await call(decideLeave, adminReq({
      params: { uuid: leaveUuid },
      body: { status: "approved" },
    }));

    const after = await preview(emp.uuid);
    expect(after.attendance.paid_leave_days).toBe(1);
    expect(after.attendance.absent_days).toBe(WORKING_DAYS - 1);
    expect(after.lines.some((l) => l.source === "auto_unpaid_leave")).toBe(false);
    expect(Number(after.deductions)).toBe(money(PER_DAY * (WORKING_DAYS - 1)));
  });

  it("allocations can be changed per employee without losing used days", async () => {
    const emp = await newEmployee({
      name: "AllocationEdit",
      allocations: [{ typeId: unpaidTypeId, days: 5 }],
    });
    await attendAll(emp.uuid, ["2026-10-06"]);

    const submitted = await call(createLeave, employeeReq(emp, {
      body: {
        leave_type_id: unpaidTypeId,
        start_date: "2026-10-06",
        end_date: "2026-10-06",
        reason: "Personal",
      },
    }));
    await call(decideLeave, adminReq({
      params: { uuid: submitted.body.data.leaveRequest.uuid },
      body: { status: "approved" },
    }));

    const res = await call(setLeaveAllocation, adminReq({
      body: {
        employee_uuid: emp.uuid,
        leave_type_id: unpaidTypeId,
        year: YEAR,
        allocated_days: 8,
      },
    }));
    expect(res.statusCode).toBe(200);
    // used_days is history and is preserved; remaining is recalculated.
    expect(res.body.data.allocation.used_days).toBe(1);
    expect(res.body.data.allocation.allocated_days).toBe(8);
    expect(res.body.data.allocation.remaining_days).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Attendance -> payroll
// ---------------------------------------------------------------------------

describe.runIf(HAS_DB)("attendance records reach the payslip", () => {
  it("manual attendance adds attended days and three late arrivals cost half a day", async () => {
    const emp = await newEmployee({ name: "AttendanceFlow" });

    const empty = await preview(emp.uuid);
    expect(empty.attendance.attended_days).toBe(0);
    expect(empty.attendance.absent_days).toBe(WORKING_DAYS);

    const add = (date, time) =>
      call(manualEntry, adminReq({
        body: {
          employee_uuid: emp.uuid,
          date,
          check_in_time: time,
          reason: "Biometric device offline",
        },
      }));

    expect((await add("2026-10-05", "08:55")).statusCode).toBe(201); // on time
    const one = await preview(emp.uuid);
    expect(one.attendance.attended_days).toBe(1);
    expect(one.attendance.absent_days).toBe(WORKING_DAYS - 1);
    expect(one.attendance.late_count).toBe(0);

    expect((await add("2026-10-06", "09:45")).statusCode).toBe(201);
    expect((await add("2026-10-07", "10:15")).statusCode).toBe(201);
    expect((await add("2026-10-08", "11:30")).statusCode).toBe(201);

    const four = await preview(emp.uuid);
    expect(four.attendance.attended_days).toBe(4);
    expect(four.attendance.late_count).toBe(3);
    expect(four.attendance.absent_days).toBe(WORKING_DAYS - 4);

    const lateLine = lineOf(four, "auto_late");
    expect(lateLine).toBeTruthy();
    expect(Number(lateLine.amount)).toBe(money(PER_DAY * 0.5));
    expect(Number(lateLine.basis_value)).toBe(3);
    expect(Number(lineOf(four, "auto_absenteeism").amount)).toBe(
      money(PER_DAY * (WORKING_DAYS - 4)),
    );
    // 3 late arrivals x the configured threshold of 3 = one half-day penalty.
    expect(Number(four.deductions)).toBe(
      money(PER_DAY * (WORKING_DAYS - 4) + PER_DAY * 0.5),
    );
  });

  it("attendance on a weekend is recorded but is not a working day", async () => {
    const emp = await newEmployee({ name: "WeekendEntry" });
    const res = await call(manualEntry, adminReq({
      body: {
        employee_uuid: emp.uuid,
        date: "2026-10-03", // Saturday
        check_in_time: "09:00",
        reason: "Weekend cover",
      },
    }));
    expect(res.statusCode).toBe(201);

    const p = await preview(emp.uuid);
    expect(p.attendance.working_days).toBe(WORKING_DAYS);
    expect(p.attendance.attended_days).toBe(0);
    expect(p.attendance.absent_days).toBe(WORKING_DAYS);
  });

  it("manual attendance validates the reason, duplicate date, future date and tenant", async () => {
    const emp = await newEmployee({ name: "AttendanceValidation" });
    await call(manualEntry, adminReq({
      body: {
        employee_uuid: emp.uuid,
        date: "2026-10-05",
        check_in_time: "09:00",
        reason: "First entry",
      },
    }));

    await expect(
      call(manualEntry, adminReq({
        body: { employee_uuid: emp.uuid, date: "2026-10-06", check_in_time: "09:00" },
      })),
    ).rejects.toMatchObject({ statusCode: 400, message: /reason is required/i });

    await expect(
      call(manualEntry, adminReq({
        body: {
          employee_uuid: emp.uuid,
          date: "2026-10-05",
          check_in_time: "09:00",
          reason: "Duplicate",
        },
      })),
    ).rejects.toMatchObject({ statusCode: 409 });

    await expect(
      call(manualEntry, adminReq({
        body: {
          employee_uuid: emp.uuid,
          date: "2099-01-01",
          check_in_time: "09:00",
          reason: "Future",
        },
      })),
    ).rejects.toMatchObject({ statusCode: 400, message: /future date/i });

    await expect(
      call(manualEntry, adminReq({
        body: {
          employee_uuid: otherEmployeeUuid,
          date: "2026-10-05",
          check_in_time: "09:00",
          reason: "Cross tenant",
        },
      })),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("self check-in and check-out work once each, and refuse a duplicate", async () => {
    const emp = await newEmployee({ name: "SelfAttendance" });

    const ip = await call(addAllowedIp, adminReq({ body: { ip: "10.90.90.90" } }));
    expect(ip.statusCode).toBe(200);

    const first = await call(checkIn, employeeReq(emp));
    expect(first.statusCode).toBe(201);
    expect(first.body.data.record.status).toBe("checked_in");

    await expect(call(checkIn, employeeReq(emp))).rejects.toMatchObject({ statusCode: 409 });

    const out = await call(checkOut, employeeReq(emp));
    expect(out.statusCode).toBe(200);
    expect(out.body.data.record.status).toBe("checked_out");
    expect(out.body.data.record.check_out_at).toBeTruthy();

    await expect(call(checkOut, employeeReq(emp))).rejects.toMatchObject({ statusCode: 409 });
  });
});

// ---------------------------------------------------------------------------
// Overtime approval -> payroll earning
// ---------------------------------------------------------------------------

describe.runIf(HAS_DB)("approved overtime reaches the payslip", () => {
  it("pays only APPROVED hours, clamped to the request, and never the rejected ones", async () => {
    const emp = await newEmployee({ name: "OvertimeFlow" });
    await attendAll(emp.uuid);

    const created = await call(createOvertimeRequest, adminReq({
      body: {
        employee_uuid: emp.uuid,
        work_date: "2026-10-20",
        requested_hours: 8,
        reason: "Month-end close",
      },
    }));
    expect(created.statusCode).toBe(201);
    expect(created.body.data.overtimeRequest.status).toBe("pending");
    const overtimeUuid = created.body.data.overtimeRequest.uuid;

    await expect(
      call(createOvertimeRequest, adminReq({
        body: { employee_uuid: emp.uuid, work_date: "2026-10-20", requested_hours: 2 },
      })),
    ).rejects.toMatchObject({ statusCode: 409 });

    // Asking to approve 10 when only 8 were claimed is clamped to 8.
    const approved = await call(decideOvertimeRequest, adminReq({
      params: { uuid: overtimeUuid },
      body: { status: "approved", approved_hours: 10 },
    }));
    expect(approved.statusCode).toBe(200);
    expect(Number(approved.body.data.overtimeRequest.approved_hours)).toBe(8);

    await expect(
      call(decideOvertimeRequest, adminReq({
        params: { uuid: overtimeUuid },
        body: { status: "rejected" },
      })),
    ).rejects.toMatchObject({ statusCode: 409 });

    // Rejected and pending requests must not add a rupee.
    const rejected = await call(createOvertimeRequest, adminReq({
      body: { employee_uuid: emp.uuid, work_date: "2026-10-21", requested_hours: 5 },
    }));
    await call(decideOvertimeRequest, adminReq({
      params: { uuid: rejected.body.data.overtimeRequest.uuid },
      body: { status: "rejected" },
    }));
    await call(createOvertimeRequest, adminReq({
      body: { employee_uuid: emp.uuid, work_date: "2026-10-22", requested_hours: 4 },
    }));

    const p = await preview(emp.uuid);
    expect(p.attendance.approved_overtime_hours).toBe(8);
    const line = lineOf(p, "auto_overtime");
    expect(line).toBeTruthy();
    expect(line.type).toBe("earning");
    expect(Number(line.basis_value)).toBe(8);
    expect(Number(line.amount)).toBe(money(HOURLY * 1.5 * 8));
    expect(Number(p.allowances)).toBe(money(HOURLY * 1.5 * 8));
    expect(Number(p.net_salary)).toBe(money(BASIC + HOURLY * 1.5 * 8));
  });
});

// ---------------------------------------------------------------------------
// Preview -> generate: the whole chain, committed
// ---------------------------------------------------------------------------

describe.runIf(HAS_DB)("payroll preview and generation agree end to end", () => {
  it("commits exactly the previewed totals and itemises basic, components, leave and overtime", async () => {
    const emp = await newEmployee({
      name: "FullChain",
      allocations: [{ typeId: unpaidTypeId, days: 10 }],
    });
    await attendAll(emp.uuid, ["2026-10-06", "2026-10-07"]);
    await approveLeaveDirect(emp.uuid, unpaidTypeId, "2026-10-06", "2026-10-07");

    const transport = await createComponent({
      name: `FullChain Transport ${runTag}`,
      type: "allowance",
      default_value: 5000,
    });
    const tax = await createComponent({
      name: `FullChain Tax ${runTag}`,
      type: "deduction",
      default_value: 1000,
    });
    const rent = await createComponent({
      name: `FullChain Rent ${runTag}`,
      type: "allowance",
      is_percentage: true,
      default_value: 10,
    });
    await assignComponent(emp.uuid, transport, 5000);
    await assignComponent(emp.uuid, tax, 1000);
    await assignComponent(emp.uuid, rent, 10);

    const overtime = await call(createOvertimeRequest, adminReq({
      body: { employee_uuid: emp.uuid, work_date: "2026-10-20", requested_hours: 6 },
    }));
    await call(decideOvertimeRequest, adminReq({
      params: { uuid: overtime.body.data.overtimeRequest.uuid },
      body: { status: "approved", approved_hours: 6 },
    }));

    const p = await preview(emp.uuid);
    expect(p.attendance.working_days).toBe(WORKING_DAYS);
    expect(p.attendance.attended_days).toBe(20);
    expect(p.attendance.absent_days).toBe(0);
    expect(p.attendance.unpaid_leave_days).toBe(2);
    expect(p.attendance.approved_overtime_hours).toBe(6);

    const expectedOvertime = money(HOURLY * 1.5 * 6);
    expect(Number(p.allowances)).toBe(money(8000 + expectedOvertime));
    expect(Number(p.deductions)).toBe(money(1000 + PER_DAY * 2));
    expect(Number(p.net_salary)).toBe(
      money(BASIC + 8000 + expectedOvertime - 1000 - PER_DAY * 2),
    );

    const generated = await generate([emp.uuid]);
    expect(generated.statusCode).toBe(200);
    expect(generated.body.data.count).toBeGreaterThanOrEqual(1);

    const records = await salaryRecordOf(emp.uuid);
    expect(records).toHaveLength(1);
    const record = records[0];
    // The stored totals are the previewed totals, to the paisa.
    expect(Number(record.basic_salary)).toBe(Number(p.basic_salary));
    expect(Number(record.allowances)).toBe(Number(p.allowances));
    expect(Number(record.deductions)).toBe(Number(p.deductions));
    expect(Number(record.net_salary)).toBe(Number(p.net_salary));

    const [lines] = await db.query(
      "SELECT label, type, source, amount, basis_value, basis_unit FROM salary_record_lines WHERE salary_record_uuid=? ORDER BY id",
      [record.uuid],
    );
    const sources = lines.map((l) => l.source);
    expect(sources).toContain("basic");
    expect(sources).toContain("component");
    expect(sources).toContain("auto_unpaid_leave");
    expect(sources).toContain("auto_overtime");
    expect(sources).not.toContain("auto_absenteeism");

    expect(lines).toHaveLength(6); // basic + 3 components + unpaid leave + overtime
    const earnings = lines.filter((l) => l.type === "earning").reduce((s, l) => s + Number(l.amount), 0);
    const deductions = lines.filter((l) => l.type === "deduction").reduce((s, l) => s + Number(l.amount), 0);
    expect(money(earnings - deductions)).toBe(Number(record.net_salary));

    const leaveLine = lines.find((l) => l.source === "auto_unpaid_leave");
    expect(Number(leaveLine.basis_value)).toBe(2);
    expect(leaveLine.basis_unit).toBe("days");
    const overtimeLine = lines.find((l) => l.source === "auto_overtime");
    expect(Number(overtimeLine.basis_value)).toBe(6);
    expect(overtimeLine.basis_unit).toBe("hours");

    // A second generate for the same employee/period is refused, not duplicated.
    await expect(generate([emp.uuid])).rejects.toMatchObject({ statusCode: 409 });

    // Regenerate is the explicit recompute path: it replaces the record and
    // picks up a changed assignment amount.
    const assignments = await call(listEmployeeSalaryComponents, {
      ...adminReq(),
      params: { uuid: emp.uuid },
    });
    const transportAssignment = assignments.body.data.assignments.find(
      (a) => a.name === `FullChain Transport ${runTag}`,
    );
    await call(updateEmployeeSalaryComponent, {
      ...adminReq(),
      params: { uuid: emp.uuid, assignUuid: transportAssignment.uuid },
      body: { amount: 7000 },
    });

    const regenerated = await generate([emp.uuid], { regenerate: true });
    expect(regenerated.statusCode).toBe(200);
    const [afterRegenerate] = await salaryRecordOf(emp.uuid);
    expect(Number(afterRegenerate.allowances)).toBe(
      money(7000 + 3000 + expectedOvertime),
    );
    expect(Number(afterRegenerate.net_salary)).toBe(
      money(BASIC + 7000 + 3000 + expectedOvertime - 1000 - PER_DAY * 2),
    );
  });

  it("generation refuses an employee with no effective basic salary and writes nothing", async () => {
    const emp = await newEmployee({ name: "NoBasic", basic: 0 });
    await attendAll(emp.uuid);

    const previewRes = await call(previewPayroll, adminReq({
      body: { month: MONTH, year: YEAR, employee_uuids: [emp.uuid] },
    }));
    // Preview is not a blocker: it reports why there is nothing to compute.
    expect(previewRes.statusCode).toBe(200);
    expect(previewRes.body.data.items[0].rates.skip_reason).toBe("no_basic_salary");

    await expect(generate([emp.uuid])).rejects.toMatchObject({
      statusCode: 409,
      message: /no positive effective basic salary/i,
    });

    expect(await salaryRecordOf(emp.uuid)).toHaveLength(0);
  });

  it("preview refuses an org with no confirmed payroll policy", async () => {
    const res = await call(previewPayroll, adminReq({
      scopeOrgId: otherOrgId,
      body: { month: MONTH, year: YEAR },
    })).catch((error) => ({ error }));
    // The other tenant has an employee but no policy: preview must stop, not
    // invent a deduction formula.
    expect(res.error?.statusCode).toBe(409);
    expect(res.error?.message).toMatch(/Payroll policy is not configured/i);
  });

  it("preview refuses an org whose working week is not configured", async () => {
    const [third] = await db.query("INSERT INTO organizations (uuid, name) VALUES (UUID(), ?)", [
      `Payroll No Week ${runTag}`,
    ]);
    const thirdOrgId = third.insertId;
    orgsToPurge.push(thirdOrgId);
    // Policy without a work week: exactly one of the two configured inputs.
    await seedPayrollPolicy(db, thirdOrgId);
    const emp = await newEmployee({
      name: "NoWorkWeek",
      org: thirdOrgId,
      platform: false,
    });

    const res = await call(previewPayroll, adminReq({
      scopeOrgId: thirdOrgId,
      body: { month: MONTH, year: YEAR, employee_uuids: [emp.uuid] },
    })).catch((error) => ({ error }));
    expect(res.error?.statusCode).toBe(409);
    expect(res.error?.message).toMatch(/work week is not configured/i);
  });

  it("another tenant's employee cannot be previewed or generated", async () => {
    await expect(
      call(previewPayroll, adminReq({
        body: { month: MONTH, year: YEAR, employee_uuids: [otherEmployeeUuid] },
      })),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(generate([otherEmployeeUuid])).rejects.toMatchObject({ statusCode: 404 });
    const [rows] = await db.query(
      "SELECT COUNT(*) AS n FROM salary_records WHERE employee_uuid=? AND month=? AND year=?",
      [otherEmployeeUuid, MONTH, YEAR],
    );
    expect(Number(rows[0].n)).toBe(0);
  });
});
