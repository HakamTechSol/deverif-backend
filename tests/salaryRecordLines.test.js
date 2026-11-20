import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config/db.js", () => ({ pool: { query: vi.fn() } }));

import { pool } from "../src/config/db.js";
import { listOrgSalaryRecords } from "../src/controllers/salary.controller.js";

describe("organization payroll record line items", () => {
  beforeEach(() => pool.query.mockReset());

  it("returns itemized lines grouped with each salary record", async () => {
    const records = [
      { uuid: "record-1", allowances: "1500.00" },
      { uuid: "record-2", allowances: "0.00" },
    ];
    const lines = [
      {
        salary_record_uuid: "record-1",
        label: "Attendance Bonus",
        type: "earning",
        source: "monthly_variable",
        amount: "1000.00",
      },
      {
        salary_record_uuid: "record-1",
        label: "Overtime",
        type: "earning",
        source: "manual_overtime",
        amount: "500.00",
      },
    ];
    pool.query
      .mockResolvedValueOnce([[{ total: 2 }]])
      .mockResolvedValueOnce([records])
      .mockResolvedValueOnce([lines]);

    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
    await listOrgSalaryRecords(
      { scopeOrgId: 7, query: { page: "1", limit: "10" } },
      res,
    );

    expect(pool.query.mock.calls[2][1]).toEqual([["record-1", "record-2"]]);
    expect(res.json.mock.calls[0][0].data.items).toEqual([
      { ...records[0], lines },
      { ...records[1], lines: [] },
    ]);
  });
});
