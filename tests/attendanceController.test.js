import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config/db.js", () => ({ pool: { query: vi.fn(), getConnection: vi.fn() } }));
vi.mock("../src/utils/auditLog.js", () => ({
  logAudit: vi.fn(),
  getActorFromReq: vi.fn(() => ({ actorType: "user", actorId: 7, actorName: "Admin", actorRole: "org_admin" })),
}));

import { pool } from "../src/config/db.js";
import { logAudit } from "../src/utils/auditLog.js";
import {
  checkIn,
  checkOut,
  correctAttendance,
  listMissingAttendance,
  manualMissingEntry,
} from "../src/controllers/attendance.controller.js";

const ORG_ID = 7;
const EMPLOYEE_UUID = "123e4567-e89b-12d3-a456-426614174000";
const ATTENDANCE_UUID = "323e4567-e89b-12d3-a456-426614174000";

function response() {
  return {
    statusCode: 0,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function request(body = {}) {
  return {
    user: { id: 7, uuid: "423e4567-e89b-12d3-a456-426614174000", org_role: "employee", organization: ORG_ID },
    scopeOrgId: ORG_ID,
    params: {},
    query: {},
    body,
    ip: "::1",
    headers: {},
  };
}

function setup({ active = null, closed = null, correction = null } = {}) {
  const state = { active, closed, correction, checkout: null, inserted: null, updated: null };
  pool.query.mockImplementation(async (sql) => {
    const statement = String(sql);
    if (statement.includes("FROM employees WHERE linked_user_uuid")) {
      return [[{ uuid: EMPLOYEE_UUID, organization_id: ORG_ID, is_platform_user: "yes" }]];
    }
    if (statement.includes("FROM organizations WHERE id")) return [[{ id: ORG_ID }]];
    if (statement.includes("FROM organization_ip_rules")) {
      return [[{ ip_address: "10.0.0.1", rule_type: "allow" }]];
    }
    if (statement.includes("WHERE ar.id=?")) {
      return [[{
        uuid: ATTENDANCE_UUID,
        employee_uuid: EMPLOYEE_UUID,
        organization_id: ORG_ID,
        date: "2026-11-10",
        check_in_at: state.inserted?.check_in_at ?? state.updated?.check_in_at ?? "2026-11-10 09:00:00",
        check_out_at: state.checkout ?? state.inserted?.check_out_at ?? state.updated?.check_out_at ?? null,
        checkout_source: state.checkout ? "self" : state.updated?.checkout_source ?? null,
        worked_minutes: state.updated?.worked_minutes ?? null,
        overtime_minutes: state.updated?.overtime_minutes ?? null,
        status: state.checkout ? "checked_out" : state.updated?.status ?? "checked_in",
      }]];
    }
    if (statement.includes("INSERT INTO audit_logs")) return [{ affectedRows: 1 }];
    return [{ affectedRows: 1, insertId: 9 }];
  });

  const connection = {
    beginTransaction: vi.fn(),
    commit: vi.fn(),
    rollback: vi.fn(),
    release: vi.fn(),
    query: vi.fn(async (sql, params = []) => {
      const statement = String(sql);
      if (statement.includes("FROM employees WHERE uuid=? AND organization_id=?")) {
        return [[{ uuid: EMPLOYEE_UUID }]];
      }
      if (statement.includes("SELECT id, status FROM attendance_records")) {
        return [state.closed ? [state.closed] : []];
      }
      if (statement.includes("check_out_at IS NULL AND status='checked_in'")
          && statement.includes("FROM attendance_records")
          && statement.includes("break_duration_minutes")) {
        return [state.active && !state.checkout ? [state.active] : []];
      }
      if (statement.includes("SELECT id FROM attendance_records") && statement.includes("check_out_at IS NULL")) {
        return [state.active && !state.checkout ? [{ id: state.active.id }] : []];
      }
      if (statement.includes("DATE(check_out_at)=?")) {
        return [state.checkout || state.closed ? [{ id: 9 }] : []];
      }
      if (statement.includes("FROM organization_payroll_settings")) {
        return [[{ shift_start_time: "09:00:00", shift_end_time: "17:00:00" }]];
      }
      if (statement.includes("FROM attendance_records") && statement.includes("FOR UPDATE")) {
        return [state.correction ? [state.correction] : []];
      }
      if (statement.startsWith("INSERT INTO attendance_records")) {
        state.inserted = {
          check_in_at: params[2],
          check_out_at: null,
        };
        return [{ insertId: 9, affectedRows: 1 }];
      }
      if (statement.startsWith("UPDATE attendance_records")) {
        if (statement.includes("checkout_source='self'")) {
          if (state.checkout) return [{ affectedRows: 0 }];
          state.checkout = params[0];
          return [{ affectedRows: 1 }];
        }
        state.updated = {
          check_in_at: params[0],
          check_out_at: params[1],
          status: params[2],
          checkout_source: params[3],
          break_duration_minutes: params[4],
          worked_minutes: params[5],
          overtime_minutes: params[6],
        };
        return [{ affectedRows: 1 }];
      }
      return [{ affectedRows: 1 }];
    }),
  };
  pool.getConnection.mockResolvedValue(connection);
  return { state, connection };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-10T12:00:00.000Z"));
  process.env.ALLOW_LOOPBACK_ATTENDANCE = "true";
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.ALLOW_LOOPBACK_ATTENDANCE;
});

describe("self-service attendance validation", () => {
  it("creates a normal check-in transactionally", async () => {
    const { state, connection } = setup();
    const res = response();

    await checkIn(request(), res);

    expect(res.statusCode).toBe(201);
    expect(state.inserted.check_in_at).toBe("2026-11-10 17:00:00");
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.release).toHaveBeenCalledOnce();
  });

  it("rejects a duplicate active check-in", async () => {
    setup({ active: { id: 4, check_in_at: "2026-11-10 09:00:00" } });

    await expect(checkIn(request(), response())).rejects.toMatchObject({ statusCode: 409 });
  });

  it("checks out the active shift once and records actual duration", async () => {
    const { state, connection } = setup({ active: {
      id: 9,
      check_in_at: "2026-11-10 09:00:00",
      break_duration_minutes: 30,
    } });
    const res = response();

    await checkOut(request(), res);

    expect(res.body.data.record.status).toBe("checked_out");
    expect(state.checkout).toBe("2026-11-10 17:00:00");
    expect(connection.query.mock.calls.find(([sql]) => String(sql).includes("checkout_source='self'"))[1])
      .toEqual(["2026-11-10 17:00:00", "::1", 450, 0, 9]);
  });

  it("rejects checkout when there is no active check-in", async () => {
    setup();

    await expect(checkOut(request(), response())).rejects.toMatchObject({ statusCode: 404 });
  });

  it("rejects a second checkout after the active shift is already closed", async () => {
    setup({ closed: { id: 9 } });

    await expect(checkOut(request(), response())).rejects.toMatchObject({ statusCode: 409 });
  });

  it("rejects an invalid checkout timestamp that precedes the check-in", async () => {
    setup({ active: {
      id: 9,
      check_in_at: "2026-11-10 18:00:00",
      break_duration_minutes: 0,
    } });

    await expect(checkOut(request(), response())).rejects.toMatchObject({ statusCode: 409 });
  });

  it("prevents concurrent duplicate checkouts from overwriting one another", async () => {
    setup({ active: {
      id: 9,
      check_in_at: "2026-11-10 09:00:00",
      break_duration_minutes: 0,
    } });

    const results = await Promise.allSettled([
      checkOut(request(), response()),
      checkOut(request(), response()),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });
});

describe("admin attendance correction", () => {
  it("corrects checkout and records old/new values, actor, and reason", async () => {
    vi.setSystemTime(new Date("2026-11-10T13:00:00.000Z"));
    const previous = {
      id: 12,
      uuid: ATTENDANCE_UUID,
      employee_uuid: EMPLOYEE_UUID,
      organization_id: ORG_ID,
      date: "2026-11-10",
      check_in_at: "2026-11-10 09:00:00",
      check_out_at: null,
      break_duration_minutes: 30,
    };
    const { state } = setup({ correction: previous });
    const req = request({ check_in_time: "09:15", check_out_time: "17:15", reason: "Corrected from approved source" });
    req.user.org_role = "org_admin";
    req.params.uuid = ATTENDANCE_UUID;

    await correctAttendance(req, response());

    expect(state.updated).toMatchObject({
      check_in_at: "2026-11-10 09:15:00",
      check_out_at: "2026-11-10 17:15:00",
      status: "checked_out",
      checkout_source: "admin",
      break_duration_minutes: 30,
      worked_minutes: 450,
    });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "attendance.correct",
      entityId: ATTENDANCE_UUID,
      details: expect.objectContaining({
        old: {
          check_in_at: previous.check_in_at,
          check_out_at: null,
          break_duration_minutes: 30,
        },
        new: {
          check_in_at: "2026-11-10 09:15:00",
          check_out_at: "2026-11-10 17:15:00",
          break_duration_minutes: 30,
        },
        reason: "Corrected from approved source",
      }),
    }));
  });

  it("clears checkout and reopens the record for a valid later checkout", async () => {
    const previous = {
      id: 12,
      uuid: ATTENDANCE_UUID,
      employee_uuid: EMPLOYEE_UUID,
      organization_id: ORG_ID,
      date: "2026-11-10",
      check_in_at: "2026-11-10 09:00:00",
      check_out_at: "2026-11-10 16:00:00",
      break_duration_minutes: null,
    };
    const { state } = setup({ correction: previous });
    const req = request({ check_in_time: "09:00", check_out_time: "", reason: "Checkout was incorrect" });
    req.user.org_role = "org_admin";
    req.params.uuid = ATTENDANCE_UUID;

    await correctAttendance(req, response());

    expect(state.updated).toMatchObject({
      check_out_at: null,
      status: "checked_in",
      checkout_source: null,
      worked_minutes: null,
      overtime_minutes: null,
    });
  });
});

