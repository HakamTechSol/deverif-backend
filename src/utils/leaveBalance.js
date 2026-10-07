/**
 * Normalize a DATE value (string "YYYY-MM-DD" or JS Date from mysql2) to
 * "YYYY-MM-DD".
 *
 * THE LOCAL CALENDAR FIELDS ARE LOAD-BEARING, and reading UTC here is a bug that
 * was live in this codebase for the whole of Phase 1.
 *
 * mysql2 parses a MySQL DATE into a JS Date at LOCAL midnight. On this server
 * (UTC+5) a stored 2026-10-01 arrives as 2026-09-30T19:00:00Z, so the UTC getters
 * report September. Verified against the database: isoDate() on a stored
 * 2026-10-01 returned "2026-09-30", and countLeaveDays() charged THREE days for a
 * two-day leave request, which also pushed employee_leave_allocations.used_days
 * up by one and therefore quietly understates the leave encashment paid at exit.
 *
 * Read the LOCAL fields, which round-trip a local-midnight Date exactly. This is
 * the same correction applied in payroll.service.js, and having two copies is how
 * the bug came back - so both now import this one.
 */
function toIsoDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}

/** Inclusive calendar-day count between two ISO date values (YYYY-MM-DD). */
export function countLeaveDays(startDate, endDate) {
  const s = new Date(`${toIsoDate(startDate)}T00:00:00Z`);
  const e = new Date(`${toIsoDate(endDate)}T00:00:00Z`);
  if (isNaN(s.getTime()) || isNaN(e.getTime())) return 0;
  return Math.max(0, Math.round((e - s) / 86400000) + 1);
}

/**
 * Calendar year a DATE value falls in (falls back to the current year).
 *
 * Local field for the same reason as toIsoDate. The fallback path parses an ISO
 * STRING at UTC midnight, so there the UTC getter is correct - hence local for
 * the Date branch, UTC for the string branch.
 */
export function yearOfDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.getFullYear();
  const d = new Date(`${String(value)}T00:00:00Z`);
  if (isNaN(d.getTime())) return new Date().getUTCFullYear();
  return d.getUTCFullYear();
}

/** "YYYY-MM-DD" string for display from a DATE value. */
export function isoDate(value) {
  return toIsoDate(value);
}