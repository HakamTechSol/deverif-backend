import ApiError from "../../utils/ApiError.js";
import { pool } from "../../config/db.js";
import { ok, created } from "../../utils/response.js";
import { logAudit, getActorFromReq } from "../../utils/auditLog.js";
import { assertUuid } from "../../utils/publicResponse.js";
import {
  syncDocumentTypesInBackground,
  getDocumentServiceSchemaStatus,
  getSupportedSchemaKeys,
} from "../../services/documentTypeSync.js";

/**
 * Document-type catalogue administration (system admin only).
 *
 * The catalogue used to be a hard-coded array in the frontend. It is now data,
 * so a system admin can add a type without a code change. Each row carries a
 * `schema_key` — the canonical field schema the OCR/matching engine uses for
 * that type — which is what makes a new type WORK rather than merely appear in
 * a dropdown. The catalogue is pushed to the document service after every write
 * (see services/documentTypeSync.js).
 *
 * The set of valid `schema_key` values is NOT listed in this file. It used to be
 * a 40-entry `KNOWN_SCHEMA_KEYS` array copied from the Python service's schema
 * registry, so the two had to be edited together and the copy rotted silently
 * whenever only one side changed. The service is asked instead — see
 * `getSupportedSchemaKeys` — leaving the registry as the single definition of
 * what can be extracted.
 *
 * `label_key` mirrors the service's own normalization exactly (lowercase, every
 * run of non-alphanumerics collapsed to one space) so the two agree on what
 * "the same label" means without either side re-deriving it.
 */

const MAX_NAME = 150;
const MAX_DESCRIPTION = 255;
const MAX_SCHEMA_KEY = 50;

/**
 * The same normalization the Python service applies to a document_type string
 * (document_schemas._normalize_key): lowercase, with every run of characters
 * that is not a letter or digit collapsed to a single space.
 */
export function normalizeLabelKey(name) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/[^0-9a-z]+/g, " ")
    .trim();
}

function validateName(raw) {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name) throw new ApiError(400, "name is required");
  if (name.length > MAX_NAME) {
    throw new ApiError(400, `name must be ${MAX_NAME} characters or fewer`);
  }
  return name;
}

/**
 * Validate a schema key against what the document service actually supports.
 *
 * The list of valid keys is NOT kept in this file. It used to be a 40-entry
 * `KNOWN_SCHEMA_KEYS` array duplicated from the Python service, which meant the
 * two had to be edited in lockstep and the copy silently rotted whenever a schema
 * was added on one side only. The service is asked instead, so the set of valid
 * keys has exactly one definition — the registry the extractor actually reads.
 *
 * A key the service does not know is rejected rather than accepted-and-ignored:
 * `set_dynamic_label_map` on the Python side drops such entries, so the type
 * would be stored and listed as selectable while quietly extracting with the
 * generic schema. Failing at save time is the only point where the admin can
 * still see the mistake.
 *
 * If the service is unreachable, the write is allowed through rather than
 * blocked: a catalogue entry is a convenience and must not be un-editable
 * because the OCR service happens to be down, and the extractor degrades to the
 * generic schema in the meantime. The sync push retries on the next change.
 */
async function validateSchemaKey(raw) {
  // An omitted schema is a legitimate choice, not an error: 'generic' extracts
  // name + CNIC and is a real, working schema.
  const schemaKey = typeof raw === "string" && raw.trim() ? raw.trim() : "generic";
  if (schemaKey.length > MAX_SCHEMA_KEY) {
    throw new ApiError(400, `schema_key must be ${MAX_SCHEMA_KEY} characters or fewer`);
  }

  const { supported, reachable } = await getSupportedSchemaKeys();
  if (!reachable) {
    console.warn(
      `[docTypes] could not confirm schema_key "${schemaKey}" against the document service; ` +
        `accepting it. It will fall back to the generic schema until the service is reachable.`
    );
    return schemaKey;
  }
  if (!supported.has(schemaKey)) {
    throw new ApiError(
      400,
      `Unknown schema_key "${schemaKey}". The document service supports: ${[...supported].sort().join(", ")}`
    );
  }
  return schemaKey;
}

function validateDescription(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  const description = String(raw).trim();
  if (!description) return null;
  if (description.length > MAX_DESCRIPTION) {
    throw new ApiError(400, `description must be ${MAX_DESCRIPTION} characters or fewer`);
  }
  return description;
}

const SELECT_COLUMNS = "id, name, label_key, schema_key, is_active, sort_order, description, created_at, updated_at";

export async function listDocumentTypes(req, res) {
  const [rows] = await pool.query(
    `SELECT ${SELECT_COLUMNS} FROM document_types ORDER BY sort_order ASC, id ASC`
  );
  return ok(res, { items: rows }, "Document types");
}

/**
 * The active catalogue, for the dropdowns that populate document submissions
 * and employee reference uploads.
 *
 * Intentionally NOT admin-only: an organization user has to be able to see the
 * list in order to pick from it. It exposes nothing but labels and the schema
 * each maps to — no ids, no audit fields, no internal state.
 */
export async function listActiveDocumentTypes(req, res) {
  const [rows] = await pool.query(
    `SELECT name, schema_key FROM document_types
      WHERE is_active = 1
      ORDER BY sort_order ASC, id ASC`
  );
  return ok(
    res,
    { items: rows.map((r) => ({ value: r.name, label: r.name, schema_key: r.schema_key })) },
    "Document types"
  );
}

