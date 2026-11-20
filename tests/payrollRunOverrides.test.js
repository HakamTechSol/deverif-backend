import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config/db.js", () => ({
  pool: { query: vi.fn(), getConnection: vi.fn() },
}));

vi.mock("../src/services/expenses.service.js", () => ({
  getApprovedClaimsForPeriod: vi.fn().mockResolvedValue([]),
  expenseReimbursementLine: vi.fn().mockReturnValue(null),
  markClaimsPaidByPayroll: vi.fn().mockResolvedValue(undefined),
  assertNoExpensePaymentsForSalaryRecords: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/services/notificationEmail.service.js", () => ({
  queueNotificationEmail: vi.fn(),
  notificationActionUrl: vi.fn(),
}));

vi.mock("../src/utils/auditLog.js", () => ({
  logAudit: vi.fn(),
  getActorFromReq: vi.fn(() => ({})),
}));

vi.mock("../src/services/payroll.service.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    proratedBasicForMonth: vi.fn().mockResolvedValue(30000),
    getMonthlyAttendanceAndLeaveSummary: vi.fn(),
    insertSalaryRecordLines: vi.fn().mockResolvedValue(undefined),
  };
});

import { pool } from "../src/config/db.js";
import * as payrollService from "../src/services/payroll.service.js";
import { generatePayroll, previewPayroll } from "../src/controllers/salary.controller.js";

const employee = {
  uuid: "47e59274-184c-44f0-98c4-a681f6b2cf22",
  full_name: "Run Local Employee",
  joining_date: "2020-01-01",
};
const settings = {
  salary_calculation_method: "hours",
  salary_calculation_policy: "working_days_and_hours",
  calculate_overtime: true,
  shift_start_time: "10:00",
  shift_end_time: "18:00",
  overtime_multiplier: 2,
  deduct_salary_for_late_arrivals: true,
  late_arrival_threshold: 4,
  late_grace_minutes: 10,
};
let monthlyOvertimeAmount = "0.00";
const days = Array.from({ length: 30 }, (_, index) => {
  const date = `2026-11-${String(index + 1).padStart(2, "0")}`;
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return {
    date,
    day_type: date === "2026-11-10" || weekday === 0 || weekday === 6 ? "off" : "working",
  };
});

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

function request(body) {
  return {
    scopeOrgId: 7,
    user: { id: 11 },
    body: { month: 11, year: 2026, employee_uuids: [employee.uuid], ...body },
  };
}

