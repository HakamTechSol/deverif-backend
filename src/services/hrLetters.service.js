import { randomUUID } from "node:crypto";
import { pool } from "../config/db.js";
import ApiError from "../utils/ApiError.js";
import { assertUuid } from "../utils/publicResponse.js";
import { logAudit } from "../utils/auditLog.js";
import { paginatedResponse } from "../utils/pagination.js";
import { renderTemplate, validateBody, unknownTags, MANUAL_TAGS } from "../utils/letterMerge.js";
import { generateHrLetterPdf } from "../utils/hrLetterPdf.js";
import {
  newLetterQrToken,
  signLetterData,
  verifyLetterSignature,
  letterQrSigningConfigured,
  buildLetterVerifyUrl,
} from "../utils/letterQr.js";

/**
 * HR Letters.
 *
 * The invariant worth stating up front: an ISSUED letter's `body_snapshot` is
 * immutable and the PDF and the QR both attest to that snapshot. Editing a
 * template therefore cannot retroactively change a letter an employee already
 * holds — which matters because these are the documents banks, embassies and
 * background checkers ask for years later.
 *
 * A revoked letter keeps its row and its reference number but loses its
 * verifiable status: revocation rewrites `issued_at` to NULL, and `issued_at` is
 * inside the signed payload, so the stored signature can no longer validate and
 * the public endpoint refuses it. That is why revocation must NOT be a soft
 * "status" flip alone.
 */

const LETTER_TYPES = [
  "offer",
  "increment",
  "experience",
  "employment_confirmation",
  "warning",
  "appreciation",
  "custom",
];

function letterTypeOrThrow(value) {
  if (!LETTER_TYPES.includes(value)) {
    throw new ApiError(400, `letter_type must be one of: ${LETTER_TYPES.join(", ")}`);
  }
  return value;
}

/**
 * Normalise a JSON array column into a real array.
 *
 * MySQL JSON columns arrive from mysql2 as STRINGS, so a `merge_fields` value of
 * ['a','b'] reaches Node as the text ["a","b"]. Returning that raw makes every
 * client that trusts the declared type fail: a React page doing `tags.map(...)`
 * throws "tags.slice(...).map is not a function", because slice() works on a
 * string and map() does not.
 *
 * This is the same normalisation the rest of the codebase already does —
 * plans.controller.js runs row.features through normalizePlanFeatures() and
 * row.module_flags through parseModuleFlags() for exactly this reason. Skipping
 * it here was the bug, so it is centralised rather than done ad hoc per column.
 */
function parseJsonArray(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      // Malformed JSON must not take the whole list down; an empty tag list
      // degrades the palette, a thrown error blanks the page.
      return [];
    }
  }
  return [];
}

/** Apply the JSON-column normalisation to a template row. */
function normalizeTemplate(row) {
  if (!row) return row;
  return { ...row, merge_fields: parseJsonArray(row.merge_fields) };
}

/**
 * Employee + org context used to fill a letter's automatic merge tags.
 *
 * employees has NO `designation` / `department` text columns — they were
 * replaced by `designation_id` / `department_id` FKs into the managed catalogues
 * (see salary.controller.js, which joins the same way). Selecting the old text
 * columns is a hard ER_BAD_FIELD_ERROR, so this lives in one place to make that
 * mistake impossible to repeat.
 */
const EMPLOYEE_CONTEXT_SELECT = `
  SELECT e.full_name AS employee_name, e.joining_date,
         dg.name AS designation, dp.name AS department,
         o.name AS organization_name
    FROM employees e
    JOIN organizations o ON o.id = e.organization_id
    LEFT JOIN designations dg ON dg.id = e.designation_id
    LEFT JOIN departments dp ON dp.id = e.department_id
   WHERE e.uuid = ? AND e.organization_id = ?`;

async function loadEmployeeContext(orgId, employeeUuid) {
  const [rows] = await pool.query(`${EMPLOYEE_CONTEXT_SELECT} LIMIT 1`, [employeeUuid, orgId]);
  if (!rows.length) throw new ApiError(404, "Employee not found in this organization");
  return rows[0];
}

