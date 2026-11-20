import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config/db.js", () => ({ pool: { query: vi.fn() } }));

import { pool } from "../src/config/db.js";
import {
  calculatePayrollAmounts,
  computeAutomaticLines,
  getWorkingDaysForMonth,
} from "../src/services/payroll.service.js";

const assignmentUuids = {
  fixedAllowance: "d42b99cc-4874-4aeb-855d-51b03e7e5ed1",
  percentAllowance: "61e66edf-1860-4400-9340-1537c5e0b9a1",
  fixedDeduction: "9f1fb123-a201-4cb0-889d-f9b78c46fc37",
  percentDeduction: "a2a3c4b8-471c-4c38-99fb-bc5552280843",
};

const components = [
  { assignment_uuid: assignmentUuids.fixedAllowance, name: "Transport", type: "allowance", is_percentage: 0, amount: "500.00" },
  { assignment_uuid: assignmentUuids.percentAllowance, name: "Housing", type: "allowance", is_percentage: 1, amount: "10.00" },
  { assignment_uuid: assignmentUuids.fixedDeduction, name: "Loan", type: "deduction", is_percentage: 0, amount: "300.00" },
  { assignment_uuid: assignmentUuids.percentDeduction, name: "Tax", type: "deduction", is_percentage: 1, amount: "5.00" },
];

function summary(calendarDays, policy = "working_days_only") {
  const hoursBased = policy.endsWith("_hours");
  return {
    workingDays: 22,
    monthWorkingDays: 22,
    calendarDays,
    elapsedWorkingDays: 22,
    attendedDays: 20,
    paidLeaveDays: 0,
    unpaidLeaveDays: 1,
    absentDays: 1,
    lateCount: 0,
    workedHours: 160,
    approvedOvertimeHours: 0,
    policy: {
      salary_calculation_policy: policy,
      salary_calculation_method: hoursBased ? "hours" : "days",
      calculate_overtime: false,
      hours_per_workday: 8,
      overtime_multiplier: 1.5,
    },
  };
}

describe("four-policy payroll calculation foundation", () => {
  beforeEach(() => pool.query.mockReset());

  it.each([
    [1, 2026, 31],
    [4, 2026, 30],
    [2, 2025, 28],
    [2, 2024, 29],
  ])("uses the complete %i/%i calendar month (%i days)", (month, year, calendarDays) => {
    const actualCalendarDays = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const result = computeAutomaticLines({
      summary: summary(actualCalendarDays, "number_of_days_only"),
      basicSalary: 31000,
    });

    expect(actualCalendarDays).toBe(calendarDays);
    expect(result.divisor).toBe(calendarDays);
    expect(result.perDayRate).toBe(Math.round((31000 / calendarDays) * 100) / 100);
  });

  it.each([
    ["working_days_only", 22, "days", 1409.09, 2818.18],
    ["working_days_and_hours", 176, "hours", 1409.09, 2818.24],
    ["number_of_days_only", 31, "days", 1000, 2000],
    ["number_of_days_and_hours", 248, "hours", 1000, 2000],
  ])("calculates %s with its prescribed salary denominator and attendance basis", (policy, divisor, basis, dailyRate, deductions) => {
    const result = computeAutomaticLines({ summary: summary(31, policy), basicSalary: 31000 });

    expect(result.payrollPolicy).toBe(policy);
    expect(result.divisor).toBe(divisor);
    expect(result.perDayRate).toBe(dailyRate);
    expect(result.method).toBe(basis);
    expect(result.totalDeduction).toBe(deductions);
  });

  it("includes a checked fixed allowance and excludes an unchecked assigned allowance", () => {
    const checked = calculatePayrollAmounts({
      basicSalary: 10000,
      components,
      selectedComponentUuids: [assignmentUuids.fixedAllowance],
    });
    const unchecked = calculatePayrollAmounts({
      basicSalary: 10000,
      components,
      selectedComponentUuids: [],
    });

    expect(checked.allowances).toBe(500);
    expect(checked.net).toBe(10500);
    expect(unchecked.allowances).toBe(0);
    expect(unchecked.net).toBe(10000);
  });

  it("includes a checked fixed deduction and excludes an unchecked assigned deduction", () => {
    const checked = calculatePayrollAmounts({
      basicSalary: 10000,
      components,
      selectedComponentUuids: [assignmentUuids.fixedDeduction],
    });
    const unchecked = calculatePayrollAmounts({
      basicSalary: 10000,
      components,
      selectedComponentUuids: [],
    });

    expect(checked.deductions).toBe(300);
    expect(checked.net).toBe(9700);
    expect(unchecked.deductions).toBe(0);
    expect(unchecked.net).toBe(10000);
  });

  it("calculates fixed and percentage components and month-specific one-time items consistently", () => {
    const result = calculatePayrollAmounts({
      basicSalary: 10000,
      components,
      monthlyVariables: [
        { label: "One-time bonus", type: "allowance", amount: "250.00" },
        { label: "One-time deduction", type: "deduction", amount: "50.00" },
      ],
    });

    expect(result.allowances).toBe(1750);
    expect(result.deductions).toBe(850);
    expect(result.net).toBe(10900);
  });

  it("rejects a component that is not an allowance or deduction", () => {
    expect(() => calculatePayrollAmounts({
      basicSalary: 10000,
      components: [{ ...components[0], type: "bonus" }],
    })).toThrow(/invalid type/i);
  });

  it("rejects negative net salary instead of clamping it to zero", () => {
    expect(() => calculatePayrollAmounts({
      basicSalary: 100,
      monthlyVariables: [{ label: "Invalid one-off deduction", type: "deduction", amount: 150 }],
    })).toThrow(/net salary is negative/i);
  });

  it("rejects a missing monthly schedule with a clear error", async () => {
    pool.query.mockResolvedValueOnce([[]]);

    await expect(getWorkingDaysForMonth({ orgId: 7, month: 2, year: 2026 }))
      .rejects.toMatchObject({
        statusCode: 409,
        message: expect.stringContaining("Monthly working schedule is incomplete"),
      });
  });

  it("rejects a zero working-day denominator before dividing", () => {
    expect(() => computeAutomaticLines({
      summary: { ...summary(31), workingDays: 0, monthWorkingDays: 0 },
      basicSalary: 31000,
    })).toThrow(/schedule has no working days/i);
  });
});
