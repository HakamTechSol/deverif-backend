import path from "path";
import fs from "fs";

import { pool } from "../config/db.js";
import { DOCS_DIR } from "../config/uploadPaths.js";
import { ocrExtract, DocumentServiceError } from "../services/documentService.js";
import { hashCnic } from "./personCrypto.js";

/**
 * Internal-consistency cross-check between the form-entered identity fields
 * (document_owner_name + linked persons.cnic_hash) and the identity fields
 * actually OCR'd off the submitted document.
 *
 * This is an additional DATA-QUALITY signal — never a blocker, and never part
 * of the auto-match decision. It runs once at approval time, caches
 * document_extracted_name / document_extracted_cnic_hash on the person_documents
 * row, and records a matched/mismatched flag so a future NADRA bulk-verification
 * script can re-verify WITHOUT re-running OCR.
 *
 * The typed `document_owner_name` is an unverified human claim and is treated as
 * one: it is used here only to report whether the document agrees with the form,
 * and it is compared FUZZILY (>= 88% after normalization), never by string
 * equality. The auto-verify decision itself is made solely on OCR-vs-OCR
 * canonical fields (see utils/autoMatch.js), so a typo on the form can neither
 * cause nor prevent an automatic outcome.
 *
 * It deliberately does NOT touch persons.is_nadra_verified (that stays 'no'
 * until real NADRA integration exists).
 */

const NAME_MATCH_THRESHOLD = 88;

/** Length of the longest common subsequence (bottom-up, O(n*m)). */
function lcsLength(a, b) {
  let prev = new Array(b.length + 1).fill(0);
  let curr = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(curr[j - 1], prev[j]);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[b.length];
}

/**
 * Port of the document service's name similarity — rapidfuzz fuzz.ratio is a
 * normalized Indel distance (substitutions count as 2 edits):
 *   100 * (1 - indel_distance / (len_a + len_b))
 *       indel = len_a + len_b - 2 * lcs
 * Case + whitespace normalized before comparing so the 3-way form/document
 * check uses the same >=88% semantics as document-vs-document matching.
 *
 * Punctuation is turned into a space (not removed) because this is a free-text
 * field: "Muhammad, Ali" and "Muhammad Ali" must converge, while gluing the
 * words together would invent a token nothing else produces. Exact fields such
 * as the CNIC instead have punctuation REMOVED; that asymmetry lives in the
 * document service's match_service._norm_exact / _norm_text pair.
 */
export function normalizeNameForMatch(value) {
  return String(value ?? "")
    .toUpperCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function nameSimilarityRatio(a, b) {
  const sa = normalizeNameForMatch(a);
  const sb = normalizeNameForMatch(b);
  if (!sa.length && !sb.length) return 100;
  if (!sa.length || !sb.length) return 0;
  const lcs = lcsLength(sa, sb);
  const indel = sa.length + sb.length - 2 * lcs;
  return 100 - (100 * indel) / (sa.length + sb.length);
}

/**
 * Run the cross-check for a request that is being approved.
 *
 * Returns null when the request has no linked person (recordPersonDocument
 * will skip such requests anyway). Otherwise returns
 *   { extractedName, extractedCnicHash, matchStatus, reason }
 * with matchStatus:
 *   matched     -> BOTH checks passed (CNIC hash exact + name >= 88%)
 *   mismatched  -> at least one check was performed and FAILED
 *   not_checked -> a check could not be performed (service down/timeout, file
 *                  missing, or the document had no extractable fields)
 *
 * Never throws — every failure path is caught and converted into a
 * 'not_checked' result with a logged reason, so the approval always succeeds.
 */
export async function buildDocumentCrossCheck(vr) {
  if (!vr?.linked_person_id) return null;

  const result = () => ({
    extractedName: null,
    extractedCnicHash: null,
    matchStatus: "not_checked",
    reason: "",
  });

  const submittedPath = path.join(DOCS_DIR, path.basename(vr.document_path || ""));
  if (!fs.existsSync(submittedPath)) {
    const r = result();
    r.reason = "Document file not found on disk — OCR skipped";
    console.warn(`[cross-check] request ${vr.uuid}: ${r.reason}`);
    return r;
  }

  let extracted;
  try {
    const { data } = await ocrExtract(submittedPath, vr.document_type);
    extracted = data || {};
  } catch (e) {
    const r = result();
    r.reason = e instanceof DocumentServiceError
      ? `Document service unavailable (${e.kind || "service"}): ${e.message}`
      : `Document consistency check failed: ${e.message || e}`;
    console.warn(`[cross-check] request ${vr.uuid}: ${r.reason}`);
    return r;
  }

  const [personRows] = await pool.query(
    "SELECT cnic_hash FROM persons WHERE id=?",
    [vr.linked_person_id]
  );
  const formCnicHash = personRows.length ? personRows[0].cnic_hash : null;

  const ocrFields = (extracted && typeof extracted === "object" && extracted.fields) || {};
  const ocrName = typeof ocrFields.name?.value === "string" ? ocrFields.name.value.trim() : "";
  const ocrCnic = typeof ocrFields.cnic?.value === "string" ? ocrFields.cnic.value.trim() : "";
  const formName = typeof vr.document_owner_name === "string" ? vr.document_owner_name.trim() : "";

  const extractedCnicHash = ocrCnic ? hashCnic(ocrCnic) : null;

  const reasons = [];
  let anyFail = false;
  let allPass = true;
  let comparable = 0;

  if (extractedCnicHash && formCnicHash) {
    comparable++;
    if (extractedCnicHash === formCnicHash) {
      reasons.push("CNIC matches");
    } else {
      anyFail = true;
      allPass = false;
      reasons.push("CNIC differs from the form-entered CNIC");
    }
  } else if (!formCnicHash) {
    allPass = false;
    reasons.push("CNIC could not be checked (no linked form CNIC hash)");
  } else {
    allPass = false;
    reasons.push("CNIC could not be extracted from the document");
  }

  if (ocrName && formName) {
    comparable++;
    const ratio = nameSimilarityRatio(ocrName, formName);
    if (ratio >= NAME_MATCH_THRESHOLD) {
      reasons.push(`Name matches (${Math.round(ratio)}%)`);
    } else {
      anyFail = true;
      allPass = false;
      reasons.push(`Name differs from the form-entered name (${Math.round(ratio)}%)`);
    }
  } else if (!formName) {
    allPass = false;
    reasons.push("Name could not be checked (no form-entered name)");
  } else {
    allPass = false;
    reasons.push("Name could not be extracted from the document");
  }

  const matchStatus = anyFail
    ? "mismatched"
    : comparable > 0 && allPass
      ? "matched"
      : "not_checked";

  const r = {
    extractedName: ocrName || null,
    extractedCnicHash,
    matchStatus,
    reason: reasons.join("; ") || "No identity fields could be extracted from the document",
  };

  console.log(`[cross-check] request ${vr.uuid}: match_status=${matchStatus} (${reasons.join("; ")})`);
  return r;
}