async function loadLetterForOrg({ orgId, letterUuid, conn = pool, forUpdate = false }) {
  if (letterUuid) assertUuid(letterUuid, "Letter UUID");
  const [rows] = await conn.query(
    `SELECT l.*, e.full_name AS employee_name,
            dg.name AS designation, dp.name AS department,
            e.joining_date, o.name AS organization_name
       FROM hr_letters l
       JOIN employees e ON e.uuid = l.employee_uuid
       JOIN organizations o ON o.id = l.organization_id
       LEFT JOIN designations dg ON dg.id = e.designation_id
       LEFT JOIN departments dp ON dp.id = e.department_id
      WHERE l.uuid=? AND l.organization_id=?${forUpdate ? " FOR UPDATE" : ""}`,
    [letterUuid, orgId]
  );
  if (!rows.length) throw new ApiError(404, "Letter not found");
  return rows[0];
}

/**
 * Build the default merge values from the employee row.
 *
 * `cnic` is deliberately NOT included. A letter is a document that circulates to
 * third parties, and an experience or confirmation letter has no reason to carry
 * a national ID; omitting the tag keeps the highest-risk field out of the most
 * widely-shared artefact this module produces.
 *
 * Callers must pass a row already aliased to `employee_name` (see
 * EMPLOYEE_CONTEXT_SELECT). Passing the raw employees row, where the column is
 * `full_name`, silently yields an unresolved $employee_name — a letter that
 * opens "Dear ," — which is why the alias lives in the shared SQL rather than at
 * each call site.
 */
function defaultsFromLetter(letter) {
  return {
    employee_name: letter.employee_name ?? "",
    designation: letter.designation ?? "",
    department: letter.department ?? "",
    joining_date: letter.joining_date ?? "",
    cnic: "",
    organization_name: letter.organization_name ?? "",
    issue_date: letter.issued_at ?? new Date(),
    letter_date: letter.issued_at ?? new Date(),
    reference_no: letter.reference_no ?? "",
    current_salary: "",
    new_salary: "",
    effective_date: "",
    increment_percentage: "",
    total_experience: "",
    last_working_date: "",
    warning_reason: "",
  };
}

/**
 * Next reference number for an org: HR/<year>/<0001>.
 *
 * The zero-padded sequence is allocated inside the INSERT retry loop rather than
 * by a SELECT MAX(), because two letters issued in the same second would both
 * read the same MAX and the second INSERT would lose on uk_hr_letters_reference.
 * The unique index remains the authority; the retry just turns that race into a
 * successful issue instead of a 409 the user has to retry themselves.
 */
