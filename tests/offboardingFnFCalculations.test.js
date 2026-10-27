import { describe, it, expect, vi } from "vitest";
import { calculateSettlement } from "../src/services/offboarding.service.js";

const VALID_EXIT_UUID = "00000000-0000-4000-a000-000000000001";
const VALID_EMP_UUID = "00000000-0000-4000-a000-000000000002";

describe("Offboarding FnF Calculations (Items 15 & 16)", () => {
  it("differentiates resignation notice recovery vs termination notice pay", async () => {
    // Mock DB queries for termination
    const fakeDbTermination = {
      query: vi.fn().mockImplementation((sql, params) => {
        if (sql.includes("FROM exit_requests")) {
          return Promise.resolve([
            [
              {
                uuid: VALID_EXIT_UUID,
                employee_uuid: VALID_EMP_UUID,
                employee_name: "John Doe",
                request_type: "termination",
                last_working_day: "2026-11-15",
                notice_period_days: 30,
                created_at: "2026-11-01",
                organization_id: 1,
              },
            ],
          ]);
        }
        if (sql.includes("employee_salary_history")) {
          return Promise.resolve([[{ basic_salary: "60000.00" }]]);
        }
        if (sql.includes("holidays")) {
          return Promise.resolve([[]]);
        }
        if (sql.includes("work_week_config")) {
          return Promise.resolve([[{ mon: 1, tue: 1, wed: 1, thu: 1, fri: 1, sat: 0, sun: 0 }]]);
        }
        if (sql.includes("employee_leave_allocations")) {
          return Promise.resolve([[]]);
        }
        if (sql.includes("asset_assignments")) {
          return Promise.resolve([[]]);
        }
        return Promise.resolve([[]]);
      }),
    };

    const calc = await calculateSettlement({ orgId: 1, exitUuid: VALID_EXIT_UUID, conn: fakeDbTermination });
    expect(calc.notice.recovery).toBe(0);
    expect(calc.notice.adjustment).toBe(0);
    expect(calc.worked_days_salary.worked_days).toBeGreaterThan(0);
    expect(calc.worked_days_salary.amount).toBeGreaterThan(0);
  });
});
