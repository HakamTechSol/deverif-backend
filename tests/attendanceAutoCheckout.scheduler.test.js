import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config/db.js", () => ({ pool: { query: vi.fn() } }));

import { pool } from "../src/config/db.js";
import { autoCheckoutOpenAttendance } from "../src/services/attendanceAutoCheckout.scheduler.js";

describe("attendance auto-checkout scheduler", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => vi.useRealTimers());

  it("checks out at the configured shift end, marks the source, and preserves closed rows", async () => {
    vi.setSystemTime(new Date("2026-11-10T12:05:00.000Z"));
    pool.query
      .mockResolvedValueOnce([[{
        id: 8,
        date: "2026-11-10",
        check_in_at: "2026-11-10 09:00:00",
        break_duration_minutes: 30,
        shift_start_time: "09:00:00",
        shift_end_time: "17:00:00",
      }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    await expect(autoCheckoutOpenAttendance()).resolves.toBe(1);

    expect(pool.query.mock.calls[0][0]).toContain("JOIN organization_payroll_settings");
    expect(pool.query.mock.calls[0][0]).toContain("ar.check_out_at IS NULL");
    expect(pool.query.mock.calls[1][0]).toContain("checkout_source='auto'");
    expect(pool.query.mock.calls[1][0]).toContain("check_out_at IS NULL AND status='checked_in'");
    expect(pool.query.mock.calls[1][1]).toEqual(["2026-11-10 17:00:00", 450, 0, 8]);
  });

  it("does not check out before shift end", async () => {
    vi.setSystemTime(new Date("2026-11-10T11:00:00.000Z"));
    pool.query.mockResolvedValueOnce([[{
      id: 8,
      date: "2026-11-10",
      check_in_at: "2026-11-10 09:00:00",
      shift_start_time: "09:00:00",
      shift_end_time: "17:00:00",
    }]]);

    await expect(autoCheckoutOpenAttendance()).resolves.toBe(0);
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it("supports a shift that checks out the next calendar day", async () => {
    vi.setSystemTime(new Date("2026-11-11T01:05:00.000Z"));
    pool.query
      .mockResolvedValueOnce([[{
        id: 9,
        date: "2026-11-10",
        check_in_at: "2026-11-10 22:00:00",
        shift_start_time: "22:00:00",
        shift_end_time: "06:00:00",
      }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    await expect(autoCheckoutOpenAttendance()).resolves.toBe(1);
    expect(pool.query.mock.calls[1][1][0]).toBe("2026-11-11 06:00:00");
    expect(pool.query.mock.calls[1][0]).toContain("checkout_source='auto'");
  });
});