describe("run-local payroll overrides", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    monthlyOvertimeAmount = "0.00";
    payrollService.proratedBasicForMonth.mockResolvedValue(30000);
    payrollService.getMonthlyAttendanceAndLeaveSummary.mockImplementation(async ({ policy, scheduleOverride }) => {
      const workingDays = scheduleOverride.filter((day) => day.day_type === "working").length;
      return {
        policy,
        workingDays,
        elapsedWorkingDays: workingDays,
        attendedDays: workingDays,
        workedHours: workingDays * 8,
        absentDays: 0,
        paidLeaveDays: 0,
        unpaidLeaveDays: 0,
        approvedOvertimeHours: 2,
        actualOvertimeHours: 2,
        requestedOvertimeHours: 2,
        overtimeRequests: 1,
        lateCount: 0,
        holidayCount: 0,
      };
    });
    pool.query.mockImplementation(async (sql) => {
      if (sql.includes("FROM employees") && sql.includes("ORDER BY full_name")) return [[employee]];
      if (sql.includes("FROM employee_salary_components")) return [[]];
      if (sql.includes("FROM monthly_salary_variables")) return [[]];
      if (sql.includes("FROM payroll_employee_overtime")) return [[{ overtime_amount: monthlyOvertimeAmount }]];
      if (sql.includes("FROM salary_records sr")) {
        return [[{ uuid: "record-uuid", employee_uuid: employee.uuid, employee_user_uuid: null }]];
      }
      if (sql.includes("FROM users")) return [[]];
      throw new Error(`Unexpected pool query: ${sql}`);
    });
  });

  it("uses the supplied settings and schedule for preview without reading organization defaults", async () => {
    const res = response();
    await previewPayroll(request({ settings, days }), res);

    expect(res.statusCode).toBe(200);
    expect(payrollService.getMonthlyAttendanceAndLeaveSummary).toHaveBeenCalledWith(
      expect.objectContaining({ policy: expect.objectContaining(settings), scheduleOverride: days }),
    );
    const item = res.body.data.items[0];
    expect(item.attendance.working_days).toBe(days.filter((day) => day.day_type === "working").length);
    expect(item.rates.salary_calculation_method).toBe("hours");
    expect(item.lines.some((line) => line.source === "auto_overtime")).toBe(false);
    expect(item.attendance.approved_overtime_hours).toBe(2);
    expect(pool.query.mock.calls.some(([sql]) =>
      sql.includes("organization_payroll_settings") || sql.includes("organization_monthly_work_schedules"),
    )).toBe(false);
  });

  it("adds the saved monthly overtime amount as a separate earning", async () => {
    monthlyOvertimeAmount = "2000.00";
    const res = response();
    await previewPayroll(request({ settings, days }), res);

    const item = res.body.data.items[0];
    const overtimeLine = item.lines.find((line) => line.source === "manual_overtime");
    expect(overtimeLine).toMatchObject({
      label: "Overtime",
      type: "earning",
      amount: 2000,
      basis_value: null,
      basis_unit: null,
    });
    expect(item.lines.some((line) => line.source === "auto_overtime")).toBe(false);
    expect(item.allowances).toBe(2000);
    expect(item.net_salary).toBe(32000);
  });

  it("uses unsaved overtime inputs in preview without writing them", async () => {
    monthlyOvertimeAmount = "2000.00";
    const res = response();
    await previewPayroll(request({
      settings,
      days,
      overtime_amounts: { [employee.uuid]: 3500 },
    }), res);

    expect(res.body.data.items[0].lines.find((line) => line.source === "manual_overtime").amount).toBe(3500);
    expect(pool.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO payroll_employee_overtime"))).toBe(false);
  });

  it("rejects a component selection that is not assigned to the payroll employee", async () => {
    await expect(previewPayroll(request({
      settings,
      days,
      component_selections: {
        [employee.uuid]: {
          allowance_uuids: ["d42b99cc-4874-4aeb-855d-51b03e7e5ed1"],
          deduction_uuids: [],
        },
      },
    }), response())).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("active assignments"),
    });
  });

  it("uses the run-local calendar without querying the organization's saved schedule", async () => {
    const calendar = await payrollService.getWorkingDaysForMonth({
      orgId: 7,
      month: 11,
      year: 2026,
      scheduleOverride: days,
    });

    expect(calendar.workingDays).toBe(days.filter((day) => day.day_type === "working").length);
    expect(calendar.nonWorkingDates.has("2026-11-10")).toBe(true);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("generates with the same overrides and persists both snapshots without changing organization settings", async () => {
    monthlyOvertimeAmount = "2000.00";
    const previewRes = response();
    await previewPayroll(request({
      settings,
      days,
      overtime_amounts: { [employee.uuid]: 3500 },
    }), previewRes);
    const previewOvertimeAmount = previewRes.body.data.items[0].lines
      .find((line) => line.source === "manual_overtime").amount;
    const inserted = [];
    const savedOvertime = [];
    let hasPreviousPayroll = false;
    const conn = {
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
      query: vi.fn(async (sql, params) => {
        if (sql.includes("SELECT uuid, joining_date FROM employees")) return [[employee]];
        if (sql.includes("SELECT uuid, employee_uuid FROM salary_records")) {
          return [hasPreviousPayroll ? [{ uuid: "record-uuid", employee_uuid: employee.uuid }] : []];
        }
        if (sql.includes("SELECT l.salary_record_uuid")) return [[]];
        if (sql.includes("DELETE FROM salary_records")) return [{ affectedRows: 1 }];
        if (sql.includes("SELECT employee_uuid FROM salary_records")) return [[]];
        if (sql.includes("FROM employee_salary_components")) return [[]];
        if (sql.includes("FROM monthly_salary_variables")) return [[]];
        if (sql.includes("FROM payroll_employee_overtime")) return [[{ overtime_amount: monthlyOvertimeAmount }]];
        if (sql.includes("INSERT INTO payroll_employee_overtime")) {
          savedOvertime.push({ sql, params });
          return [{ affectedRows: 1 }];
        }
        if (sql.includes("INSERT INTO salary_records")) {
          inserted.push({ sql, params });
          hasPreviousPayroll = true;
          return [{ insertId: 1 }];
        }
        throw new Error(`Unexpected connection query: ${sql}`);
      }),
    };
    pool.getConnection.mockResolvedValue(conn);

    const res = response();
    await generatePayroll(request({
      settings,
      days,
      overtime_amounts: { [employee.uuid]: 3500 },
    }), res);

    expect(res.statusCode).toBe(200);
    expect(payrollService.getMonthlyAttendanceAndLeaveSummary).toHaveBeenCalledWith(
      expect.objectContaining({ policy: expect.objectContaining(settings), scheduleOverride: days }),
    );
    expect(inserted).toHaveLength(1);
    expect(inserted[0].sql).toContain("payroll_policy_snapshot");
    expect(inserted[0].sql).toContain("payroll_schedule_snapshot");
    expect(savedOvertime[0].params).toEqual([7, employee.uuid, 11, 2026, 3500, null]);
    expect(JSON.parse(inserted[0].params[10])).toEqual(settings);
    expect(JSON.parse(inserted[0].params[11])).toEqual(days);
    expect(payrollService.insertSalaryRecordLines.mock.calls[0][0].lines
      .some((line) => line.source === "auto_overtime")).toBe(false);
    expect(payrollService.insertSalaryRecordLines.mock.calls[0][0].lines
      .find((line) => line.source === "manual_overtime").amount).toBe(previewOvertimeAmount);

    const regeneratedSettings = {
      salary_calculation_method: "days",
      salary_calculation_policy: "working_days_only",
      calculate_overtime: false,
      shift_start_time: "09:00",
      shift_end_time: "17:00",
      overtime_multiplier: 1.5,
      deduct_salary_for_late_arrivals: false,
      late_arrival_threshold: 1,
      late_grace_minutes: 10,
    };
    const regeneratedDays = days.map((day) => ({
      ...day,
      day_type: day.date === "2026-11-10" ? "working" : day.day_type,
    }));
    await generatePayroll(request({
      settings: regeneratedSettings,
      days: regeneratedDays,
      regenerate: true,
    }), response());

    expect(inserted).toHaveLength(2);
    expect(JSON.parse(inserted[1].params[10])).toEqual(regeneratedSettings);
    expect(JSON.parse(inserted[1].params[11])).toEqual(regeneratedDays);
    expect(payrollService.getMonthlyAttendanceAndLeaveSummary).toHaveBeenLastCalledWith(
      expect.objectContaining({ policy: expect.objectContaining(regeneratedSettings), scheduleOverride: regeneratedDays }),
    );
    expect(conn.query.mock.calls.some(([sql]) =>
      sql.includes("organization_payroll_settings") || sql.includes("organization_monthly_work_schedules"),
    )).toBe(false);
  });

  it("rejects an incomplete or duplicated run-local schedule", async () => {
    const incomplete = days.slice(1);
    await expect(previewPayroll(request({ settings, days: incomplete }), response()))
      .rejects.toMatchObject({ statusCode: 400 });

    const duplicate = [...days.slice(0, -1), days[0]];
    await expect(previewPayroll(request({ settings, days: duplicate }), response()))
      .rejects.toMatchObject({ statusCode: 400 });

    await expect(previewPayroll(request({
      settings: { ...settings, overtime_multiplier: 6 },
      days,
    }), response())).rejects.toMatchObject({ statusCode: 400 });
  });
});
