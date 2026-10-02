/**
 * The two terminal, successful statuses of a verification request.
 *
 * `verified` — a human at the target organization (or a platform admin) reviewed
 * the document and approved it.
 *
 * `auto_verified` — the system approved it on its own, without any human at the
 * target organization looking at it. Two paths reach this: the reference match
 * (`verification_method='automatic_match'`, see utils/autoMatch.js) and a repeat
 * of a file that was already verified before
 * (`verification_method='auto'`).
 *
 * WHY THIS EXISTS: `auto_verified` was added to the `status` ENUM so the
 * requester can be told that nobody reviewed their document, rather than seeing
 * a plain "Verified" that implies a person did. The cost of promoting it to a
 * first-class status is that it is no longer caught by `status='verified'`, and
 * every query meaning "did this request succeed?" would silently stop seeing
 * auto-approved requests — the QR page would refuse them, the certificate would
 * 404, dashboard counts would drift low.
 *
 * So the rule is: NEVER test `status='verified'` on verification_requests. Use
 * `isVerifiedStatus()` in JS, or the SQL fragment below, which is the exact text
 * every such query must use. Keeping the two values in one file is what makes
 * the next added status a single edit rather than an audit of the whole codebase.
 */

/** Statuses that mean "this request was successfully verified". */
export const VERIFIED_STATUSES = ["verified", "auto_verified"];

/** The terminal-success test, for JS branches. */
export function isVerifiedStatus(status) {
  return VERIFIED_STATUSES.includes(String(status));
}

/**
 * A ready-made `IN (...)` clause for SQL, quoted for MySQL.
 *
 * Interpolated rather than bound on purpose: it is a compile-time constant of
 * this module, never anything derived from a request. Kept as a fragment so a
 * query cannot spell the list out by hand and drift from it.
 */
export const VERIFIED_STATUS_SQL = `'verified','auto_verified'`;

/** `(?, ?)` placeholders matching VERIFIED_STATUSES, for a bound-parameter query. */
export const VERIFIED_STATUS_PLACEHOLDERS = VERIFIED_STATUSES.map(() => "?").join(", ");