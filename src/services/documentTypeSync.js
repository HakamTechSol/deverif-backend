/**
 * Keep the Python document service's document-type catalogue in step with the
 * `document_types` table.
 *
 * WHY THIS EXISTS: the document-type list used to be hard-coded in two
 * repositories — the frontend array and the service's alias table — so adding a
 * type meant a code change and a redeploy of both. The catalogue is now a
 * database table that a system admin edits from the UI. The document service
 * still needs to know which field schema to extract for each label, so this
 * module pushes the table's contents to it after every change (and once at boot).
 *
 * WHY AN HTTP PUSH RATHER THAN A SHARED DATABASE READ: the document service is
 * a stateless processor with no database driver and no interest in the app's
 * schema. Handing it credentials would couple two independently-deployable
 * services to one database and let a database outage stop OCR entirely.
 *
 * FAILURE POLICY: a sync that cannot reach the service is logged and swallowed.
 * The catalogue is a convenience, never a correctness dependency — the service
 * keeps its built-in tables, which still resolve every seeded type, so a
 * document service that never receives a sync behaves exactly as it did before
 * this feature. A create/update/delete must therefore NOT be rolled back
 * because the push failed; it is retried on the next change or the next boot.
 */

import { pool } from "../config/db.js";
import { syncSchemas, describeSchemas, DocumentServiceError } from "./documentService.js";

/** Read the catalogue exactly as it should be pushed: active types only. */
export async function readActiveCatalogue() {
  const [rows] = await pool.query(
    `SELECT name, label_key, schema_key
       FROM document_types
      WHERE is_active = 1
      ORDER BY sort_order ASC, id ASC`
  );
  return rows.map((r) => ({
    label: r.name,
    label_key: r.label_key,
    schema_key: r.schema_key,
  }));
}

/**
 * Push the current catalogue to the document service.
 *
 * Returns a report rather than throwing, so every caller can log it and carry
 * on. `ok: false` means the service could not be reached or refused the
 * payload; `rejected` lists individual types the service did not accept (a
 * schema_key its build does not know), which is worth surfacing to an admin
 * because such a type silently extracts with the generic schema.
 */
export async function pushDocumentTypeCatalogue({ reason = "manual" } = {}) {
  let entries;
  try {
    entries = await readActiveCatalogue();
  } catch (error) {
    console.error(`[docTypeSync] could not read the catalogue (${reason}):`, error.message);
    return { ok: false, reason: "catalogue_read_failed", error: error.message, sent: 0 };
  }

  try {
    const { data } = await syncSchemas(
      entries.map((e) => ({ label: e.label, schema_key: e.schema_key }))
    );
    const rejected = data?.rejected || [];
    if (rejected.length) {
      console.warn(
        `[docTypeSync] (${reason}) the document service rejected ${rejected.length} type(s); ` +
          `they will use the generic schema: ${JSON.stringify(rejected)}`
      );
    }
    return {
      ok: true,
      reason,
      sent: entries.length,
      stored: data?.stored ?? null,
      rejected,
    };
  } catch (error) {
    const kind = error instanceof DocumentServiceError ? error.kind : "generic";
    console.warn(
      `[docTypeSync] (${reason}) could not reach the document service (${kind}): ${error.message}. ` +
        `The catalogue stays in the database; it will be pushed again on the next change or restart.`
    );
    return { ok: false, reason, kind, error: error.message, sent: 0 };
  }
}

/**
 * Fire-and-forget sync, for use after a write.
 *
 * Deliberately not awaited by the request handlers: a document-type edit must
 * succeed even when the document service is down, and must not add an OCR-sized
 * round trip to the admin's response. The rejection is caught so it can never
 * surface as an unhandled rejection.
 */
export function syncDocumentTypesInBackground(reason) {
  setImmediate(() => {
    pushDocumentTypeCatalogue({ reason }).catch((error) =>
      console.error(`[docTypeSync] background sync failed (${reason}):`, error.message)
    );
  });
}

/**
 * Push once at boot, retried shortly after.
 *
 * The document service may start after the API (separate processes, separate
 * deploys). A single boot push that lands while the service is still coming up
 * would leave the catalogue stale until the next admin edit, so a short retry
 * ladder runs in the background. Nothing here blocks server startup.
 */
export function syncDocumentTypesOnBoot({ attempts = 3, delayMs = 4000 } = {}) {
  const attempt = (n) => {
    pushDocumentTypeCatalogue({ reason: `boot#${n}` }).then((report) => {
      if (report.ok) {
        console.log(`[docTypeSync] catalogue pushed to the document service (${report.sent} types).`);
        return;
      }
      if (n < attempts) {
        console.warn(
          `[docTypeSync] boot sync attempt ${n}/${attempts} failed (${report.reason}); retrying in ${delayMs}ms.`
        );
        setTimeout(() => attempt(n + 1), delayMs);
      } else {
        console.warn(
          "[docTypeSync] giving up on the boot sync. Types added before now will still work " +
            "(the service has its own built-in mappings); re-run it by editing a document type, " +
            "or restart the backend."
        );
      }
    });
  };
  attempt(1);
}

/** Read-only probe used by the admin panel to show whether the service is in step. */
export async function getDocumentServiceSchemaStatus() {
  try {
    const { data } = await describeSchemas();
    // A flat, sorted list of valid keys alongside the per-key detail. The admin
    // panel's schema input completes against this instead of against a copy of
    // the registry baked into the frontend bundle, so a schema added to the
    // service is offered immediately and one removed disappears immediately.
    const schemaKeys = [...Object.keys(data?.schemas || {})].sort();
    if (data?.generic) schemaKeys.push("generic");
    return {
      reachable: true,
      ...data,
      schema_keys: schemaKeys.sort(),
    };
  } catch (error) {
    return {
      reachable: false,
      error: error.message,
      kind: error instanceof DocumentServiceError ? error.kind : "generic",
      schema_keys: [],
    };
  }
}

/**
 * The schema keys the document service can actually extract, as a Set.
 *
 * This is the single source of truth for "is this a valid schema_key". It was
 * previously a 40-entry array copied into the Node controller and a 40-entry
 * label map copied into the frontend, both of which had to be edited by hand
 * whenever the Python registry changed and silently rotted when they were not.
 * Asking the service means there is exactly one list — the registry the
 * extractor reads — so a new schema becomes selectable the moment it exists.
 *
 * `generic` is added explicitly: the service reports it separately from the
 * schema table (it is the fallback used when a label resolves to nothing), so it
 * is not in `schemas`, yet it is a real, working, valid choice.
 *
 * `reachable: false` means the service could not be asked. Callers must treat
 * that as "unknown", never as "empty" — an empty set would reject every key.
 */
export async function getSupportedSchemaKeys() {
  try {
    const { data } = await describeSchemas();
    const keys = new Set(Object.keys(data?.schemas || {}));
    keys.add("generic");
    return { supported: keys, reachable: true };
  } catch (error) {
    return { supported: new Set(), reachable: false, error: error.message };
  }
}