export async function createDocumentType(req, res) {
  const name = validateName(req.body?.name);
  const schemaKey = await validateSchemaKey(req.body?.schema_key);
  const description = validateDescription(req.body?.description);
  const isActive = req.body?.is_active === false ? 0 : 1;
  const labelKey = normalizeLabelKey(name);

  if (!labelKey) {
    throw new ApiError(400, "name must contain at least one letter or digit");
  }

  // New types go to the end of the list rather than into a hole.
  const [sortRows] = await pool.query(
    "SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM document_types"
  );
  const next = Number(sortRows?.[0]?.next ?? 1);

  try {
    const [result] = await pool.query(
      `INSERT INTO document_types (name, label_key, schema_key, is_active, sort_order, description, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        name,
        labelKey,
        schemaKey,
        isActive,
        next,
        description,
        req.admin?.uuid || null,
      ]
    );
    const [rows] = await pool.query(
      `SELECT ${SELECT_COLUMNS} FROM document_types WHERE id=?`,
      [result.insertId]
    );

    logAudit({
      ...getActorFromReq(req),
      action: "document_type.create",
      entityType: "document_type",
      entityId: String(result.insertId),
      details: { name, schema_key: schemaKey, is_active: Boolean(isActive) },
      req,
    });

    // Fire-and-forget: the type is already committed. If the document service is
    // unreachable the catalogue still lives in the database and is pushed again
    // on the next edit or restart; a failure here must not fail the request.
    syncDocumentTypesInBackground(`create:${result.insertId}`);

    return created(res, { document_type: rows[0] }, "Document type created");
  } catch (e) {
    if (String(e.message).includes("Duplicate")) {
      throw new ApiError(409, "A document type with this name already exists");
    }
    throw e;
  }
}

export async function updateDocumentType(req, res) {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) throw new ApiError(400, "Invalid document type id");

  const [[existing]] = await pool.query("SELECT * FROM document_types WHERE id=?", [id]);
  if (!existing) throw new ApiError(404, "Document type not found");

  const name = req.body?.name === undefined ? existing.name : validateName(req.body.name);
  const schemaKey =
    req.body?.schema_key === undefined
      ? existing.schema_key
      : await validateSchemaKey(req.body.schema_key);
  const description =
    req.body?.description === undefined ? existing.description : validateDescription(req.body.description);
  const isActive =
    req.body?.is_active === undefined ? existing.is_active : req.body.is_active ? 1 : 0;

  // Renaming changes the key the document service matches on, so both move
  // together and the service is re-synced.
  const labelKey = normalizeLabelKey(name);
  if (!labelKey) throw new ApiError(400, "name must contain at least one letter or digit");

  try {
    await pool.query(
      `UPDATE document_types
          SET name=?, label_key=?, schema_key=?, description=?, is_active=?
        WHERE id=?`,
      [name, labelKey, schemaKey, description, isActive, id]
    );
  } catch (e) {
    if (String(e.message).includes("Duplicate")) {
      throw new ApiError(409, "A document type with this name already exists");
    }
    throw e;
  }

  const [rows] = await pool.query(`SELECT ${SELECT_COLUMNS} FROM document_types WHERE id=?`, [id]);

  logAudit({
    ...getActorFromReq(req),
    action: "document_type.update",
    entityType: "document_type",
    entityId: String(id),
    details: {
      before: { name: existing.name, schema_key: existing.schema_key, is_active: Boolean(existing.is_active) },
      after: { name, schema_key: schemaKey, is_active: Boolean(isActive) },
    },
    req,
  });

  syncDocumentTypesInBackground(`update:${id}`);

  return ok(res, { document_type: rows[0] }, "Document type updated");
}

/**
 * Delete a document type.
 *
 * Allowed even when historical rows carry it, because `document_type` is a plain
 * VARCHAR on verification_requests, person_documents and employee_documents —
 * not a foreign key — so old records keep reading back exactly as they were. The
 * audit log records the name so the catalogue can still explain the past.
 */
export async function deleteDocumentType(req, res) {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) throw new ApiError(400, "Invalid document type id");

  const [[type]] = await pool.query("SELECT id, name, schema_key FROM document_types WHERE id=?", [id]);
  if (!type) throw new ApiError(404, "Document type not found");

  await pool.query("DELETE FROM document_types WHERE id=?", [id]);

  logAudit({
    ...getActorFromReq(req),
    action: "document_type.delete",
    entityType: "document_type",
    entityId: String(id),
    details: { name: type.name, schema_key: type.schema_key },
    req,
  });

  // REPLACE semantics on the service side: a deleted type must stop resolving
  // to its custom schema, which only happens once it is absent from the push.
  syncDocumentTypesInBackground(`delete:${id}`);

  return ok(res, { deleted: true, name: type.name }, "Document type deleted");
}

/**
 * Whether the document service is currently in step with this catalogue.
 *
 * Surfaced in the admin panel so "the service knows about my new type" is a fact
 * an admin can SEE rather than something they take on trust — a sync that never
 * arrived leaves the new type extracting with the generic schema, which is safe
 * but is not what the admin asked for.
 */
export async function getDocumentTypeSyncStatus(req, res) {
  const status = await getDocumentServiceSchemaStatus();
  return ok(res, { status }, "Document service sync status");
}