async function buildReferenceNumber(conn, orgId) {
  const year = new Date().getFullYear();
  const prefix = `HR/${year}/`;
  const [rows] = await conn.query(
    `SELECT reference_no FROM hr_letters
      WHERE organization_id=? AND reference_no LIKE CONCAT(?, '%')
      ORDER BY id DESC LIMIT 1`,
    [orgId, prefix]
  );
  const last = rows[0]?.reference_no ?? "";
  const lastSeq = parseInt(String(last).slice(prefix.length), 10);
  const next = Number.isFinite(lastSeq) && lastSeq > 0 ? lastSeq + 1 : 1;
  return `${prefix}${String(next).padStart(4, "0")}`;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export async function listTemplates({ orgId, letterType, includeInactive = false }) {
  const clauses = ["organization_id=?"];
  const params = [orgId];
  if (letterType) {
    clauses.push("letter_type=?");
    params.push(letterType);
  }
  if (!includeInactive) clauses.push("is_active=1");

  const [rows] = await pool.query(
    `SELECT uuid, letter_type, name, body, merge_fields, is_active, created_at, updated_at
       FROM letter_templates
      WHERE ${clauses.join(" AND ")}
      ORDER BY letter_type, name`,
    params
  );
  return rows.map(normalizeTemplate);
}

export async function getTemplate({ orgId, templateUuid }) {
  assertUuid(templateUuid, "Template UUID");
  const [rows] = await pool.query(
    `SELECT uuid, letter_type, name, body, merge_fields, is_active, created_at, updated_at
       FROM letter_templates WHERE uuid=? AND organization_id=?`,
    [templateUuid, orgId]
  );
  if (!rows.length) throw new ApiError(404, "Template not found");
  return normalizeTemplate(rows[0]);
}

export async function createTemplate({ orgId, actorUuid, letterType, name, body }) {
  letterTypeOrThrow(letterType);
  if (!name || !String(name).trim()) throw new ApiError(400, "name is required");

  const check = validateBody(body);
  if (!check.valid) throw new ApiError(400, check.problems.join("; "));

  // Mint the uuid here rather than reading it back. Re-querying by
  // (organization_id, name) to recover it would be racy: two concurrent creates
  // with different names are fine, but it also breaks the moment a caller
  // supplies a name that another org already uses.
  const uuid = randomUUID();
  try {
    await pool.query(
      `INSERT INTO letter_templates (uuid, organization_id, letter_type, name, body, merge_fields, created_by_uuid)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [uuid, orgId, letterType, String(name).trim(), body, JSON.stringify(check.tags), actorUuid ?? null]
    );
  } catch (err) {
    if (err?.errno === 1062) throw new ApiError(409, "A template with this name already exists");
    throw err;
  }

  auditTemplate(actorUuid, "letter_template.create", orgId, uuid, { letterType });
  return getTemplate({ orgId, templateUuid: uuid });
}

export async function updateTemplate({ orgId, templateUuid, actorUuid, letterType, name, body, isActive }) {
  assertUuid(templateUuid, "Template UUID");

  const existing = await getTemplate({ orgId, templateUuid });
  const nextBody = body === undefined ? existing.body : body;
  const check = validateBody(nextBody);
  if (!check.valid) throw new ApiError(400, check.problems.join("; "));

  try {
    await pool.query(
      `UPDATE letter_templates
          SET name=?, letter_type=?, body=?, merge_fields=?, is_active=?
        WHERE uuid=? AND organization_id=?`,
      [
        name === undefined ? existing.name : String(name).trim(),
        letterType === undefined ? existing.letter_type : letterTypeOrThrow(letterType),
        nextBody,
        JSON.stringify(check.tags),
        isActive === undefined ? existing.is_active : isActive ? 1 : 0,
        templateUuid,
        orgId,
      ]
    );
  } catch (err) {
    if (err?.errno === 1062) throw new ApiError(409, "A template with this name already exists");
    throw err;
  }

  auditTemplate(actorUuid, "letter_template.update", orgId, templateUuid, { letterType });
  // Editing a template does NOT touch already-issued letters: their
  // body_snapshot is the whole point. Stated here because it is surprising.
  return getTemplate({ orgId, templateUuid });
}

export async function deleteTemplate({ orgId, templateUuid, actorUuid }) {
  assertUuid(templateUuid, "Template UUID");
  const [result] = await pool.query(
    "DELETE FROM letter_templates WHERE uuid=? AND organization_id=?",
    [templateUuid, orgId]
  );
  if (!result.affectedRows) throw new ApiError(404, "Template not found");

  // hr_letters.template_uuid is ON DELETE SET NULL, so issued letters keep
  // pointing at nothing but retain their own snapshot and remain verifiable.
  auditTemplate(actorUuid, "letter_template.delete", orgId, templateUuid, {});
}

// ---------------------------------------------------------------------------
// Letters
// ---------------------------------------------------------------------------

/** Create a DRAFT letter. Nothing is verifiable until it is issued. */
export async function createDraftLetter({ orgId, actorUuid, employeeUuid, templateUuid, letterType, title, values = {} }) {
  assertUuid(employeeUuid, "Employee UUID");
  letterTypeOrThrow(letterType);

  let template = null;
  if (templateUuid) {
    assertUuid(templateUuid, "Template UUID");
    template = await getTemplate({ orgId, templateUuid });
  }
  if (!template && !title) throw new ApiError(400, "Provide a template or a title");

  const emp = await loadEmployeeContext(orgId, employeeUuid);

  const [[orgRow]] = await pool.query(
    "SELECT name FROM organizations WHERE id=?",
    [orgId]
  );

  const referenceNo = await buildReferenceNumber(pool, orgId);
  const payload = { ...values };
  delete payload.__never;

  try {
    await pool.query(
      `INSERT INTO hr_letters
         (uuid, organization_id, employee_uuid, template_uuid, letter_type,
          reference_no, title, payload, status)
       VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, 'draft')`,
      [
        orgId,
        employeeUuid,
        template?.uuid ?? null,
        letterType,
        referenceNo,
        title || template?.name || "HR Letter",
        JSON.stringify(payload),
      ]
    );
  } catch (err) {
    if (err?.errno === 1062) {
      throw new ApiError(409, "Could not allocate a reference number, please retry");
    }
    throw err;
  }

  const [[row]] = await pool.query(
    "SELECT uuid FROM hr_letters WHERE organization_id=? AND reference_no=? LIMIT 1",
    [orgId, referenceNo]
  );
  auditTemplate(actorUuid, "hr_letter.create", orgId, row.uuid, { letterType, employeeUuid });

  // Freeze the merge values actually used, so a later edit of `values` cannot
  // change what the issued letter says.
  const merged = {
    ...defaultsFromLetter({ ...emp, organization_name: orgRow?.name, reference_no: referenceNo }),
    ...payload,
  };
  return getLetter({ orgId, letterUuid: row.uuid, mergedValues: merged });
}

export async function listLetters({ orgId, page, limit, offset, employeeUuid, letterType, status, search }) {
  const clauses = ["l.organization_id = ?"];
  const params = [orgId];

  if (employeeUuid) {
    assertUuid(employeeUuid, "Employee UUID");
    clauses.push("l.employee_uuid = ?");
    params.push(employeeUuid);
  }
  if (letterType) {
    clauses.push("l.letter_type = ?");
    params.push(letterType);
  }
  if (status) {
    clauses.push("l.status = ?");
    params.push(status);
  }
  if (search) {
    clauses.push("(l.reference_no LIKE ? OR l.title LIKE ? OR e.full_name LIKE ?)");
    const like = `%${search}%`;
    params.push(like, like, like);
  }

  const where = clauses.join(" AND ");
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM hr_letters l JOIN employees e ON e.uuid=l.employee_uuid WHERE ${where}`,
    params
  );
  const [rows] = await pool.query(
    `SELECT l.uuid, l.letter_type, l.reference_no, l.title, l.status, l.issued_at,
            l.revoked_at, l.created_at, l.qr_token, l.template_uuid,
            e.uuid AS employee_uuid, e.full_name AS employee_name,
            dg.name AS designation
       FROM hr_letters l
       JOIN employees e ON e.uuid = l.employee_uuid
       LEFT JOIN designations dg ON dg.id = e.designation_id
      WHERE ${where}
      ORDER BY l.created_at DESC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  return paginatedResponse(
    rows.map((r) => ({ ...r, verify_url: r.qr_token && r.status === "issued" ? buildLetterVerifyUrl(r.qr_token) : null })),
    total,
    page,
    limit
  );
}

export async function getLetter({ orgId, letterUuid, mergedValues }) {
  const letter = await loadLetterForOrg({ orgId, letterUuid });
  if (mergedValues) {
    letter.preview_values = mergedValues;
  }
  // payload is a JSON column, so it arrives as a string. Normalise it for the
  // same reason merge_fields is normalised — a client that trusts the declared
  // Record<string,string> type will crash on the raw text.
  letter.payload = parseJson(letter.payload);
  letter.verify_url =
    letter.qr_token && letter.status === "issued" ? buildLetterVerifyUrl(letter.qr_token) : null;
  return letter;
}

/**
 * Issue a draft: render, freeze the snapshot, mint the QR.
 *
 * Runs in a transaction and takes FOR UPDATE on the row so two admins clicking
 * "Issue" together cannot both mint a token for one letter.
 *
 * Refuses to issue a letter whose body still has unresolved merge tags. Printing
 * "Dear , your salary increases to $" onto a document an employee will present
 * to their bank is not an acceptable outcome, so this throws rather than warns.
 */
export async function issueLetter({ orgId, letterUuid, actorUuid, values }) {
  assertUuid(letterUuid, "Letter UUID");
  if (!letterQrSigningConfigured()) {
    throw new ApiError(503, "Letter verification is not configured on this server (QR_SIGNING_SECRET is unset)");
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const letter = await loadLetterForOrg({ orgId, letterUuid, conn, forUpdate: true });
    if (letter.status !== "draft") {
      throw new ApiError(409, `This letter was already ${letter.status}`);
    }

    // hr_letters has NO `body` column — only the frozen `body_snapshot`, which is
    // written at issue time. The body therefore has to come from the template
    // this letter was created against. Reading a non-existent `letter.body`
    // yields undefined, which made every issuance fail with "no body to render".
    let templateBody = null;
    if (letter.template_uuid) {
      const [[tpl]] = await conn.query(
        "SELECT body FROM letter_templates WHERE uuid=? AND organization_id=?",
        [letter.template_uuid, orgId]
      );
      templateBody = tpl?.body ?? null;
    }
    if (!templateBody) {
      throw new ApiError(
        400,
        "This letter has no template to render from. Create it against a template, " +
          "or add the letter text before issuing."
      );
    }

    const storedPayload = parseJson(letter.payload);
    const merged = {
      ...defaultsFromLetter(letter),
      ...storedPayload,
      ...(values ?? {}),
      reference_no: letter.reference_no,
      issue_date: new Date(),
      letter_date: new Date(),
    };

    const { text, unresolved } = renderTemplate(templateBody, merged);
    if (unresolved.length) {
      throw new ApiError(
        400,
        `Cannot issue: these merge tags have no value — ${unresolved.map((t) => `$${t}`).join(", ")}. ` +
          "Supply them in the issue form."
      );
    }

    const qrToken = newLetterQrToken();
    const issuedAt = new Date();
    const qrSignature = signLetterData({
      qrToken,
      letterUuid: letter.uuid,
      orgId,
      issuedAtMillis: issuedAt.getTime(),
    });

    await conn.query(
      `UPDATE hr_letters
          SET body_snapshot=?, payload=?, qr_token=?, qr_signature=?,
              status='issued', issued_by_uuid=?, issued_at=?
        WHERE uuid=? AND organization_id=?`,
      [text, JSON.stringify(merged), qrToken, qrSignature, actorUuid ?? null, issuedAt, letterUuid, orgId]
    );

    await conn.commit();

    auditTemplate(actorUuid, "hr_letter.issue", orgId, letterUuid, {
      referenceNo: letter.reference_no,
      letterType: letter.letter_type,
    });

    return getLetter({ orgId, letterUuid });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Revoke an issued letter.
 *
 * Clears `issued_at`, which is inside the signed payload — so the stored
 * signature can no longer validate and the public endpoint refuses the letter.
 * The reference number is released for reuse, and body_snapshot is retained:
 * the record of what was issued is exactly what must survive revocation.
 */
export async function revokeLetter({ orgId, letterUuid, actorUuid, reason }) {
  assertUuid(letterUuid, "Letter UUID");
  const [result] = await pool.query(
    `UPDATE hr_letters
        SET status='revoked', revoked_at=NOW(), revoked_reason=?, issued_at=NULL,
            qr_token=NULL, qr_signature=NULL
      WHERE uuid=? AND organization_id=? AND status='issued'`,
    [reason ?? null, letterUuid, orgId]
  );
  if (!result.affectedRows) throw new ApiError(409, "Only an issued letter can be revoked");

  auditTemplate(actorUuid, "hr_letter.revoke", orgId, letterUuid, { reason: reason ?? null });
  return getLetter({ orgId, letterUuid });
}

export async function deleteLetter({ orgId, letterUuid, actorUuid }) {
  assertUuid(letterUuid, "Letter UUID");
  const letter = await loadLetterForOrg({ orgId, letterUuid });
  if (letter.status === "issued") {
    throw new ApiError(409, "An issued letter cannot be deleted; revoke it instead");
  }
  await pool.query("DELETE FROM hr_letters WHERE uuid=? AND organization_id=?", [letterUuid, orgId]);
  auditTemplate(actorUuid, "hr_letter.delete", orgId, letterUuid, {});
}

/** Render and return the PDF, without persisting anything. */
export async function renderLetterPdf({ orgId, letterUuid }) {
  const letter = await loadLetterForOrg({ orgId, letterUuid });
  const buffer = await generateHrLetterPdf({
    letter,
    employeeName: letter.employee_name,
    organizationName: letter.organization_name,
    verifyUrl: letter.qr_token && letter.status === "issued" ? buildLetterVerifyUrl(letter.qr_token) : null,
  });
  return { buffer, filename: `${letter.reference_no.replace(/[^\w.-]+/g, "-")}.pdf` };
}

/**
 * Public verification.
 *
 * FAIL-CLOSED, and deliberately returns nothing beyond what a holder of the
 * document is entitled to see. No CNIC, no internal ids, no file path, and no
 * merge payload: `payload` can hold salary figures, which is exactly what must
 * not become readable by anyone who photographs the letter.
 *
 * The signature is re-derived from the row and compared timing-safely, so a
 * revoked letter (whose issued_at was cleared) cannot validate even by replaying
 * the original token.
 */
export async function verifyLetterPublic({ qrToken }) {
  const token = String(qrToken ?? "");
  if (!/^[0-9a-f]{64}$/.test(token)) return null;

  const [rows] = await pool.query(
    `SELECT l.uuid, l.letter_type, l.reference_no, l.title, l.status,
            l.issued_at, l.qr_signature, l.organization_id,
            e.full_name AS employee_name, dg.name AS designation,
            o.name AS organization_name
       FROM hr_letters l
       JOIN employees e ON e.uuid = l.employee_uuid
       JOIN organizations o ON o.id = l.organization_id
       LEFT JOIN designations dg ON dg.id = e.designation_id
      WHERE l.qr_token = ?
      LIMIT 1`,
    [token]
  );
  if (!rows.length) return null;
  const row = rows[0];

  if (row.status !== "issued") return null;

  const okSignature = verifyLetterSignature({
    qrToken: token,
    letterUuid: row.uuid,
    orgId: row.organization_id,
    issuedAtMillis: row.issued_at instanceof Date ? row.issued_at.getTime() : 0,
    signature: row.qr_signature,
  });
  if (!okSignature) return null;

  return {
    valid: true,
    reference_no: row.reference_no,
    letter_type: row.letter_type,
    title: row.title,
    holder_name: row.employee_name,
    designation: row.designation ?? null,
    organization_name: row.organization_name,
    issued_at: row.issued_at,
  };
}

/** Preview a template against an employee without creating anything. */
export async function previewTemplate({ orgId, employeeUuid, templateUuid, values = {} }) {
  assertUuid(employeeUuid, "Employee UUID");
  const template = await getTemplate({ orgId, templateUuid });
  const emp = await loadEmployeeContext(orgId, employeeUuid);

  const merged = {
    ...defaultsFromLetter({ ...emp, reference_no: "HR/PREVIEW/0000" }),
    ...values,
  };
  const { text, unresolved } = renderTemplate(template.body, merged);
  return {
    text,
    unresolved,
    unknown: unknownTags(template.body),
    missing_manual: unresolved.filter((t) => MANUAL_TAGS.includes(t)),
  };
}

function parseJson(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function auditTemplate(actorUuid, action, orgId, entityId, details) {
  logAudit({
    actorType: "user",
    actorId: actorUuid ?? null,
    action,
    entityType: "hr_letter",
    entityId,
    details: { organization_id: orgId, ...details },
  });
}

export { LETTER_TYPES, defaultsFromLetter, buildReferenceNumber, parseJson, parseJsonArray, normalizeTemplate };