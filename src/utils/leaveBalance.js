/** Normalize a DATE value (string "YYYY-MM-DD" or JS Date from mysql2) to "YYYY-MM-DD". */
function toIsoDate(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, "0");
    const d = String(value.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(value);
}

/** Inclusive calendar-day count between two ISO date values (YYYY-MM-DD). */
export function countLeaveDays(startDate, endDate) {
  const s = new Date(`${toIsoDate(startDate)}T00:00:00Z`);
  const e = new Date(`${toIsoDate(endDate)}T00:00:00Z`);
  if (isNaN(s.getTime()) || isNaN(e.getTime())) return 0;
  return Math.max(0, Math.round((e - s) / 86400000) + 1);
}

/** Calendar year a DATE value falls in (falls back to the current year). */
export function yearOfDate(value) {
  if (value instanceof Date && !isNaN(value.getTime())) return value.getUTCFullYear();
  const d = new Date(`${String(value)}T00:00:00Z`);
  if (isNaN(d.getTime())) return new Date().getUTCFullYear();
  return d.getUTCFullYear();
}

/** "YYYY-MM-DD" string for display from a DATE value. */
export function isoDate(value) {
  return toIsoDate(value);
}