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

  // Per-organization employment keys (migrations/20261210_employee_org_scoped_identity.sql).
  // These are checked FIRST: the CNIC key name also matches the generic /uq.*cnic/
  // test below, which would otherwise claim the number belongs to "another user"
  // on the platform when the conflict is really this organization's roster.
  if (/uq_employees_org_active_cnic/i.test(message)) {
    throw new ApiError(409, "An employee with this CNIC already exists in this organization.");
  }
  if (/uq_employees_org_active_email/i.test(message)) {
    throw new ApiError(409, "An employee with this email address already exists in this organization.");
  }

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

/**
 * Employment identity is per organization.
 *
 * `employees` is an EMPLOYMENT record, not the person. When someone leaves one
 * company and joins another, the second company must be able to store the same
 * CNIC/email: the first row becomes `ex_employee` and stays as history, while a
 * new row is created in the new organization. Only a person who is CURRENTLY on
 * another organization's roster blocks the new employment.
 *
 * This is deliberately separate from assertIdentityAvailable(), which still
 * enforces one login identity in `users`: a returning employee links to their
 * existing platform account instead of creating a second one.
 *
 * `ex_employee` is the release status. It is the one lifecycle value written by
 * offboarding/archiving, and it means the person has left; a historical row must
 * not make them un-hireable forever. `inactive` is NOT released: it is a
 * deactivated account that is still on the roster.
 */
const EMPLOYMENT_RELEASED_STATUS = "ex_employee";

async function hasActiveEmployment({
  executor,
  column,
  value,
  organizationId,
  excludeEmployeeUuid,
  sameOrganization,
}) {
  const params = [value];
  let sql = `SELECT uuid FROM employees WHERE ${column}=? AND status <> '${EMPLOYMENT_RELEASED_STATUS}'`;
  sql += sameOrganization ? " AND organization_id=?" : " AND organization_id<>?";
  params.push(organizationId);
  if (excludeEmployeeUuid) {
    sql += " AND uuid<>?";
    params.push(excludeEmployeeUuid);
  }
  sql += " LIMIT 1";
  const [rows] = await executor.query(sql, params);
  return rows[0] || null;
}

/**
 * Reject a CNIC/email that is already held by a CURRENT employee in this
 * organization or in another one. Historical (`ex_employee`) rows are ignored,
 * which is what makes cross-company rehiring work.
 *
 * The message never names the other organization: that would leak one tenant's
 * roster to another tenant's admin.
 */
export async function assertEmploymentIdentityAvailable({
  executor,
  organizationId,
  cnic,
  email,
  excludeEmployeeUuid = null,
  cnicLabel = "CNIC",
  emailLabel = "email address",
} = {}) {
  const fields = [
    { column: "cnic", value: cnic, label: cnicLabel },
    { column: "email", value: email, label: emailLabel },
  ];

  for (const field of fields) {
    if (!hasValue(field.value)) continue;

    const sameOrg = await hasActiveEmployment({
      executor,
      column: field.column,
      value: String(field.value).trim(),
      organizationId,
      excludeEmployeeUuid,
      sameOrganization: true,
    });
    if (sameOrg) {
      throw new ApiError(
        409,
        `An employee with this ${field.label} already exists in this organization.`
      );
    }

    const otherOrg = await hasActiveEmployment({
      executor,
      column: field.column,
      value: String(field.value).trim(),
      organizationId,
      excludeEmployeeUuid,
      sameOrganization: false,
    });
    if (otherOrg) {
      throw new ApiError(
        409,
        `This ${field.label} belongs to a person who is currently employed at another organization. ` +
          `Their exit must be completed before they can be added here.`
      );
    }
  }
}

