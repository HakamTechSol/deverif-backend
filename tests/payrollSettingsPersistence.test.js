import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config/db.js", () => ({ pool: { query: vi.fn() } }));

import { pool } from "../src/config/db.js";
import { getPayrollSettings, updatePayrollSettings } from "../src/controllers/salary.controller.js";

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

const savedSettings = {
  salary_calculation_method: "days",
  salary_calculation_policy: "working_days_only",
  calculate_overtime: 0,
  shift_start_time: "09:00:00",
  shift_end_time: "17:00:00",
  overtime_multiplier: "1.50",
  deduct_salary_for_late_arrivals: 1,
  late_arrival_threshold: 3,
  late_grace_minutes: 10,
};

describe("payroll late-arrival policy persistence", () => {
  beforeEach(() => pool.query.mockReset());

  it("fetches the saved monthly toggle and threshold", async () => {
    pool.query.mockResolvedValueOnce([[savedSettings]]);
    const res = response();

    await getPayrollSettings({
      scopeOrgId: 7,
      query: { month: "11", year: "2026" },
    }, res);

    expect(res.body.data.settings).toMatchObject({
      deduct_salary_for_late_arrivals: true,
      late_arrival_threshold: 3,
      late_grace_minutes: 10,
    });
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("deduct_salary_for_late_arrivals, late_arrival_threshold, late_grace_minutes"),
      [7, 11, 2026],
    );
  });

  it("saves the monthly toggle and threshold and returns the fetched settings", async () => {
    pool.query
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[savedSettings]]);
    const res = response();

    await updatePayrollSettings({
      scopeOrgId: 7,
      user: { uuid: "admin-uuid" },
      body: {
        month: 11,
        year: 2026,
        salary_calculation_method: "days",
        salary_calculation_policy: "working_days_only",
        calculate_overtime: false,
        shift_start_time: "09:00",
        shift_end_time: "17:00",
        overtime_multiplier: 1.5,
        deduct_salary_for_late_arrivals: true,
        late_arrival_threshold: 3,
        late_grace_minutes: 10,
      },
    }, res);

    expect(pool.query.mock.calls[0][0]).toContain("deduct_salary_for_late_arrivals, late_arrival_threshold, late_grace_minutes");
    expect(pool.query.mock.calls[0][1]).toEqual([
      7, 11, 2026, "days", "working_days_only", 0, "09:00", "17:00", 1.5, 1, 3, 10, "admin-uuid",
    ]);
    expect(res.body.data.settings).toMatchObject({
      deduct_salary_for_late_arrivals: true,
      late_arrival_threshold: 3,
      late_grace_minutes: 10,
    });
  });

  it("rejects a grace period outside the supported range", async () => {
    await expect(updatePayrollSettings({
      scopeOrgId: 7,
      user: { uuid: "admin-uuid" },
      body: {
        month: 11,
        year: 2026,
        salary_calculation_method: "days",
        calculate_overtime: false,
        shift_start_time: "09:00",
        shift_end_time: "17:00",
        overtime_multiplier: 1.5,
        late_grace_minutes: 181,
      },
    }, response())).rejects.toMatchObject({ statusCode: 400 });
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("persists the permanent organization default independently of month overrides", async () => {
    pool.query
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[{
        ...savedSettings,
        salary_calculation_method: "hours",
        salary_calculation_policy: "number_of_days_and_hours",
      }]]);
    const res = response();

    await updatePayrollSettings({
      scopeOrgId: 7,
      user: { uuid: "admin-uuid" },
      body: {
        scope: "organization",
        salary_calculation_policy: "number_of_days_and_hours",
        calculate_overtime: false,
        shift_start_time: "09:00",
        shift_end_time: "17:00",
        overtime_multiplier: 1.5,
      },
    }, res);

    expect(pool.query.mock.calls[0][0]).toContain("INSERT INTO organization_payroll_settings");
    expect(pool.query.mock.calls[0][0]).not.toContain("organization_monthly_payroll_settings");
    expect(pool.query.mock.calls[0][1]).toEqual([
      7, "hours", "number_of_days_and_hours", 0, "09:00", "17:00", 1.5, 0, 1, 10, "admin-uuid",
    ]);
    expect(pool.query.mock.calls[1][0]).toContain("FROM organization_payroll_settings");
    expect(res.body.data.settings.salary_calculation_policy).toBe("number_of_days_and_hours");
  });
});
