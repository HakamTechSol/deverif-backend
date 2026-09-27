import ApiError from "./ApiError.js";

/**
 * One person, one phone number, one CNIC.
 *
 * The database enforces this (uq_users_phone_normalized, and the existing UNIQUE
 * on cnic), so a duplicate can never be stored. That guarantee is deliberately in
 * the schema rather than in these checks, because there are seven code paths that
 * write users.phone and any one of them could forget a guard.
 *
 * What lives here is the part the database cannot do: saying something useful.
 * A raw driver error reads "Duplicate entry '3127464847' for key
 * 'uq_users_phone_normalized'", which names an internal index, shows a mangled
 * number, and does not tell the person doing the data entry whose number it is or
 * which field to fix. These helpers turn that into a 409 a human can act on.
 */

/**
 * Canonical national form of a phone number — the JS twin of the SQL function
 * dverif_normalize_phone(). Both must agree: the trigger writes the column from
 * its own copy, and this is used to search on it and to phrase error messages.
 *
 *   03182484396 / +92 318 2484396 / 00923182484396 / 3182484396  ->  3182484396
 *
 * Trunk and country codes are only stripped at unambiguous lengths. An
 * unexpected length is returned as-is rather than guessed at, because a wrong
 * guess would merge two different people — the exact failure being prevented.
 */
export function normalizePhone(phone) {
  if (phone === null || phone === undefined) return null;
  const digits = String(phone).replace(/[^0-9]/g, "");
  if (digits === "") return null;
  if (digits.length === 14 && digits.startsWith("0092")) return digits.slice(4);
  if (digits.length === 12 && digits.startsWith("92")) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  return digits;
}

/** Blank / absent values are allowed: plenty of people have no number on file. */
const hasValue = (v) => v !== null && v !== undefined && String(v).trim() !== "";

async function findConflict(executor, column, value, excludeUserId) {
  if (!hasValue(value)) return null;
  const params = [String(value).trim()];
  let sql = `SELECT id, uuid, email, full_name, \`${column}\` FROM users WHERE \`${column}\` = ?`;
  if (excludeUserId !== undefined && excludeUserId !== null) {
    sql += " AND id <> ?";
    params.push(excludeUserId);
  }
  // A soft-deleted row releases its phone (the trigger nulls phone_normalized),
  // so it must not be reported as a conflict.
  if (column === "phone_normalized") sql += " AND deleted_at IS NULL";
  sql += " LIMIT 1";
  const [rows] = await executor.query(sql, params);
  return rows[0] || null;
}

const describe = (row) => (row.full_name ? `${row.full_name} <${row.email}>` : row.email);

/**
 * Pre-flight check so the caller gets a precise message.
 *
 * excludeUserId matters: without it, saving an unchanged profile would report the
 * user as a duplicate of themselves.
 */
export async function assertIdentityAvailable({
  phone,
  cnic,
  excludeUserId,
  executor,
  phoneLabel = "phone number",
  cnicLabel = "CNIC",
} = {}) {
  const phoneClash = await findConflict(executor, "phone_normalized", normalizePhone(phone), excludeUserId);
  if (phoneClash) {
    throw new ApiError(
      409,
      `This ${phoneLabel} is already registered to ${describe(phoneClash)}. ` +
        `Each person can have only one ${phoneLabel} on the platform.`
    );
  }

  // CNIC is compared exactly as stored — it is a fixed-format government id, so
  // there is nothing to canonicalise, and a near-miss must not be treated as a
  // duplicate of a real one.
  const cnicClash = await findConflict(executor, "cnic", cnic, excludeUserId);
  if (cnicClash) {
    throw new ApiError(
      409,
      `This ${cnicLabel} is already registered to ${describe(cnicClash)}. ` +
        `A ${cnicLabel} identifies one person and cannot be reused.`
    );
  }
}

/**
 * Safety net for the race the pre-check cannot cover: two requests that both pass
 * the check, then both insert. The index rejects the second one, and this turns
 * that into the same clear 409 rather than leaking the driver message.
 */
export function rethrowIdentityDuplicate(err, context = {}) {
  const message = String(err?.message || "");
  if (!/duplicate entry/i.test(message)) throw err;

  if (/uq_users_phone_normalized|\.phone_normalized/i.test(message)) {
    throw new ApiError(
      409,
      `This ${context.phoneLabel || "phone number"} is already registered to another user. ` +
        `Each person can have only one ${context.phoneLabel || "phone number"} on the platform.`
    );
  }
  if (/key 'cnic'|uq.*cnic|\.cnic/i.test(message)) {
    throw new ApiError(
      409,
      `This ${context.cnicLabel || "CNIC"} is already registered to another user. ` +
        `A ${context.cnicLabel || "CNIC"} identifies one person and cannot be reused.`
    );
  }
  // A different unique key (email, uuid) — keep the historical behaviour of
  // surfacing the conflict, but strip the raw index name.
  throw new ApiError(409, "That value is already in use by another record.");
}