/**
 * One email address, one identity — across BOTH `users` and `employees`.
 *
 * WHY THIS IS NOT JUST THE DATABASE'S JOB
 *     `users.email` is UNIQUE, so two login accounts can never share one. But
 *     `employees.email` has no unique constraint and, until the migration
 *     alongside this file, no index at all. So an employee row and a user row
 *     could both hold the same address and the database was perfectly happy:
 *     the person ended up with an HR record showing "no portal access" and a
 *     separate login that nothing pointed at. `employees.linked_user_uuid` is
 *     what ties the two together, and creating a user through the admin path
 *     never set it.
 *
 *     One person must not exist as an unlinked employee AND an unrelated
 *     account. That split is invisible in the UI (the employee keeps claiming
 *     no portal access forever) and unfixable once the two have diverged.
 *
 * WHY IT REFUSES RATHER THAN LINKS
 *     utils/services/employeeAccess.service.js deliberately never links
 *     accounts by email alone, and that judgement still holds here: emails get
 *     shared, mistyped and reassigned, and silently merging two records on a
 *     string match is worse than refusing. The intended path for giving an
 *     employee portal access is that service, which creates the account AND
 *     writes `is_platform_user='yes', linked_user_uuid=...` in one transaction.
 *     This check exists to make sure nobody reaches it by the side door.
 *
 * `linkedUserUuid` is what keeps the check from firing on the legitimate pairs.
 * An employee already linked to the account being edited IS the same person,
 * re-saving their own profile must not report them as a duplicate of
 * themselves — the same reason `excludeUserId` exists above.
 */
export async function assertEmailAvailable({
  email,
  executor,
  excludeUserUuid = null,
  // The account being edited is also the account its employee record may be
  // linked to, so the two exclusions are the same value. Defaulting it here
  // means a caller cannot exclude the user half and forget the employee half,
  // which would block the very profile save this is meant to allow.
  linkedUserUuid = excludeUserUuid,
  emailLabel = "email address",
} = {}) {
  if (!hasValue(email)) return;
  const value = String(email).trim();

  // `users` first: this is the one the DB would reject anyway, and naming the
  // existing account is more useful than the raw index name. `excludeUserUuid`
  // is the account being edited — without it, saving a profile whose email has
  // not changed would report that account as a duplicate of itself.
  let userSql = "SELECT uuid, full_name, email FROM users WHERE email = ?";
  const userParams = [value];
  if (excludeUserUuid) {
    userSql += " AND uuid <> ?";
    userParams.push(excludeUserUuid);
  }
  userSql += " LIMIT 1";
  const [userRows] = await executor.query(userSql, userParams);
  if (userRows.length) {
    throw new ApiError(
      409,
      `This ${emailLabel} is already registered to ${describe(userRows[0])}. ` +
        `Each person can have only one account on the platform.`
    );
  }

  // Any employee row blocks, whatever their employment status: the product rule
  // is one email, one identity, and an ex-employee record is still a person who
  // was here. Reporting status in the message is enough to explain a refusal
  // without making it conditional.
  let sql =
    "SELECT e.uuid, e.full_name, e.email, e.employee_code, e.status, e.is_platform_user," +
    "       e.linked_user_uuid, o.name AS organization_name" +
    "  FROM employees e" +
    "  LEFT JOIN organizations o ON o.id = e.organization_id" +
    " WHERE e.email = ?";
  const params = [value];
  if (linkedUserUuid) {
    // Skip the employee who IS this account. Without this, every save of a
    // linked employee's profile would 409 against their own record.
    sql += " AND (e.linked_user_uuid IS NULL OR e.linked_user_uuid <> ?)";
    params.push(linkedUserUuid);
  }
  sql += " LIMIT 1";

  const [empRows] = await executor.query(sql, params);
  if (empRows.length) {
    const e = empRows[0];
    const code = e.employee_code ? ` (${e.employee_code})` : "";
    const org = e.organization_name ? ` at ${e.organization_name}` : "";
    throw new ApiError(
      409,
      `This ${emailLabel} is already used by employee ${e.full_name}${code}${org}. ` +
        `An employee and a user account cannot share one ${emailLabel}. ` +
        `Give that employee portal access from their employee record instead of creating a separate account.`
    );
  }
}
