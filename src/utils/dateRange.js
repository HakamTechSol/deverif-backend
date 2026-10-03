import ApiError from "./ApiError.js";
import { isoDate, yearOfDate } from "./leaveBalance.js";

/**
 * Date-range parsing shared by every list/export endpoint.
 *
 * Reuses isoDate/yearOfDate from leaveBalance.js rather than re-deriving them:
 * "YYYY-MM-DD" formatting appears in three places in this codebase already, and
 * a fourth subtly different copy is how an off-by-one timezone bug appears in
 * one report and not another.
 *
 * The one behaviour worth stating out loud: an unparseable date is a 400, never
 * a silently-ignored filter. A report that quietly returns ALL rows because the
 * requested range was malformed is worse than one that refuses to run.
 */

/** Parse "YYYY-MM-DD" strictly (rejects 2026-13-01, 2026-02-30, "not-a-date"). */
export function parseIsoDate(value, label = "date") {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new ApiError(400, `${label} is not a valid date`);
    return isoDate(value);
  }
  const text = String(value ?? "").trim();
  if (!text) throw new ApiError(400, `${label} is required`);

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) throw new ApiError(400, `${label} must be in YYYY-MM-DD format`);

  const [, y, m, d] = match.map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  // Date.UTC rolls invalid values over (month 13 -> January), so compare back.
  if (
    probe.getUTCFullYear() !== y ||
    probe.getUTCMonth() !== m - 1 ||
    probe.getUTCDate() !== d
  ) {
    throw new ApiError(400, `${label} is not a real calendar date`);
  }
  return text;
}

/** Parse "YYYY-MM", e.g. from ?month=2026-10. */
export function parseYearMonth(value, label = "month") {
  const text = String(value ?? "").trim();
  const match = /^(\d{4})-(\d{2})$/.exec(text);
  if (!match) throw new ApiError(400, `${label} must be in YYYY-MM format`);
  const [, y, m] = match.map(Number);
  if (m < 1 || m > 12) throw new ApiError(400, `${label} month must be 01-12`);
  return { year: y, month: m };
}

/**
 * Resolve a report/list date range from a query object.
 *
 * @param {object} query        req.query
 * @param {object} [opts]
 * @param {number} [opts.maxDays]     reject a range wider than this
 * @param {boolean} [opts.allowOpen]  permit a missing bound (open-ended range)
 * @returns {{ from: string|null, to: string|null, days: number|null }}
 */
export function resolveDateRange(query = {}, opts = {}) {
  const { maxDays, allowOpen = true } = opts;
  const rawFrom = query.date_from ?? query.from;
  const rawTo = query.date_to ?? query.to;

  const from = rawFrom === undefined || rawFrom === null || rawFrom === "" ? null : parseIsoDate(rawFrom, "date_from");
  const to = rawTo === undefined || rawTo === null || rawTo === "" ? null : parseIsoDate(rawTo, "date_to");

  if (!from && !to && !allowOpen) {
    throw new ApiError(400, "date_from or date_to is required");
  }
  if (from && to && from > to) {
    throw new ApiError(400, "date_from cannot be after date_to");
  }

  let days = null;
  if (from && to) {
    const start = new Date(`${from}T00:00:00Z`).getTime();
    const end = new Date(`${to}T00:00:00Z`).getTime();
    days = Math.floor((end - start) / 86400000) + 1; // inclusive of both ends
    if (maxDays && days > maxDays) {
      throw new ApiError(400, `Date range cannot exceed ${maxDays} days`);
    }
  }
  return { from, to, days };
}

/** First and last day of a month as "YYYY-MM-DD". */
export function monthRange(year, month) {
  const y = Number(year);
  const m = Number(month);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) throw new ApiError(400, "year is invalid");
  if (!Number.isInteger(m) || m < 1 || m > 12) throw new ApiError(400, "month must be between 1 and 12");

  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    from: `${y}-${String(m).padStart(2, "0")}-01`,
    to: `${y}-${String(m).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`,
    days: lastDay,
  };
}

/** Calendar year a date falls in — re-exported so callers need one import. */
export { yearOfDate, isoDate };

export const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];