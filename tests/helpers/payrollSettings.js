/**
 * Fixtures for the monthly payroll calendar and attendance calculation.
 * Seeds a complete 2026 calendar so DB tests can preview and generate monthly
 * payroll without depending on the weekday-policy tables that were removed.
 */
export const DEFAULT_PAYROLL_SETTINGS = {
  salary_calculation_method: "days",
  calculate_overtime: 1,
  shift_start_time: "09:00:00",
  shift_end_time: "17:00:00",
  overtime_multiplier: 1.5,
};

export async function seedPayrollSettings(conn, orgId, overrides = {}) {
  const settings = { ...DEFAULT_PAYROLL_SETTINGS, ...overrides };
  await conn.query(
    `INSERT INTO organization_payroll_settings
       (organization_id, salary_calculation_method, calculate_overtime, shift_start_time, shift_end_time, overtime_multiplier)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE salary_calculation_method=VALUES(salary_calculation_method),
       calculate_overtime=VALUES(calculate_overtime), shift_start_time=VALUES(shift_start_time),
       shift_end_time=VALUES(shift_end_time), overtime_multiplier=VALUES(overtime_multiplier)`,
    [orgId, settings.salary_calculation_method, settings.calculate_overtime, settings.shift_start_time, settings.shift_end_time, settings.overtime_multiplier],
  );
  return settings;
}

export async function seedMonthlySchedule(conn, orgId, year = 2026, month = null) {
  const months = month ? [month] : Array.from({ length: 12 }, (_, i) => i + 1);
  for (const m of months) {
    const total = new Date(Date.UTC(year, m, 0)).getUTCDate();
    for (let day = 1; day <= total; day += 1) {
      const date = new Date(Date.UTC(year, m - 1, day));
      const dayType = date.getUTCDay() === 0 || date.getUTCDay() === 6 ? "off" : "working";
      const iso = date.toISOString().slice(0, 10);
      await conn.query(
        `INSERT INTO organization_monthly_work_schedules (organization_id, schedule_date, day_type)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE day_type=VALUES(day_type)`,
        [orgId, iso, dayType],
      );
    }
  }
}

export async function seedWorkWeek(conn, orgId) {
  await seedMonthlySchedule(conn, orgId);
}

export async function seedPayrollBaseline(conn, orgId, overrides = {}) {
  const settings = await seedPayrollSettings(conn, orgId, overrides);
  await seedMonthlySchedule(conn, orgId);
  return settings;
}
