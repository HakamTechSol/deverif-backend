import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config/db.js", () => ({ pool: { query: vi.fn() } }));

import { pool } from "../src/config/db.js";
import { getAttendanceForMonth } from "../src/services/payroll.service.js";

describe("payroll late grace period", () => {
  beforeEach(() => pool.query.mockReset());

  it("counts arrivals after shift start plus grace, not at the grace boundary", async () => {
    const dates = ["2026-10-01", "2026-10-02", "2026-10-05"];
    pool.query.mockResolvedValueOnce([dates.map((date, index) => ({
      date,
      check_in_at: new Date(2026, 9, [1, 2, 5][index], 9, [0, 10, 11][index]),
      check_out_at: new Date(2026, 9, [1, 2, 5][index], 17, 0),
    }))]);

    const attendance = await getAttendanceForMonth({
      employeeUuid: "47e59274-184c-44f0-98c4-a681f6b2cf22",
      month: 10,
      year: 2026,
      workingDates: dates,
      lateCutoffMinutes: 9 * 60 + 10,
    });

    expect(attendance.lateCount).toBe(1);
    expect(pool.query.mock.calls[0][1]).toEqual([
      "47e59274-184c-44f0-98c4-a681f6b2cf22",
      "2026-10-01",
      "2026-10-31",
    ]);
  });
});
