import { describe, expect, it } from "vitest";
import { computeAutomaticLines } from "../src/services/payroll.service.js";

const policy = {
  daily_rate_basis: "actual_working_days",
  hours_per_workday: 8,
  late_arrivals_per_penalty: 3,
  late_penalty_days: 0.5,
  overtime_multiplier: 1.5,
  deduct_unpaid_leave: 1,
  deduct_absences: 1,
  deduct_late_arrivals: 1,
  pay_approved_overtime: 1,
};

function calc(overrides = {}) {
  const summary = {
    workingDays: 20,
    calendarDays: 30,
    unpaidLeaveDays: 2,
    absentDays: 1,
    lateCount: 3,
    approvedOvertimeHours: 4,
    policy,
    ...overrides,
  };
  return computeAutomaticLines({ summary, basicSalary: 30000, policy: summary.policy });
}

describe("configured payroll policy calculation", () => {
  it("prices only unpaid leave and absences using the selected divisor", () => {
    const result = calc();
    expect(result.perDayRate).toBe(1500);
    expect(result.lines.find((line) => line.source === "auto_unpaid_leave")?.amount).toBe(3000);
    expect(result.lines.find((line) => line.source === "auto_absenteeism")?.amount).toBe(1500);
    expect(result.lines.find((line) => line.source === "auto_late")?.amount).toBe(750);
    expect(result.lines.find((line) => line.source === "auto_overtime")?.amount).toBe(1125);
  });

  it("does not invent attendance deductions or overtime when policy disables them", () => {
    const result = calc({ policy: { ...policy, deduct_unpaid_leave: 0, deduct_absences: 0, deduct_late_arrivals: 0, pay_approved_overtime: 0 } });
    expect(result.lines).toEqual([]);
  });

  it("uses an explicitly selected divisor", () => {
    const result = calc({ policy: { ...policy, daily_rate_basis: "calendar_days" } });
    expect(result.perDayRate).toBe(1000);
    expect(result.divisor).toBe(30);
  });

  it("reports a blocker instead of converting a missing salary to zero payroll", () => {
    const result = calc({});
    const missing = computeAutomaticLines({ summary: result ? { workingDays: 20, policy } : {}, basicSalary: null, policy });
    expect(missing.skipReason).toBe("no_basic_salary");
    expect(missing.lines).toEqual([]);
  });
});
