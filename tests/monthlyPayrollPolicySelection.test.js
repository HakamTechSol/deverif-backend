import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config/db.js", () => ({ pool: { query: vi.fn() } }));

import { pool } from "../src/config/db.js";
import { getPayrollSettings } from "../src/services/payroll.service.js";

describe("monthly payroll policy selection", () => {
  beforeEach(() => pool.query.mockReset());

  it("uses the policy saved for the selected organization month", async () => {
    pool.query.mockResolvedValueOnce([[
      {
        salary_calculation_method: "hours",
        salary_calculation_policy: "number_of_days_and_hours",
        calculate_overtime: 1,
        shift_start_time: "08:00:00",
        shift_end_time: "16:00:00",
        overtime_multiplier: "2.00",
      },
    ]]);

    const settings = await getPayrollSettings(7, pool, 11, 2026);

    expect(pool.query).toHaveBeenCalledWith(
      "SELECT * FROM organization_monthly_payroll_settings WHERE organization_id=? AND month=? AND year=?",
      [7, 11, 2026],
    );
    expect(settings).toMatchObject({
      salary_calculation_method: "hours",
      salary_calculation_policy: "number_of_days_and_hours",
      calculate_overtime: 1,
      overtime_multiplier: "2.00",
      hours_per_workday: 8,
    });
  });

  it("falls back to legacy organization settings when no monthly policy is saved", async () => {
    pool.query
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[
        {
          salary_calculation_method: "days",
          calculate_overtime: 0,
          shift_start_time: "09:00:00",
          shift_end_time: "17:00:00",
          overtime_multiplier: "1.50",
        },
      ]]);

    const settings = await getPayrollSettings(7, pool, 11, 2026);

    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      "SELECT * FROM organization_payroll_settings WHERE organization_id=?",
      [7],
    );
    expect(settings.salary_calculation_method).toBe("days");
    expect(settings.salary_calculation_policy).toBe("working_days_only");
  });

  it("uses a monthly policy override without changing the saved organization default", async () => {
    pool.query
      .mockResolvedValueOnce([[{
        salary_calculation_method: "days",
        salary_calculation_policy: "number_of_days_only",
        shift_start_time: "09:00:00",
        shift_end_time: "17:00:00",
      }]])
      .mockResolvedValueOnce([[{
        salary_calculation_method: "hours",
        salary_calculation_policy: "working_days_and_hours",
        shift_start_time: "08:00:00",
        shift_end_time: "16:00:00",
      }]]);

    const monthly = await getPayrollSettings(7, pool, 11, 2026);
    const organizationDefault = await getPayrollSettings(7, pool);

    expect(monthly.salary_calculation_policy).toBe("number_of_days_only");
    expect(organizationDefault.salary_calculation_policy).toBe("working_days_and_hours");
    expect(pool.query).toHaveBeenLastCalledWith(
      "SELECT * FROM organization_payroll_settings WHERE organization_id=?",
      [7],
    );
  });
});
