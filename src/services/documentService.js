import fs from "node:fs";
import path from "node:path";

import ApiError from "../utils/ApiError.js";

/**
 * HTTP client for the Python document microservice (see ../../python-backend).
 *
 * Every method sends an 8-second-timeout fetch POST with the X-API-Key header
 * and resolves with the service's {success, data} envelope. Transport failures
 * (timeout, connection refused, non-2xx, bad payload) are never swallowed into
 * a fake "success" result — they surface as DocumentServiceError so the caller
 * can decide how to fail (open/warned vs closed/rejected). The error is also a
 * subclass of ApiError, so the API error middleware handles it with the status
 * code it carries instead of crashing the process.
 */

// Lazy reads (not module-load time): ESM hoists static imports, so a service
// module may be evaluated before server.js / config modules finish loading the
// .env file. Reading process.env per request guarantees the configured values.
const TIMEOUT_MS = 8000;

function baseUrl() {
  return String(process.env.DOC_SERVICE_URL || "http://localhost:5001").replace(/\/+$/, "");
}

function apiKey() {
  return process.env.DOC_SERVICE_API_KEY || "";
}

export class DocumentServiceError extends ApiError {
  constructor(statusCode, message, { kind = "generic", cause = null } = {}) {
    super(statusCode, message);
    this.name = "DocumentServiceError";
    this.kind = kind;
    if (cause) this.cause = cause;
  }
}

async function request(endpoint, fields) {
  const serviceKey = apiKey();
  if (!serviceKey) {
    throw new DocumentServiceError(
      503,
      "Document service is not configured (DOC_SERVICE_API_KEY is missing from the backend .env)"
    );
  }

  const form = new FormData();
  for (const [field, filePath] of Object.entries(fields)) {
    if (!fs.existsSync(filePath)) {
      throw new DocumentServiceError(400, `File not found: ${filePath}`);
    }
    const blob = new Blob([fs.readFileSync(filePath)], { type: "application/octet-stream" });
    form.append(field, blob, path.basename(filePath));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response;
  try {
    response = await fetch(`${baseUrl()}${endpoint}`, {
      method: "POST",
      headers: { "X-API-Key": serviceKey },
      body: form,
      signal: controller.signal,
    });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new DocumentServiceError(
        503,
        `Document service timed out after ${TIMEOUT_MS}ms (${endpoint})`,
        { kind: "timeout", cause: error }
      );
    }
    throw new DocumentServiceError(
      502,
      `Document service unreachable at ${baseUrl()}${endpoint}: ${error.message}`,
      { kind: "connection", cause: error }
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message = payload?.message || `Document service returned HTTP ${response.status}`;
    throw new DocumentServiceError(response.status, message, { kind: "http" });
  }
  if (!payload || payload.success !== true || payload.data === undefined) {
    throw new DocumentServiceError(
      502,
      `Document service returned an unexpected payload${payload?.message ? `: ${payload.message}` : ""}`
    );
  }

  return { success: true, data: payload.data };
}

/** Corrupt-file check. UseResult: callers need data.valid / data.reason. */
export function validate(filePath) {
  return request("/validate", { file: filePath });
}

/** OCR identity extraction. UseResult: data.name, data.cnic (may be null). */
export function ocrExtract(filePath) {
  return request("/ocr/extract", { file: filePath });
}

/** Compare two documents. UseResult: data.match, data.confidence, data.reasons. */
export function match(pathA, pathB) {
  return request("/match", { file_a: pathA, file_b: pathB });
}