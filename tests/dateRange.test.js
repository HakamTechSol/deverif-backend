import { describe, it, expect, vi } from "vitest";
import {
  parseIsoDate,
  parseYearMonth,
  resolveDateRange,
  monthRange,
  MONTH_NAMES,
} from "../src/utils/dateRange.js";

describe("parseIsoDate", () => {
  it.each(["2026-01-01", "2026-12-31", "2024-02-29"])("accepts %s", (value) => {
    expect(parseIsoDate(value)).toBe(value);
  });

  it("accepts a Date instance", () => {
    expect(parseIsoDate(new Date(Date.UTC(2026, 0, 15)))).toBe("2026-01-15");
  });

  it.each([
    ["2026-13-01", "month 13"],
    ["2026-00-10", "month 0"],
    ["2026-02-30", "February 30th"],
    ["2026-04-31", "April 31st"],
    ["2025-02-29", "non-leap Feb 29"],
    ["2026-1-1", "unpadded"],
    ["26-01-01", "two-digit year"],
    ["not-a-date", "gibberish"],
    ["", "empty"],
  ])("rejects %s (%s)", (value) => {
    expect(() => parseIsoDate(value)).toThrow();
  });

  it("rejects an invalid Date", () => {
    expect(() => parseIsoDate(new Date("nope"))).toThrow();
  });
});

describe("parseYearMonth", () => {
  it("accepts YYYY-MM", () => {
    expect(parseYearMonth("2026-10")).toEqual({ year: 2026, month: 10 });
  });

  it.each(["2026-13", "2026-00", "2026-1", "2026/10", "nope"])("rejects %s", (value) => {
    expect(() => parseYearMonth(value)).toThrow();
  });
});

describe("resolveDateRange", () => {
  it("parses both bounds and counts days inclusively", () => {
    const range = resolveDateRange({ date_from: "2026-01-01", date_to: "2026-01-31" });
    expect(range).toEqual({ from: "2026-01-01", to: "2026-01-31", days: 31 });
  });

  it("accepts from/to aliases", () => {
    expect(resolveDateRange({ from: "2026-02-01", to: "2026-02-01" }).days).toBe(1);
  });

  it("treats a missing bound as an open range", () => {
    const open = resolveDateRange({ date_from: "2026-01-01" });
    expect(open).toEqual({ from: "2026-01-01", to: null, days: null });
  });

  it("rejects an inverted range", () => {
    expect(() => resolveDateRange({ date_from: "2026-02-01", date_to: "2026-01-01" })).toThrow(
      /cannot be after/
    );
  });

  it("throws rather than silently returning everything when both bounds are absent", () => {
    // A report that quietly ignores a malformed filter and returns ALL rows is
    // worse than one that refuses to run.
    expect(() => resolveDateRange({}, { allowOpen: false })).toThrow();
    expect(() => resolveDateRange({})).not.toThrow();
  });

  it("enforces maxDays", () => {
    expect(() =>
      resolveDateRange({ date_from: "2026-01-01", date_to: "2026-12-31" }, { maxDays: 90 })
    ).toThrow(/cannot exceed 90 days/);
    expect(() =>
      resolveDateRange({ date_from: "2026-01-01", date_to: "2026-01-31" }, { maxDays: 90 })
    ).not.toThrow();
  });

  it("spans a leap day correctly", () => {
    expect(resolveDateRange({ date_from: "2024-02-28", date_to: "2024-03-01" }).days).toBe(3);
  });

  it("does not apply maxDays to an open range", () => {
    expect(resolveDateRange({ date_from: "2020-01-01" }, { maxDays: 1 }).days).toBeNull();
  });
});

describe("monthRange", () => {
  it.each([
    [2026, 1, "2026-01-01", "2026-01-31"],
    [2026, 2, "2026-02-01", "2026-02-28"],
    [2024, 2, "2024-02-01", "2024-02-29"],
    [2026, 4, "2026-04-01", "2026-04-30"],
    [2026, 12, "2026-12-01", "2026-12-31"],
  ])("monthRange(%i, %i) spans the right days", (y, m, from, to) => {
    expect(monthRange(y, m)).toMatchObject({ from, to });
  });

  it.each([
    [2026, 13],
    [2026, 0],
    [1999, 1],
    [2101, 1],
  ])("rejects (%i, %i)", (y, m) => {
    expect(() => monthRange(y, m)).toThrow();
  });
});

describe("MONTH_NAMES", () => {
  it("has twelve entries", () => {
    expect(MONTH_NAMES).toHaveLength(12);
    expect(MONTH_NAMES[0]).toBe("January");
    expect(MONTH_NAMES[11]).toBe("December");
  });
});