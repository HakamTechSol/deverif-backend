import ApiError from "./ApiError.js";
import { validate } from "../services/documentService.js";

/**
 * Fail-safe corrupt-file guard for upload paths.
 *
 * Wraps the Python document service /validate call and maps a definite
 * corruption verdict onto a 400 that blocks the upload:
 *
 *   - valid:false  -> throws ApiError(400, "File is corrupt or invalid")
 *
 * Transport failures (service down, timeout, HTTP error) FAIL OPEN: the
 * upload proceeds and the problem is logged, so a healthy user flow is
 * never blocked by an unhealthy validation dependency. DocumentServiceError
 * (the client's own transport error class) is recognized by name so this
 * util never masks a genuine 400 the service intentionally returns.
 *
 * @returns {Promise<object|null>} the /validate data ({valid, reason,
 *   file_type}) on success, or null when fail-opened. Never resolves to a
 *   value meaning "corrupt": on a definite corruption verdict we throw.
 */
export async function assertDocumentValid(filePath) {
  try {
    const { success, data } = await validate(filePath);
    if (success && data?.valid === false) {
      throw new ApiError(400, "File is corrupt or invalid");
    }
    return data ?? { valid: true };
  } catch (error) {
    if (error instanceof ApiError && error.name !== "DocumentServiceError") {
      throw error;
    }
    console.warn(
      `[documentValidate] Document validation unavailable (kind=${error?.kind || "unknown"}), failing open for ${filePath}: ${error.message}`
    );
    return null;
  }
}