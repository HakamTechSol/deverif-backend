import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/config/db.js", () => ({ pool: { query: vi.fn(), getConnection: vi.fn() } }));

import { pool } from "../src/config/db.js";
import {
  getPayrollSettings,
  getMonthlyWorkSchedule,
  saveMonthlyWorkSchedule,
  updatePayrollSettings,
} from "../src/controllers/salary.controller.js";

function fakeResponse() {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
}

function monthDays(year, month, overrides = {}) {
  const total = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Array.from({ length: total }, (_, i) => {
    const date = `${year}-${String(month).padStart(2, "0")}-${String(i + 1).padStart(2, "0")}`;
    return { date, day_type: overrides[date] ?? "working" };
  });
}

/**
 * The monthly schedule editor is the only place an org can say "this Saturday
 * is a working day". It round-trips through MySQL's DATE type, which mysql2
 * hands back as a JS Date at LOCAL midnight. Serialising that Date to JSON
 * converts it to UTC, and east of Greenwich that lands on the previous day, so
 * a Saturday saved as working reappeared as an off Friday (and re-saving wrote
 * the shift back). The endpoint must therefore return a plain calendar date.
 */
describe("monthly work schedule dates", () => {
  beforeEach(() => pool.query.mockReset());

  it("returns dates as YYYY-MM-DD strings, not timezone-shifted instants", async () => {
    pool.query.mockResolvedValueOnce([
      [
        { schedule_date: new Date(2026, 10, 1), day_type: "off" },
        { schedule_date: new Date(2026, 10, 28), day_type: "working" },
      ],
    ]);
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    await getMonthlyWorkSchedule({ scopeOrgId: "org-1", query: { month: "11", year: "2026" } }, res);

    expect(res.json.mock.calls[0][0].data.days).toEqual([
      { schedule_date: "2026-11-01", day_type: "off" },
      { schedule_date: "2026-11-28", day_type: "working" },
    ]);
  });
});

/**
 * The save endpoint validated dates with /^\\d{4}-...$/ (a literal backslash,
 * not a digit), so every date was rejected with "Each schedule day needs a
 * valid date" and no schedule could ever be stored. HR could not make a
 * Saturday working even though the editor allowed it.
 */
describe("saving the monthly working schedule", () => {
  beforeEach(() => {
    pool.query.mockReset();
    pool.getConnection.mockReset();
  });

  it("accepts real calendar dates and any working/off mix, including a working Sunday", async () => {
    const conn = {
      beginTransaction: vi.fn(),
      query: vi.fn(),
      commit: vi.fn(),
      rollback: vi.fn(),
      release: vi.fn(),
    };
    pool.getConnection.mockResolvedValue(conn);
    pool.query.mockResolvedValueOnce([[]]); // read-back after the transaction
    // February 2027 starts on a Monday; a Friday/Saturday weekend is a valid
    // arrangement, and so is working the last Sunday.
    const days = monthDays(2027, 2, {
      "2027-02-05": "off",
      "2027-02-06": "off",
      "2027-02-28": "working",
    });

    await saveMonthlyWorkSchedule(
      {
        scopeOrgId: "org-1",
        user: { uuid: null },
        body: { month: 2, year: 2027, days },
        query: {},
      },
      fakeResponse(),
    );

    const inserted = conn.query.mock.calls.map((call) => call[1]);
    expect(inserted).toContainEqual(["org-1", "2027-02-28", "working", null]);
    expect(inserted).toContainEqual(["org-1", "2027-02-05", "off", null]);
    expect(conn.commit).toHaveBeenCalled();
  });
});

/** Same double-escaped regex broke shift timing: valid times were rejected. */
describe("saving payroll settings", () => {
  beforeEach(() => pool.query.mockReset());

  it("saves settings for the requested month and accepts valid shift times", async () => {
    pool.query
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([
        [
          {
            salary_calculation_method: "days",
            calculate_overtime: 0,
            shift_start_time: "09:00",
            shift_end_time: "17:00",
            overtime_multiplier: "1.50",
          },
        ],
      ]);

    const res = fakeResponse();
    await updatePayrollSettings(
      {
        scopeOrgId: "org-1",
        user: { uuid: null },
        body: {
          month: 11,
          year: 2026,
          salary_calculation_method: "days",
          calculate_overtime: false,
          shift_start_time: "09:00",
          shift_end_time: "17:00",
          overtime_multiplier: 1.5,
        },
      },
      res,
    );

    expect(res.json.mock.calls[0][0].success).toBe(true);
    expect(pool.query.mock.calls[0][0]).toContain("INSERT INTO organization_monthly_payroll_settings");
    expect(pool.query.mock.calls[0][1].slice(0, 3)).toEqual(["org-1", 11, 2026]);
  });

  it("loads the settings saved for the selected month", async () => {
    pool.query.mockResolvedValueOnce([[
      {
        salary_calculation_method: "hours",
        calculate_overtime: 1,
        shift_start_time: "08:00",
        shift_end_time: "16:00",
        overtime_multiplier: "2.00",
      },
    ]]);

    const res = fakeResponse();
    await getPayrollSettings(
      { scopeOrgId: "org-1", query: { month: "11", year: "2026" } },
      res,
    );

    expect(pool.query.mock.calls[0][1]).toEqual(["org-1", 11, 2026]);
    expect(res.json.mock.calls[0][0].data.settings).toMatchObject({
      salary_calculation_method: "hours",
      calculate_overtime: true,
      shift_start_time: "08:00",
    });
  });
});