describe("missing attendance API", () => {
  it("allows an authorized missing-day entry beyond the normal backdate window only for a scheduled missing day", async () => {
    pool.query.mockImplementation(async (sql) => {
      const statement = String(sql);
      if (statement.includes("SELECT uuid, organization_id, linked_user_uuid")) {
        return [[{
          uuid: EMPLOYEE_UUID,
          organization_id: ORG_ID,
          linked_user_uuid: null,
          full_name: "Employee",
          status: "current_employee",
          joining_date: "2020-01-01",
        }]];
      }
      if (statement.includes("FROM organization_monthly_work_schedules s")) return [[{ eligible: 1 }]];
      if (statement.startsWith("INSERT INTO attendance_records")) return [{ affectedRows: 1 }];
      if (statement.includes("WHERE ar.employee_uuid=? AND ar.date=?")) {
        return [[{
          uuid: ATTENDANCE_UUID,
          employee_uuid: EMPLOYEE_UUID,
          organization_id: ORG_ID,
          date: "2026-10-01",
          check_in_at: "2026-10-01 09:00:00",
          check_out_at: null,
          status: "checked_in",
          is_manual: "yes",
          break_duration_minutes: 0,
        }]];
      }
      throw new Error(`Unexpected query: ${statement}`);
    });
    const req = request({
      employee_uuid: EMPLOYEE_UUID,
      date: "2026-10-01",
      check_in_time: "09:00",
      reason: "Approved missing attendance",
    });
    req.user.org_role = "org_admin";
    const res = response();

    await manualMissingEntry(req, res);

    expect(res.statusCode).toBe(201);
    expect(res.body.message).toBe("Manual attendance entry added");
    const missingCheck = pool.query.mock.calls.find(([sql]) => String(sql).includes("FROM organization_monthly_work_schedules s"))[0];
    expect(missingCheck).toContain("NOT EXISTS");
    expect(missingCheck).toContain("FROM attendance_records ar");
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "attendance.manual_entry",
      details: expect.objectContaining({ date: "2026-10-01" }),
    }));
  });

  it("rejects a historical missing-entry request unless the day is scheduled and still missing", async () => {
    pool.query.mockImplementation(async (sql) => {
      const statement = String(sql);
      if (statement.includes("SELECT uuid, organization_id, linked_user_uuid")) {
        return [[{
          uuid: EMPLOYEE_UUID,
          organization_id: ORG_ID,
          linked_user_uuid: null,
          full_name: "Employee",
          status: "current_employee",
          joining_date: "2020-01-01",
        }]];
      }
      if (statement.includes("FROM organization_monthly_work_schedules s")) return [[]];
      throw new Error(`Unexpected query: ${statement}`);
    });
    const req = request({
      employee_uuid: EMPLOYEE_UUID,
      date: "2026-10-01",
      check_in_time: "09:00",
      reason: "Approved missing attendance",
    });
    req.user.org_role = "org_admin";

    await expect(manualMissingEntry(req, response())).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("scheduled working day"),
    });
  });

  it("returns a conflict if another request inserts attendance after the missing-day check", async () => {
    pool.query.mockImplementation(async (sql) => {
      const statement = String(sql);
      if (statement.includes("SELECT uuid, organization_id, linked_user_uuid")) {
        return [[{
          uuid: EMPLOYEE_UUID,
          organization_id: ORG_ID,
          linked_user_uuid: null,
          full_name: "Employee",
          status: "current_employee",
          joining_date: "2020-01-01",
        }]];
      }
      if (statement.includes("FROM organization_monthly_work_schedules s")) return [[{ eligible: 1 }]];
      if (statement.startsWith("INSERT INTO attendance_records")) {
        const duplicate = new Error("Duplicate entry for employee/date");
        duplicate.code = "ER_DUP_ENTRY";
        throw duplicate;
      }
      throw new Error(`Unexpected query: ${statement}`);
    });
    const req = request({
      employee_uuid: EMPLOYEE_UUID,
      date: "2026-10-01",
      check_in_time: "09:00",
      reason: "Approved missing attendance",
    });
    req.user.org_role = "org_admin";

    await expect(manualMissingEntry(req, response())).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("already exists"),
    });
  });

  it("lists only scheduled working days with no existing record", async () => {
    setup();
    pool.query.mockImplementation(async (sql) => {
      const statement = String(sql);
      if (statement.includes("COUNT(*) AS total FROM organization_monthly_work_schedules")) {
        return [[{ total: 30 }]];
      }
      if (statement.includes("DATE_FORMAT(schedule_date")) {
        return [[{ work_date: "2026-11-09" }, { work_date: "2026-11-10" }]];
      }
      if (statement.includes("SELECT COUNT(*) AS total") && statement.includes("JOIN employees e")) {
        return [[{ total: 1 }]];
      }
      if (statement.includes("SELECT e.uuid AS employee_uuid")) {
        return [[{
          employee_uuid: EMPLOYEE_UUID,
          employee_name: "Employee",
          employee_email: "employee@example.com",
          date: "2026-11-09",
        }]];
      }
      return [{ affectedRows: 1 }];
    });
    const req = request();
    req.query = { month: "2026-11", page: "1", limit: "20" };
    const res = response();

    await listMissingAttendance(req, res);

    expect(res.body.data.items).toEqual([{
      employee_uuid: EMPLOYEE_UUID,
      employee_name: "Employee",
      employee_email: "employee@example.com",
      date: "2026-11-09",
    }]);
    const missingQuery = pool.query.mock.calls.find(([sql]) => String(sql).includes("SELECT e.uuid AS employee_uuid"))[0];
    expect(missingQuery).toContain("WHERE ar.id IS NULL");
    expect(missingQuery).toContain("NOT EXISTS");
    expect(missingQuery).not.toContain("manual-entry");
  });

  it("reports an incomplete monthly schedule instead of inventing missing days", async () => {
    setup();
    pool.query.mockResolvedValueOnce([[{ total: 29 }]]);
    const req = request();
    req.query = { month: "2026-11" };

    await expect(listMissingAttendance(req, response())).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("schedule is incomplete"),
    });
  });
});
