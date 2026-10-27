import ApiError from "./ApiError.js";

/**
 * CNIC and phone rules, server-side.
 *
 * This is the ONE place the server decides what a national ID and a telephone
 * number look like. It exists because the same two fields were being validated
 * three different ways across three screens — the employee create accepted a
 * CNIC of "1", the candidate create checked nothing, and the sub-admin create
 * used a third regex — and the client could not be the fix, since a browser is
 * not a trust boundary.
 *
 * The rules chosen are the ones already in use, made unanimous:
 *
 *   CNIC   exactly 13 digits, optionally typed with dashes or spaces, which are
 *          stripped. Whether the number was actually ISSUED is NADRA's
 *          business, not this server's: a plausible-province check only ever
 *          rejects valid numbers, so only the shape is checked.
 *
 *   PHONE  the widest pattern already accepted by any form in this product —
 *          digits, spaces, +, parentheses and hyphens, 7–15 digits. Deliberately
 *          permissive about length because Pakistani mobile numbers vary by
 *          carrier and a stricter locator rejects real customers.
 *
 * Mirrors `dvarif-verified/src/lib/contactFormat.ts`, which is the same rule for
 * the same fields rendered in the browser. The two are separate files on
 * purpose: the frontend cannot import from here, and this cannot import from
 * there. Keeping them next to the field definitions they describe is what stops
 * a third copy appearing the next time a form needs one.
 */

export const CNIC_LENGTH = 13;

/** Digits only, from anything a client might have sent. */
export function normalizeCnic(value) {
  return String(value ?? "").replace(/\D/g, "");
}

/**
 * Why a supplied CNIC is unusable, or null when it is fine.
 * An ABSENT CNIC is not an error — `employees.cnic` is nullable precisely
 * because a candidate's ID is often collected later. Requiredness is the
 * caller's call, not this function's.
 */
export function cnicError(value) {
  const digits = normalizeCnic(value);
  if (!digits.length) return null;
  if (digits.length !== CNIC_LENGTH) return `CNIC must be ${CNIC_LENGTH} digits`;
  return null;
}

const PHONE_CHARS = /^[0-9+\-() ]*$/;
export const PHONE_MIN_DIGITS = 7;
export const PHONE_MAX_DIGITS = 15;

export function phoneDigits(value) {
  return String(value ?? "").replace(/\D/g, "");
}

export function isValidPhone(value) {
  const raw = String(value ?? "").trim();
  if (!raw.length) return true;
  if (!PHONE_CHARS.test(raw)) return false;
  const digits = phoneDigits(raw);
  if (digits.length < PHONE_MIN_DIGITS || digits.length > PHONE_MAX_DIGITS) return false;
  // A + may only lead. Whatever "0300+" is, it is not a dialable number.
  if (raw.includes("+") && !raw.startsWith("+")) return false;
  return true;
}

/** Throwing form for the controllers that prefer a 400 over a null. */
export function assertValidPhone(value, label = "phone") {
  if (isValidPhone(value)) return String(value ?? "").trim() || null;
  throw new ApiError(400, `${label} must be ${PHONE_MIN_DIGITS}-${PHONE_MAX_DIGITS} digits and may contain spaces and + ( ) -`);
}
