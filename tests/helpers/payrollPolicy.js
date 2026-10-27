/**
 * Payroll policy + work-week fixtures for the *.db.test.js suites.
 *
 * WHY THIS EXISTS. Payroll stopped assuming anything about an organization. The
 * hardcoded rules in payroll.service.js were set to `null` and replaced by two
 * per-organization tables:
 *
 *   work_week_config               which weekdays this org works
 *   organization_payroll_policies  currency, pay frequency, rate basis, hours per
 *                                  day, shift start, late rules, overtime multiplier
 *
 * `getWorkWeek` refuses to divide by an unconfigured week, and
 * `getConfiguredPayrollPolicy` refuses to compute anything until ALL thirteen policy
 * fields are non-null and `is_configured = 1`. That is the intended behaviour - no
 * organization should get an assumed deduction formula - but it means any suite that
 * exercises payroll, or anything that settles final pay, must provide a policy.
 *
 * Three suites did not, because they predate the policy table, so all of them failed
 * at the 409 rather than at anything they were written to test. Rather than have each
 * one hand-roll the same twenty-column INSERT and drift from the others, they share
 * these.
 */

/**
 * Defaults chosen to match what the surrounding money assertions assume:
 * Mon-Fri, 8-hour day, 09:00 shift with 30 minutes' grace (a 09:30 cutoff), a
 * 3-late-arrival threshold costing half a day, and 1.5x overtime.
 */
export const DEFAULT_PAYROLL_POLICY = {
  currency: "PKR",
  pay_frequency: "monthly",
  daily_rate_basis: "actual_working_days",
  hours_per_workday: 8,
  shift_start_time: "09:00:00",
  late_grace_minutes: 30,
  late_arrivals_per_penalty: 3,
  late_penalty_days: 0.5,
  overtime_multiplier: 1.5,
  deduct_unpaid_leave: 1,
  deduct_absences: 1,
  deduct_late_arrivals: 1,
  pay_approved_overtime: 1,
};

const COLUMNS = [
  "currency",
  "pay_frequency",
  "daily_rate_basis",
  "hours_per_workday",
  "shift_start_time",
  "late_grace_minutes",
  "late_arrivals_per_penalty",
  "late_penalty_days",
  "overtime_multiplier",
  "deduct_unpaid_leave",
  "deduct_absences",
  "deduct_late_arrivals",
  "pay_approved_overtime",
];

/**
 * Seed an org's working week. Without this, `getWorkWeek` either finds no row
 * ("work week is not configured") or refuses a week with no working day in it.
 * Re-seeding is safe: the table is uniquely keyed on organization_id.
 */
export async function seedWorkWeek(conn, orgId) {
  await conn.query(
    `INSERT INTO work_week_config (organization_id) VALUES (?)
     ON DUPLICATE KEY UPDATE updated_at = NOW()`,
    [orgId],
  );
}

/**
 * Seed a COMPLETE, explicitly-confirmed payroll policy.
 *
 * `is_configured = 1` is load-bearing: it is what distinguishes an
 * administrator's deliberate confirmation from a row that merely exists, and
 * getConfiguredPayrollPolicy queries for it specifically.
 */
export async function seedPayrollPolicy(conn, orgId, overrides = {}) {
  const policy = { ...DEFAULT_PAYROLL_POLICY, ...overrides };
  const placeholders = COLUMNS.map(() => "?").join(",");

  await conn.query(
    `INSERT INTO organization_payroll_policies
       (organization_id, ${COLUMNS.join(", ")}, is_configured)
     VALUES (?, ${placeholders}, 1)
     ON DUPLICATE KEY UPDATE ${COLUMNS.map((c) => `${c} = VALUES(${c})`).join(", ")}, is_configured = 1`,
    [orgId, ...COLUMNS.map((c) => policy[c])],
  );

  return policy;
}

/** Both at once - the combination almost every payroll-touching suite needs. */
export async function seedPayrollBaseline(conn, orgId, overrides = {}) {
  await seedWorkWeek(conn, orgId);
  return seedPayrollPolicy(conn, orgId, overrides);
}