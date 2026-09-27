import ApiError from "./ApiError.js";
import { validate, DocumentServiceError } from "../services/documentService.js";

/** Persisted document_validation_status values (see the migration). */
export const VALIDATION_PASSED = "passed";
export const VALIDATION_FLAGGED = "flagged";
export const VALIDATION_UNVALIDATED = "unvalidated";

/**
 * Message stored on a flagged request when the service flagged it without
 * saying why. A reviewer seeing a badge with no explanation is worse off than
 * one seeing a vague one.
 */
const HEURISTIC_FALLBACK_REASON =
  "An automated check flagged this document as possibly incomplete or hard to read. Please review the file directly.";

/**
 * Document validation guard for upload paths, with TWO tiers of verdict.
 *
 * Tiering is layered on top of — not instead of — the fail-open/fail-closed
 * split for service errors. That earlier split decides what happens when the
 * service does not respond properly at all (timeout / unreachable fails open so
 * a healthy upload flow is never blocked by a sick dependency; an HTTP error,
 * a malformed payload, or any unexpected local failure fails closed so an
 * unvalidated file is never silently accepted).
 *
 * This function decides what happens when the service DOES respond, and the
 * response says which tier spoke:
 *
 *   check_type "structural" + valid:false -> HARD BLOCK, 400, no request row.
 *       A hard fact about the bytes: a parser refuses the file, it is empty or
 *       truncated, or the declared extension/mimetype contradicts the sniffed
 *       content. The MIME-spoofing case lives here and is a security control,
 *       so it is never softened into a flag.
 *
 *   check_type "heuristic" + valid:false -> SOFT FLAG, the request is created.
 *       A subjective quality judgement: crop detection (edge-ink density) or the
 *       darkness / low-contrast readability check. These are tuning-sensitive
 *       and DO misfire — on a dark photo of a black-background ID card, on a
 *       page that legitimately fills the frame, on a document photographed on a
 *       dark desk. Blocking those punishes an honest submitter over a threshold
 *       someone else tuned, so the request is created, the reason is stored on
 *       the row, and the reviewing organization is shown a warning to open the
 *       file itself.
 *
 *   valid:true (either tier) -> passed, proceed normally.
 *
 * A structural failure ALWAYS wins: it is checked first and throws regardless
 * of anything else, so no flag can ever launder a broken or spoofed file into a
 * request.
 *
 * @param {string} filePath
 * @param {{treatHeuristicAsFatal?: boolean}} [options] set
 *   `treatHeuristicAsFatal` for upload paths where a quality signal IS
 *   disqualifying — see the reference-document note on the option itself.
 * @returns {Promise<{status: string, reason: string|null, checkType: string|null,
 *   data: object|null}>} `status` is one of VALIDATION_PASSED /
 *   VALIDATION_FLAGGED / VALIDATION_UNVALIDATED. Throws ApiError(400) only for
 *   a structural failure, a fail-closed service error, or a heuristic failure
 *   when `treatHeuristicAsFatal` is set.
 */
export async function assertDocumentValid(filePath, { treatHeuristicAsFatal = false } = {}) {
  try {
    const { success, data } = await validate(filePath);

    if (!success) {
      // validate() is expected to throw DocumentServiceError on an unsuccessful
      // envelope; if one ever slips through, treat it as a closed service.
      throw new ApiError(400, "Document could not be validated — please try again.");
    }

    // `check_type` arrived with the tiering change. While an older service is
    // still deployed it is absent, and that service can only signal a quality
    // problem the way it always did: valid:true together with cropped:true.
    // Deriving the tier from that keeps the warning working across a rolling
    // deploy instead of silently dropping it — and, just as importantly, keeps
    // the default for a genuinely corrupt file as a hard block.
    const hasTier = typeof data?.check_type === "string";
    const checkType = hasTier
      ? data.check_type
      : data?.cropped === true
        ? "heuristic"
        : "structural";

    // A quality problem is the service saying valid:false from the heuristic
    // tier (new service), or valid:true together with cropped:true (old
    // service). Note this is NOT simply `checkType === "heuristic"`: a payload
    // that says valid:true has told us the file is fine, and an explicit pass
    // is a pass whatever tier it is tagged with.
    const qualityProblem =
      data?.valid === false ? checkType === "heuristic" : data?.cropped === true;

    if (qualityProblem) {
      // Some upload paths cannot afford a "maybe". The employee
      // reference-document pool is the case that matters: a reference scan that
      // is missing part of its own content (a name, an expiry, a signature) does
      // not merely look bad, it becomes the yardstick the 100% auto-verification
      // match compares submissions against — so a false positive there is
      // self-reinforcing and silently corrupts every later match. Such a caller
      // opts in with treatHeuristicAsFatal and gets a 400 like before.
      if (treatHeuristicAsFatal) {
        throw new ApiError(
          400,
          data?.reason ||
            data?.crop_reason ||
            "This document looks incomplete or is hard to read — please upload a complete, clear scan."
        );
      }
      return {
        status: VALIDATION_FLAGGED,
        reason: data?.reason || data?.crop_reason || HEURISTIC_FALLBACK_REASON,
        checkType: checkType === "heuristic" ? checkType : "heuristic",
        data: data ?? null,
      };
    }

    if (data?.valid !== false) {
      return { status: VALIDATION_PASSED, reason: null, checkType, data: data ?? null };
    }

    // Structural + invalid: the file genuinely cannot be trusted. Hard block.
    // Reached only after the heuristic branch, so this is the last word.
    throw new ApiError(400, data?.reason || "File is corrupt or invalid");
  } catch (error) {
    if (error instanceof ApiError && !(error instanceof DocumentServiceError)) {
      throw error;
    }

    const { kind } = error ?? {};

    // Service genuinely unreachable — fail OPEN, but record that the document
    // was never actually checked so nobody mistakes this for a clean pass.
    if (kind === "timeout" || kind === "connection") {
      console.warn(
        `[documentValidate] Document validation unavailable (kind=${kind}), failing open for ${filePath}: ${error.message}`
      );
      return {
        status: VALIDATION_UNVALIDATED,
        reason: null,
        checkType: null,
        data: null,
      };
    }

    // The service responded, but with a 4xx/5xx (kind "http"), a
    // malformed/unexpected payload (kind "generic"), or some other unexpected
    // local failure. Fail CLOSED: an unvalidated file must never be silently
    // accepted.
    console.error(
      `[documentValidate] Document validation failed closed (kind=${kind || "unknown"}) for ${filePath}: ${error.message}`
    );
    throw new ApiError(400, "Document could not be validated — please try again.");
  }
}
