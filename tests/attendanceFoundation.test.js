import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import {
  attendanceDurationForShift,
  attendanceMetrics,
  buildAttendanceRange,
  karachiDate,
  karachiDateTime,
  validAttendanceDate,
} from "../src/services/attendance.service.js";

describe("attendance foundation primitives", () => {
  afterEach(() => vi.useRealTimers());

  it("uses Asia/Karachi for the current date and wall-clock timestamp", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-09T19:30:00.000Z"));

    expect(karachiDate()).toBe("2026-11-10");
    expect(karachiDateTime()).toBe("2026-11-10 00:30:00");
  });

  it("validates real calendar dates", () => {
    expect(validAttendanceDate("2026-02-28")).toBe(true);
    expect(validAttendanceDate("2026-02-29")).toBe(false);
    expect(validAttendanceDate("2024-02-29")).toBe(true);
  });

  it("builds an overnight attendance range on the next local date", () => {
    expect(buildAttendanceRange("2026-11-10", "22:00", "06:00")).toEqual({
      checkInAt: "2026-11-10 22:00:00",
      checkOutAt: "2026-11-11 06:00:00",
    });
  });

  it("rejects equal check-in and checkout times", () => {
    expect(() => buildAttendanceRange("2026-11-10", "09:00", "09:00"))
      .toThrow("within 24 hours");
  });

  it("subtracts recorded breaks from actual elapsed minutes", () => {
    expect(attendanceMetrics({
      checkInAt: "2026-11-10 09:00:00",
      checkOutAt: "2026-11-10 17:00:00",
      breakDurationMinutes: 45,
      shiftDurationMinutes: 480,
    })).toEqual({
      elapsed_minutes: 480,
      worked_minutes: 435,
      regular_minutes: 435,
      overtime_minutes: 0,
    });
  });

  it("separates time beyond the shift duration as overtime", () => {
    expect(attendanceMetrics({
      checkInAt: "2026-11-10 09:00:00",
      checkOutAt: "2026-11-10 19:00:00",
      shiftDurationMinutes: 480,
    })).toMatchObject({
      elapsed_minutes: 600,
      worked_minutes: 600,
      regular_minutes: 480,
      overtime_minutes: 120,
    });
  });

  it("keeps a one-minute shift as one minute instead of granting a full day", () => {
    expect(attendanceMetrics({
      checkInAt: "2026-11-10 09:00:00",
      checkOutAt: "2026-11-10 09:01:00",
      shiftDurationMinutes: 480,
    })).toMatchObject({
      worked_minutes: 1,
      regular_minutes: 1,
      overtime_minutes: 0,
    });
  });

  it("does not classify a missing checkout as a completed or full day", () => {
    expect(attendanceMetrics({
      checkInAt: "2026-11-10 09:00:00",
      checkOutAt: null,
      shiftDurationMinutes: 480,
    })).toEqual({
      elapsed_minutes: null,
      worked_minutes: null,
      regular_minutes: null,
      overtime_minutes: null,
    });
  });

  it("rejects invalid durations and durations that exceed a full shift day", () => {
    expect(() => attendanceMetrics({
      checkInAt: "2026-11-10 09:00:00",
      checkOutAt: "2026-11-10 10:00:00",
      breakDurationMinutes: 61,
    })).toThrow("cannot exceed");
    expect(() => attendanceMetrics({
      checkInAt: "2026-11-10 09:00:00",
      checkOutAt: "2026-11-10 10:00:00",
      shiftDurationMinutes: 0,
    })).toThrow("positive whole number");
  });

  it("computes configured overnight shift duration without granting overtime", () => {
    expect(attendanceDurationForShift("22:00:00", "06:00:00")).toBe(480);
  });

  it("adds attendance metadata without deleting historical attendance rows", async () => {
    const migration = await readFile(
      new URL("../migrations/20261224_attendance_foundation.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain("information_schema.COLUMNS");
    expect(migration).toContain("checkout_source");
    expect(migration).toContain("break_duration_minutes");
    expect(migration).toContain("worked_minutes");
    expect(migration).toContain("overtime_minutes");
    expect(migration).not.toMatch(/\bDROP\s+(?:TABLE|COLUMN)\b/i);
    expect(migration).not.toMatch(/\bDELETE\s+FROM\s+attendance_records\b/i);
  });
});
