import ApiError from "./ApiError.js";

/**
 * Allow-list based UPDATE/INSERT builders.
 *
 * WHY AN ALLOW-LIST AND NOT THE REQUEST BODY. The obvious implementation —
 * iterate `Object.keys(body)` and SET each one — is a mass-assignment hole. A
 * caller who can influence a request body can then write any column on the
 * table, including ones no UI exposes: `organization_id` (moving a row into
 * another tenant), `id`, `created_by_uuid`, or an internal status field. The
 * allow-list makes the set of writable columns a property of the CODE, not of
 * the request, so adding a dangerous column to a table cannot accidentally make
 * it writable.
 *
 * Everything here returns SQL fragments plus params, never executes anything.
 */

/** Columns no caller may ever write, whatever an allow-list says. */
const FORBIDDEN_COLUMNS = new Set([
  "id",
  "uuid",
  "organization_id",
  "created_at",
  "created_by_uuid",
]);

function quoteIdent(column) {
  // Backticks only; if an identifier needs escaping, that is a bug in the
  // caller's allow-list, not something to paper over here.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(column)) {
    throw new ApiError(500, `Unsafe column identifier: ${column}`);
  }
  return `\`${column}\``;
}

/**
 * Build ` SET `a`=?, `b`=?` from a body, restricted to `allowedColumns`.
 *
 * @param {object} body        incoming request body
 * @param {string[]} allowedColumns  the ONLY columns this endpoint may write
 * @param {object} [opts]
 * @param {string[]} [opts.ignore]   columns to skip even if present in the body
 * @returns {{ clause: string, params: any[], columns: string[] }}
 *          `clause` is "" when nothing in the body is writable.
 */
export function buildUpdate(body = {}, allowedColumns = [], opts = {}) {
  // Validate the whole allow-list up front rather than per matched column. The
  // allow-list is developer-supplied and therefore trusted, but checking it
  // eagerly means a bad entry fails at the first call instead of silently
  // going unexercised on the code paths that never happen to use it.
  for (const column of allowedColumns) quoteIdent(column);

  const ignore = new Set(opts.ignore ?? []);
  const assignments = [];
  const params = [];
  const columns = [];

  for (const column of allowedColumns) {
    if (!Object.prototype.hasOwnProperty.call(body, column)) continue;
    if (ignore.has(column)) continue;
    if (FORBIDDEN_COLUMNS.has(column)) {
      throw new ApiError(500, `Column "${column}" must not be writable`);
    }
    const value = body[column];
    // Skip undefined so "field absent" is distinguishable from "field null".
    if (value === undefined) continue;
    assignments.push(`${quoteIdent(column)}=?`);
    params.push(value);
    columns.push(column);
  }

  // A column present in the body but not in the allow-list is silently ignored
  // rather than rejected: the client may legitimately send a full object to a
  // partial-update endpoint, and failing the whole request would be hostile.
  // `buildUpdateStrict` is available where a typo should be an error.
  return {
    clause: assignments.length ? `SET ${assignments.join(", ")}` : "",
    params,
    columns,
  };
}

/** buildUpdate, but throws when the body contains an unknown column. */
export function buildUpdateStrict(body = {}, allowedColumns = [], opts = {}) {
  const allowed = new Set(allowedColumns);
  const unknown = Object.keys(body ?? {}).filter(
    (key) => !allowed.has(key) && !(opts.ignore ?? []).includes(key)
  );
  if (unknown.length) {
    throw new ApiError(400, `Unknown field(s): ${unknown.join(", ")}`);
  }
  return buildUpdate(body, allowedColumns, opts);
}

/**
 * Build `(`a`,`b`) VALUES (?,?)` plus params.
 *
 * Explicit column list rather than relying on table order, so adding a column
 * to the table cannot silently shift every value.
 */
export function buildInsert(row = {}, allowedColumns = []) {
  for (const column of allowedColumns) quoteIdent(column);

  const columns = [];
  const params = [];

  for (const column of allowedColumns) {
    if (!Object.prototype.hasOwnProperty.call(row, column)) continue;
    if (FORBIDDEN_COLUMNS.has(column)) {
      throw new ApiError(500, `Column "${column}" must not be writable`);
    }
    columns.push(quoteIdent(column));
    params.push(row[column]);
  }

  if (!columns.length) throw new ApiError(400, "No writable fields supplied");
  return { columns, placeholders: columns.map(() => "?"), params };
}

/**
 * Compose the WHERE clause for an org-scoped UPDATE/DELETE.
 *
 * organization_id is not optional here. Because `attachments.entity_uuid` and
 * friends have no foreign key, scoping is the ONLY thing preventing one tenant
 * from touching another's rows, and a helper that made the org filter optional
 * would be one refactor away from that being forgotten.
 */
export function buildOrgScope(orgId, extra = {}) {
  if (orgId === undefined || orgId === null) {
    throw new ApiError(500, "An organization scope is required");
  }
  const clauses = ["organization_id = ?"];
  const params = [orgId];
  for (const [column, value] of Object.entries(extra)) {
    if (value === undefined) continue;
    clauses.push(`${quoteIdent(column)} = ?`);
    params.push(value);
  }
  return { clause: clauses.join(" AND "), params };
}

/** Coerce a body value to a boolean, treating "" and "false" as false. */
export function boolField(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

/**
 * Trimmed string, or undefined when empty. Lets a PATCH clear a field with ""
 * while treating an omitted key as "leave alone".
 */
export function trimOrUndefined(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}