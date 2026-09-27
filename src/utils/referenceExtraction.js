import { ocrExtract, DocumentServiceError } from "../services/documentService.js";

/**
 * Canonical-field extraction for EMPLOYEE reference documents, run at UPLOAD time.
 *
 * A reference document is the yardstick the auto-verification match compares
 * every incoming submission against, so its identity fields have to exist as
 * DATA, not as a file that has to be re-read on every match. Two gaps made that
 * impossible before this module existed:
 *
 *   1. Nothing was extracted at upload. The first comparison re-sent the
 *      reference file to the document service and re-extracted it there, so a
 *      reference that had been deleted from disk (or temporarily unreadable)
 *      silently degraded every later match, and a slow reference made every
 *      request wait on it.
 *   2. Office formats were treated as second-class. The upload path skipped
 *      hashing for anything that was not PDF/image, and the extraction never
 *      ran at all for those types — a DOCX reference therefore never produced
 *      comparable data, so a DOCX-vs-PDF submission of the same document fell
 *      through to manual review despite being an exact content match.
 *
 * The document service already dispatches on the file's real content type:
 * PDF and raster images go through the OCR path, and a DOCX (a ZIP carrying
 * word/document.xml) is read straight out of the document XML with python-docx
 * rather than being rasterised. Both return the SAME canonical field map
 * ({name, cnic, dob, ...} -> {value, confidence}), which is why the cache can
 * be compared against a freshly extracted submission regardless of the two
 * files' formats.
 *
 * Never throws. A reference that cannot be processed is stored with a status
 * explaining why and falls back to the live-comparison path, because failing an
 * upload that already passed the corrupt-file check would be a worse outcome
 * than a slower match.
 */

export const EXTRACTION_NOT_ATTEMPTED = "not_attempted";
export const EXTRACTION_SUCCEEDED = "succeeded";
export const EXTRACTION_FAILED = "failed";
export const EXTRACTION_NOT_APPLICABLE = "not_applicable";

const EXTRACTABLE_MIME = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/bmp",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

// Extension -> the mime above, for when the client sends a generic blob marker
// (or nothing at all). Keyed by extension so it stays in step with the upload
// allow-list in middleware/uploadDocs.js.
const EXTRACTABLE_EXT_TO_MIME = {
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

/**
 * True when the document service can pull canonical identity text out of this
 * file. Mirrors the upload allow-list in middleware/uploadDocs.js: PDF, the
 * raster image types, and DOCX. Legacy .doc (an OLE2 compound file) and .txt
 * are deliberately excluded — neither has a text path the service can read, so
 * asking would only ever produce an empty extraction.
 */
export function isCanonicalExtractionSupported(file) {
  if (!file) return false;
  if (EXTRACTABLE_MIME.has(file.mimetype)) return true;
  // Browsers send a generic blob marker for some types, so fall back to the
  // extension rather than skipping an otherwise-valid PDF/DOCX.
  if (!file.mimetype || file.mimetype === "application/octet-stream") {
    const name = String(file.originalname || "").toLowerCase();
    const ext = name.slice(name.lastIndexOf("."));
    if (ext && EXTRACTABLE_EXT_TO_MIME[ext]) return true;
  }
  return false;
}

function errorMessage(e) {
  const raw = (e && e.message) || String(e);
  return String(raw).slice(0, 255);
}

/**
 * Extract the canonical field map for a reference document.
 *
 * @returns {{status: string, data: object|null, error: string|null}} Never throws.
 *   succeeded -> data is the cached payload (JSON-serializable)
 *   failed    -> the service was reached but produced nothing usable
 *   not_applicable -> this file type carries no extractable identity text
 */
export async function extractCanonicalFields(diskPath, documentType, file) {
  if (!isCanonicalExtractionSupported(file)) {
    return {
      status: EXTRACTION_NOT_APPLICABLE,
      data: null,
      error: "File type carries no extractable identity text — matching will compare files live",
    };
  }

  let payload;
  try {
    const { data } = await ocrExtract(diskPath, documentType);
    payload = data;
  } catch (e) {
    const kind = e instanceof DocumentServiceError ? e.kind || "service" : "error";
    console.warn(`[reference-extraction] ${diskPath}: extraction failed (${kind}): ${e.message}`);
    return { status: EXTRACTION_FAILED, data: null, error: errorMessage(e) };
  }

  const fields = payload && typeof payload === "object" ? payload.fields : null;
  if (!fields || typeof fields !== "object" || !Object.keys(fields).length) {
    return {
      status: EXTRACTION_FAILED,
      data: null,
      error: "Document service returned no extractable identity fields",
    };
  }

  return {
    status: EXTRACTION_SUCCEEDED,
    // `document_type_label` keeps the ORIGINAL type string alongside the
    // canonical key, so a later comparison can re-resolve the same schema
    // without depending on the canonical key round-tripping through
    // resolve_document_type().
    data: {
      document_type: payload.document_type ?? null,
      document_type_label: documentType || null,
      fields,
    },
    error: null,
  };
}

/**
 * Read a cached extracted_data column back into a usable field map.
 *
 * Tolerant by design: the column arrives as an object from mysql2, as a JSON
 * string (MariaDB JSON is LONGTEXT under the hood), or as NULL on a row that
 * predates the migration or whose extraction did not succeed. Only a genuinely
 * non-empty field map is returned — everything else is null, which the match
 * engine reads as "compare the files live instead".
 */
export function parseExtractedData(raw) {
  if (!raw) return null;

  let payload = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try {
      payload = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  if (!payload || typeof payload !== "object") return null;

  const fields = payload.fields;
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return null;
  if (!Object.keys(fields).length) return null;

  return {
    documentType: payload.document_type_label || payload.document_type || null,
    canonicalDocumentType: payload.document_type || null,
    fields,
  };
}
