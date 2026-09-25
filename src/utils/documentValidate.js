import ApiError from "./ApiError.js";
import { validate, DocumentServiceError } from "../services/documentService.js";

/**
 * Fail-safe corrupt-file guard for upload paths.
 *
 * Wraps the Python document service /validate call and maps a definite
 * corruption verdict onto a 400 that blocks the upload:
 *
 *   - valid:false  -> throws ApiError(400, "File is corrupt or invalid")
 *
 * Transport failures FAIL OPEN only when the service is genuinely unreachable
 * (DocumentServiceError kind "timeout" or "connection"): the upload proceeds
 * and a warning is logged, so a healthy user flow is never blocked by an
 * unhealthy validation dependency.
 *
 * Every OTHER failure kind fails CLOSED so an unvalidated file is never
 * silently accepted — the service responded but with a 4xx/5xx (kind "http"),
 * a malformed/unexpected payload (kind "generic"), or any unexpected local
 * error. Those reject the upload with a clear 400 message.
 *
 * @returns {Promise<object|null>} the /validate data ({valid, reason,
 *   file_type}) on success, or null when fail-opened. Never resolves to a
 *   value meaning "corrupt" or "unvalidated": on a definite corruption verdict
 *   or an unexpected validating failure we throw.
 */
export async function assertDocumentValid(filePath) {
  try {
    const { success, data } = await validate(filePath);
    if (success && data?.valid === false) {
      throw new ApiError(400, "File is corrupt or invalid");
    }
    return data ?? { valid: true };
  } catch (error) {
    if (error instanceof ApiError && !(error instanceof DocumentServiceError)) {
      throw error;
    }

    const { kind } = error ?? {};
    if (kind === "timeout" || kind === "connection") {
      console.warn(
        `[documentValidate] Document validation unavailable (kind=${kind}), failing open for ${filePath}: ${error.message}`
      );
      return null;
    }

    console.error(
      `[documentValidate] Document validation failed closed (kind=${kind || "unknown"}) for ${filePath}: ${error.message}`
    );
    throw new ApiError(400, "Document could not be validated — please try again.");
  }
}