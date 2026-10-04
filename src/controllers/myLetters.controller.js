import { pool } from "../config/db.js";
import ApiError from "../utils/ApiError.js";
import { ok } from "../utils/response.js";
import { parsePagination, paginatedResponse } from "../utils/pagination.js";
import { generateHrLetterPdf } from "../utils/hrLetterPdf.js";
import { buildLetterVerifyUrl } from "../utils/letterQr.js";

/**
 * Employee self-service for HR Letters.
 *
 * SCOPE IS THE WHOLE POINT. The requester is derived from the JWT via
 * req.scopeOrgId + the employees row linked to the authenticated user — NEVER
 * from a body or query parameter. There is deliberately no way to ask for
 * someone else's letters: no employee_uuid parameter exists to tamper with.
 * `/org/hr-letters` remains the staff view of the whole organization.
 *
 * Employees see ISSUED letters only. A draft is an unfinished internal document
 * and a revoked one has had its attestation withdrawn, so neither is exposed
 * here — showing a revoked letter as if it were still valid would be actively
 * misleading, and the revocation reason is HR's to handle privately.
 */

/**
 * The employee record for the authenticated platform user, or null.
 *
 * Only `designation_id` exists on `employees`; the designation NAME lives in the
 * `designations` table. Selecting a bare `designation` column here made every
 * /my-letters route fail with ER_BAD_FIELD_ERROR (surfacing as a 500), and the
 * value was never read by any caller anyway.
 */
async function employeeForUser(userUuid, orgId) {
  const [rows] = await pool.query(
    `SELECT uuid, full_name FROM employees
      WHERE organization_id=? AND linked_user_uuid=?`,
    [orgId, userUuid]
  );
  return rows[0] ?? null;
}

export async function listMyLetters(req, res) {
  const employee = await employeeForUser(req.user.uuid, req.scopeOrgId);
  if (!employee) {
    // The user is not on the roster — a sub-admin or an org admin with no
    // employee record. Not an error, just nothing to show.
    return ok(res, paginatedResponse([], 0, 1, 20), "No letters");
  }

  const { page, limit, offset } = parsePagination(req.query);
  const letterType = typeof req.query.letter_type === "string" ? req.query.letter_type : null;

  const clauses = ["l.employee_uuid = ?", "l.status = 'issued'"];
  const params = [employee.uuid];
  if (letterType) {
    clauses.push("l.letter_type = ?");
    params.push(letterType);
  }
  const where = clauses.join(" AND ");

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM hr_letters l WHERE ${where}`,
    params
  );

  const [rows] = await pool.query(
    `SELECT l.uuid, l.letter_type, l.reference_no, l.title, l.status,
            l.issued_at, l.created_at, l.qr_token
       FROM hr_letters l
      WHERE ${where}
      ORDER BY l.issued_at DESC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  return ok(
    res,
    paginatedResponse(
      rows.map((r) => ({
        ...r,
        employee_name: employee.full_name,
        // The public verification link is the whole value of a letter to an
        // employee holding it: a bank or employer can confirm it without the
        // employer having to phone HR.
        verify_url: r.qr_token ? buildLetterVerifyUrl(r.qr_token) : null,
      })),
      total,
      page,
      limit
    ),
    "My letters"
  );
}

export async function getMyLetter(req, res) {
  const employee = await employeeForUser(req.user.uuid, req.scopeOrgId);
  if (!employee) throw new ApiError(404, "Letter not found");

  const [rows] = await pool.query(
    `SELECT l.uuid, l.letter_type, l.reference_no, l.title, l.status,
            l.body_snapshot, l.issued_at, l.qr_token, o.name AS organization_name
       FROM hr_letters l
       JOIN organizations o ON o.id = l.organization_id
      WHERE l.uuid=? AND l.employee_uuid=? AND l.status='issued'`,
    [req.params.uuid, employee.uuid]
  );
  if (!rows.length) throw new ApiError(404, "Letter not found");

  const letter = rows[0];
  return ok(
    res,
    {
      letter: {
        ...letter,
        verify_url: letter.qr_token ? buildLetterVerifyUrl(letter.qr_token) : null,
      },
    },
    "Letter"
  );
}

export async function downloadMyLetterPdf(req, res) {
  const employee = await employeeForUser(req.user.uuid, req.scopeOrgId);
  if (!employee) throw new ApiError(404, "Letter not found");

  const [rows] = await pool.query(
    `SELECT l.uuid, l.letter_type, l.reference_no, l.title, l.status,
            l.body_snapshot, l.issued_at, l.qr_token,
            e.full_name AS employee_name, o.name AS organization_name
       FROM hr_letters l
       JOIN employees e ON e.uuid = l.employee_uuid
       JOIN organizations o ON o.id = l.organization_id
      WHERE l.uuid=? AND l.employee_uuid=? AND l.status='issued'`,
    [req.params.uuid, employee.uuid]
  );
  if (!rows.length) throw new ApiError(404, "Letter not found");

  const letter = rows[0];
  const buffer = await generateHrLetterPdf({
    letter,
    employeeName: letter.employee_name,
    organizationName: letter.organization_name,
    verifyUrl: letter.qr_token ? buildLetterVerifyUrl(letter.qr_token) : null,
  });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${letter.reference_no.replace(/[^\w.-]+/g, "-")}.pdf"`
  );
  return res.send(buffer);
}