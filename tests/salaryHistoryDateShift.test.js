import { describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => ({ conn: { query: vi.fn() } }));

vi.mock("../src/config/db.js", () => ({
  pool: { query: vi.fn() },
}));

import { pool } from "../src/config/db.js";
import { listEmployeeSalaryHistory } from "../src/controllers/org/salaryHistory.controller.js";
import { isoDate } from "../src/utils/leaveBalance.js";

/**
 * THE OFF-BY-ONE-DAY DATE BUG, AND WHY IT IS WORTH A TEST.
 *
 * The pool is created without `dateStrings`, so mysql2 hands a MySQL DATE back
 * as a JS Date built at LOCAL midnight. On this server (UTC+5) a stored
 * 2026-10-01 arrives as 2026-09-30T19:00:00Z. Serialise that and the client sees
 * the 30th.
 *
 * This was LIVE, in this endpoint, for the whole Effective Period column. It is
 * the kind of bug that never throws: every row renders, every row is internally
 * consistent, and the only symptom is that every salary change appears to have
 * taken effect one day before it did. A recruiter comparing two adjacent history
 * rows to see when a raise landed reads the wrong day on both.
 *
 * `isoDate` is the correction the rest of the codebase already carries
 * (payroll.service.js, leaveBalance.js). These tests pin both that the helper is
 * right and that the endpoint actually applies it.
 */

const ORG_SCOPED_REQ = {
  params: { uuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
  scopeOrgId: 42,
  user: { uuid: "admin-1" },
};

/** The Date mysql2 would build for a stored 2026-10-01 on a UTC+5 server. */
function localMidnightDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

describe("isoDate — the local-field correction", () => {
  it("reads the calendar fields mysql2 put the DATE in, not the UTC instant", () => {
    // A local-midnight Date: locally the 1st, in UTC an instant on the 30th.
    const d = localMidnightDate("2026-10-01");
    expect(isoDate(d)).toBe("2026-10-01");
    // What the bug read instead:
    expect(d.toISOString().slice(0, 10)).toBe("2026-09-30");
  });

  it("round-trips a YYYY-MM-DD string unchanged", () => {
    // Strings already in the right shape are untouched, so anything that arrives
    // pre-normalised (or that never went through mysql2) is not mangled.
    expect(isoDate("2026-10-01")).toBe("2026-10-01");
  });
});

describe("listEmployeeSalaryHistory — effective dates reach the client as YYYY-MM-DD", () => {
  it("returns dates as plain strings, so a client cannot shift them a day", async () => {
    pool.query
      .mockResolvedValueOnce([[{ uuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", full_name: "Ayesha" }]])
      .mockResolvedValueOnce([
        [
          { uuid: "h-1", year: 2026, basic_salary: "60000.00", effective_from: localMidnightDate("2026-10-01"), effective_to: null, created_at: null },
          { uuid: "h-2", year: 2026, basic_salary: "50000.00", effective_from: localMidnightDate("2026-06-15"), effective_to: localMidnightDate("2026-09-30"), created_at: null },
        ],
      ]);

    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
    await listEmployeeSalaryHistory(ORG_SCOPED_REQ, res);

    const body = res.json.mock.calls[0][0];
    const rows = body.data.history;

    // THE FIX. Not a Date, and not a shifted one. The open period reads as the
    // 1st of October because that is the day it was stored as.
    expect(rows[0].effective_from).toBe("2026-10-01");
    expect(rows[0].effective_to).toBeNull();

    // A CLOSED period keeps both boundaries, and the closing date is the day
    // before the next opening WITHOUT a UTC round-trip - dayBefore() already
    // writes 2026-09-30, and reading it back must not make it the 29th.
    expect(rows[1].effective_from).toBe("2026-06-15");
    expect(rows[1].effective_to).toBe("2026-09-30");
  });

  it("keeps the rows in the same order and with the same money", async () => {
    // Normalisation is a shape change only. Order, salary and uuid must be
    // untouched, or the fix would quietly reorder the history it is meant to
    // display.
    pool.query
      .mockResolvedValueOnce([[{ uuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", full_name: "Ayesha" }]])
      .mockResolvedValueOnce([
        [
          { uuid: "h-old", year: 2025, basic_salary: "42000.00", effective_from: localMidnightDate("2025-03-01"), effective_to: localMidnightDate("2025-12-31"), created_at: null },
          { uuid: "h-new", year: 2026, basic_salary: "60000.00", effective_from: localMidnightDate("2026-01-01"), effective_to: null, created_at: null },
        ],
      ]);

    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
    await listEmployeeSalaryHistory(ORG_SCOPED_REQ, res);
    const rows = res.json.mock.calls[0][0].data.history;

    expect(rows.map((r) => r.uuid)).toEqual(["h-old", "h-new"]);
    expect(rows.map((r) => r.basic_salary)).toEqual(["42000.00", "60000.00"]);
  });
});
