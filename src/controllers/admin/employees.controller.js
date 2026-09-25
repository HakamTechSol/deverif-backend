import crypto from "crypto";
import ApiError from "../../utils/ApiError.js";
import { pool } from "../../config/db.js";
import { ok, created } from "../../utils/response.js";
import { assertUuid } from "../../utils/publicResponse.js";
import { hashPassword } from "../../utils/password.js";
import { parsePagination, paginatedResponse } from "../../utils/pagination.js";
import { sendInviteEmail } from "../../utils/mailer.js";
import { firstFrontendUrl } from "../../utils/frontendUrl.js";
import { logAudit, getActorFromReq } from "../../utils/auditLog.js";
import { STAFF_ROLES, assertRole } from "../../utils/roles.js";

const EMPLOYEE_SELECT = `SELECT e.id, e.uuid, e.organization_id, e.full_name, e.email, e.phone,
        e.cnic, dg.name AS designation, dp.name AS department, e.status, e.record_type, e.is_platform_user,
        e.linked_user_uuid, e.added_by_uuid, e.promoted_by_uuid, e.promoted_at,
        e.joining_date, e.emergency_contact,
        e.created_at,
        o.uuid AS organization_uuid,
        o.name AS organization_name,
        COALESCE(au.full_name, au2.full_name) AS added_by_name,
        COALESCE(pu.full_name, pu2.full_name) AS promoted_by_name,
        u.email AS linked_user_email,
        u.status AS linked_user_status,
        u.org_role AS linked_user_role,
        u.profile_image AS linked_user_profile_image,
        it.expires_at AS invite_expires_at,
        it.used_at AS invite_used_at,
        it.created_at AS invite_sent_at,
        (SELECT COUNT(*) FROM employee_documents ed WHERE ed.employee_uuid = e.uuid) AS document_count,
        (SELECT h.basic_salary FROM employee_salary_history h
          WHERE h.employee_uuid = e.uuid AND h.effective_to IS NULL
          ORDER BY h.effective_from DESC LIMIT 1) AS current_salary
 FROM employees e
 LEFT JOIN organizations o ON o.id = e.organization_id
 LEFT JOIN designations dg ON dg.id = e.designation_id
 LEFT JOIN departments dp ON dp.id = e.department_id
 LEFT JOIN admin_profiles au ON au.uuid = e.added_by_uuid
 LEFT JOIN users au2 ON au2.uuid = e.added_by_uuid
 LEFT JOIN admin_profiles pu ON pu.uuid = e.promoted_by_uuid
 LEFT JOIN users pu2 ON pu2.uuid = e.promoted_by_uuid
 LEFT JOIN users u ON u.uuid = e.linked_user_uuid
 LEFT JOIN invite_tokens it ON it.user_uuid = e.linked_user_uuid
   AND it.id = (SELECT id FROM invite_tokens WHERE user_uuid = e.linked_user_uuid ORDER BY id DESC LIMIT 1)`;

// For future org-admin scope: routes can set req.scopeOrgId (organization integer id).
// Admin (no scope) may target any organization.
async function resolveScopeOrganization(req) {
  if (req.scopeOrgId) {
    const [org] = await pool.query("SELECT id, uuid FROM organizations WHERE id=?", [req.scopeOrgId]);
    if (!org.length) throw new ApiError(403, "Your organization no longer exists");
    return { scoped: true, orgId: req.scopeOrgId, orgUuid: org[0].uuid };
  }
  return { scoped: false, orgId: null, orgUuid: null };
}

async function resolveOrganizationId(organizationUuid) {
  if (!organizationUuid) throw new ApiError(400, "organization_uuid is required");
  assertUuid(organizationUuid, "Organization UUID");
  const [rows] = await pool.query("SELECT id FROM organizations WHERE uuid=?", [organizationUuid]);
  if (!rows.length) throw new ApiError(404, "Organization not found");
  return rows[0].id;
}

const ALLOWED_EMPLOYEE_STATUS = ["active", "inactive", "resigned", "terminated"];

/** Resolve an org-scoped designation/department row by name, creating it if missing. */
async function resolveMetaId(conn, orgId, table, name) {
  if (!name) return null;
  const [rows] = await conn.query(
    `SELECT id FROM ${table} WHERE organization_id=? AND name=?`,
    [orgId, name]
  );
  if (rows.length) return rows[0].id;
  const [r] = await conn.query(
    `INSERT INTO ${table} (uuid, organization_id, name) VALUES (UUID(), ?, ?)`,
    [orgId, name]
  );
  return r.insertId;
}

function normalizeEmployeePayload(body) {
  const { full_name, email, phone, cnic, designation, department, status, joining_date, emergency_contact, current_salary } = body;
  const errors = [];

  if (full_name === undefined || String(full_name).trim() === "") errors.push("full_name is required");
  if (cnic === undefined || String(cnic).trim() === "") errors.push("cnic is required");

  if (email !== undefined && email !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.push("email is invalid");
  }
  if (emergency_contact !== undefined && emergency_contact !== "" && !/^[0-9+\-() ]{6,30}$/.test(emergency_contact)) {
    errors.push("emergency_contact is invalid");
  }

  let normalizedCurrentSalary = 0;
  if (current_salary !== undefined && current_salary !== null && current_salary !== "") {
    const n = Number(current_salary);
    if (!Number.isFinite(n) || n < 0) {
      errors.push("current_salary must be a non-negative number");
    } else {
      normalizedCurrentSalary = Math.round(n * 100) / 100;
    }
  }

  if (errors.length) throw new ApiError(400, errors.join("; "));

  const normalizedStatus = ALLOWED_EMPLOYEE_STATUS.includes(status) ? status : "active";

  return {
    full_name: String(full_name).trim(),
    email: email ? String(email).trim() : null,
    phone: phone ? String(phone).trim() : null,
    cnic: String(cnic).trim(),
    designation: designation ? String(designation).trim() : null,
    department: department ? String(department).trim() : null,
    status: normalizedStatus,
    joining_date: joining_date ? String(joining_date).trim() : null,
    emergency_contact: emergency_contact ? String(emergency_contact).trim() : null,
    current_salary: normalizedCurrentSalary,
  };
}

export async function createEmployee(req, res) {
  assertRole(req.user, STAFF_ROLES);
  const scope = await resolveScopeOrganization(req);
  const data = normalizeEmployeePayload(req.body);

  let orgId;
  if (scope.scoped) {
    orgId = scope.orgId;
  } else {
    orgId = await resolveOrganizationId(req.body.organization_uuid);
  }

  if (data.email) {
    const [dupeEmp] = await pool.query(
      "SELECT uuid FROM employees WHERE email=?",
      [data.email]
    );
    if (dupeEmp.length) throw new ApiError(409, "An employee with this email already exists");
  }
  const [dupeCnic] = await pool.query("SELECT uuid FROM employees WHERE cnic=?", [data.cnic]);
  if (dupeCnic.length) throw new ApiError(409, "An employee with this CNIC already exists");

  const addedByUuid = req.admin?.uuid || req.user?.uuid || null;
  // An employee that carries an email is created as a platform user straight
  // away and a set-password link is emailed to them.
  //
  // This is deliberately NOT gated on the organization's subscription. The
  // invite is how the employee gets in the door; what they can then see is
  // decided per-request by the plan, so an unsubscribed org's employee still
  // signs in and simply sees the plan-gated screens in their locked state.
  // Gating the invite itself would instead produce an account-less employee who
  // cannot be invited later without re-entering their details.
  const wantsPlatformUser = !!data.email;
  let createdEmployeeUuid = null;
  let linkedUserUuid = null;
  let rawToken = null;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const designationId = await resolveMetaId(conn, orgId, "designations", data.designation);
    const departmentId = await resolveMetaId(conn, orgId, "departments", data.department);
    const [res2] = await conn.query(
      `INSERT INTO employees
       (uuid, organization_id, full_name, email, phone, cnic, designation_id, department_id, status,
        joining_date, emergency_contact,
        is_platform_user, linked_user_uuid, added_by_uuid, promoted_by_uuid, promoted_at, created_at)
       VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'no', NULL, ?, NULL, NULL, NOW())`,
      [orgId, data.full_name, data.email, data.phone, data.cnic, designationId, departmentId,
        data.status, data.joining_date, data.emergency_contact, addedByUuid]
    );
    const [[createdEmployee]] = await conn.query("SELECT uuid FROM employees WHERE id=?", [res2.insertId]);
    createdEmployeeUuid = createdEmployee.uuid;

    // Requirement 2: capture the employee's starting salary as the first
    // employee_salary_history row (active period) at creation time.
    // created_by is intentionally NULL: this is an automatic/system row created
    // as a side-effect of employee creation, not a tracked admin action.
    const effFrom = data.joining_date || new Date().toISOString().slice(0, 10);
    await conn.query(
      `INSERT INTO employee_salary_history
         (uuid, employee_uuid, year, basic_salary, effective_from, effective_to, created_at)
       VALUES (UUID(), ?, ?, ?, ?, NULL, NOW())`,
      [createdEmployeeUuid, Number(effFrom.slice(0, 4)), data.current_salary, effFrom]
    );

    if (wantsPlatformUser) {
      const [existingUser] = await conn.query("SELECT uuid FROM users WHERE email=?", [data.email]);
      if (existingUser.length) throw new ApiError(409, "A platform user with this email already exists");
      const [orgExists] = await conn.query("SELECT id FROM organizations WHERE id=?", [orgId]);
      if (!orgExists.length) throw new ApiError(400, "Organization no longer exists");

      const orgRole = "employee";
      const dummyHash = await hashPassword(crypto.randomBytes(16).toString("hex"));
      const [userRes] = await conn.query(
        `INSERT INTO users
         (full_name, email, phone, password, cnic, status, org_role, feature_access,
          organization, profile_image, is_verified, created_at)
         VALUES (?, ?, ?, ?, ?, 'inactive', ?, NULL, ?, NULL, 'no', NOW())`,
        [data.full_name, data.email, data.phone || null, dummyHash, data.cnic, orgRole, orgId]
      );
      const [[newUser]] = await conn.query("SELECT uuid FROM users WHERE id=?", [userRes.insertId]);
      linkedUserUuid = newUser.uuid;

      rawToken = crypto.randomBytes(32).toString("hex");
      const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
      const expiresInHours = parseInt(process.env.INVITE_EXPIRES_IN_HOURS || "72", 10);
      await conn.query(
        "INSERT INTO invite_tokens (user_uuid, token_hash, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? HOUR))",
        [newUser.uuid, tokenHash, expiresInHours]
      );

      const promotedByUuid = req.admin?.uuid || req.user?.uuid || null;
      await conn.query(
        `UPDATE employees SET is_platform_user='yes', linked_user_uuid=?, promoted_by_uuid=?, promoted_at=NOW() WHERE uuid=?`,
        [newUser.uuid, promotedByUuid, createdEmployeeUuid]
      );
    }

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    if (String(err.message).includes("Duplicate")) throw new ApiError(409, err.message);
    throw err;
  } finally {
    conn.release();
  }

  const [employeeRow] = await pool.query(`${EMPLOYEE_SELECT} WHERE e.uuid=?`, [createdEmployeeUuid]);

  // Sent after the transaction commits so a mail failure can never roll back a
  // successfully created employee.
  let emailSent = false;
  let emailError = null;
  if (wantsPlatformUser && rawToken) {
    const setLinkBase = firstFrontendUrl(process.env.FRONTEND_SET_PASSWORD_URL, "http://localhost:8080/set-password");
    const setLink = `${setLinkBase}?token=${encodeURIComponent(rawToken)}`;
    const invitedByName = req.admin?.full_name || req.user?.full_name || "Org Admin";
    try {
      await sendInviteEmail({ to: data.email, setLink, invitedByName });
      emailSent = true;
    } catch (e) {
      emailError = e.message;
      console.error("Failed to send invite email:", e.message);
    }
  }

  logAudit({
    ...getActorFromReq(req),
    action: "employee.create",
    entityType: "employee",
    entityId: createdEmployeeUuid,
    details: {
      full_name: data.full_name,
      email: data.email,
      organization_id: orgId,
      created_platform_user: !!linkedUserUuid,
      email_sent: emailSent,
    },
    req,
  });

  const payload = { employee: employeeRow[0] };
  let message = "Employee created successfully";
  if (wantsPlatformUser) {
    message = emailSent
      ? "Employee created. Set-password email sent."
      : "Employee created but invite email failed.";
    if (!emailSent) {
      payload._email_warning = `Invite email failed: ${emailError}. The platform user cannot sign in until they set a password.`;
    }
  }

  return created(res, payload, message);
}

export async function resendEmployeeInvite(req, res) {
  assertRole(req.user, STAFF_ROLES);
  const { uuid } = req.params;
  assertUuid(uuid, "Employee UUID");

  const [empRows] = await pool.query(
    `SELECT e.uuid, e.email, e.full_name, e.linked_user_uuid, e.is_platform_user,
            u.status AS linked_user_status
     FROM employees e
     LEFT JOIN users u ON u.uuid = e.linked_user_uuid
     WHERE e.uuid=?`,
    [uuid]
  );
  if (!empRows.length) throw new ApiError(404, "Employee not found");

  const emp = empRows[0];
  if (emp.is_platform_user !== "yes" || !emp.linked_user_uuid) {
    throw new ApiError(400, "This employee does not have a platform user account yet. Select them from the roster and use \"Add as Platform User\".");
  }
  if (emp.linked_user_status === "active") {
    throw new ApiError(400, "This user is already active. Use forgot password instead.");
  }

  const userUuid = emp.linked_user_uuid;

  // Invalidate any existing unused tokens for this user
  await pool.query(
    "UPDATE invite_tokens SET used_at=NOW() WHERE user_uuid=? AND used_at IS NULL",
    [userUuid]
  );

  // Generate a fresh token
  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  const expiresInHours = parseInt(process.env.INVITE_EXPIRES_IN_HOURS || "72", 10);

  await pool.query(
    "INSERT INTO invite_tokens (user_uuid, token_hash, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? HOUR))",
    [userUuid, tokenHash, expiresInHours]
  );

  const setLinkBase = firstFrontendUrl(process.env.FRONTEND_SET_PASSWORD_URL, "http://localhost:8080/set-password");
  const setLink = `${setLinkBase}?token=${encodeURIComponent(rawToken)}`;
  const invitedByName = req.user?.full_name || "Org Admin";

  try {
    await sendInviteEmail({ to: emp.email, setLink, invitedByName });
  } catch (e) {
    throw new ApiError(500, e.message || "Failed to send invite email");
  }

  logAudit({
    ...getActorFromReq(req),
    action: "employee.invite_resend",
    entityType: "employee",
    entityId: uuid,
    details: { email: emp.email, full_name: emp.full_name },
    req,
  });

  return ok(res, {}, "Invite resent successfully");
}

export async function listEmployees(req, res) {
  assertRole(req.user, STAFF_ROLES);
  const scope = await resolveScopeOrganization(req);
  const { page, limit, offset } = parsePagination(req.query);
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";

  const conditions = [];
  const params = [];

  // Default: only roster employees. ?reference=1 shows learned_reference rows instead.
  const showReferences = req.query.reference === "1" || req.query.reference === "true";
  conditions.push("e.record_type = ?");
  params.push(showReferences ? "learned_reference" : "roster");

  if (scope.scoped) {
    conditions.push("e.organization_id = ?");
    params.push(scope.orgId);
    // Business rule: org-admins only see employee records THEY personally added
    // (per-admin visibility within one organization). Platform admins are unfiltered.
    conditions.push("e.added_by_uuid = ?");
    params.push(req.user.uuid);
  }

  if (search) {
    conditions.push("(e.full_name LIKE ? OR e.email LIKE ? OR e.phone LIKE ? OR e.cnic LIKE ? OR dg.name LIKE ? OR dp.name LIKE ? OR o.name LIKE ?)");
    const like = `%${search}%`;
    params.push(like, like, like, like, like, like, like);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM employees e
     LEFT JOIN organizations o ON o.id = e.organization_id
     LEFT JOIN designations dg ON dg.id = e.designation_id
     LEFT JOIN departments dp ON dp.id = e.department_id
     ${whereClause}`,
    params
  );
  const [rows] = await pool.query(
    `${EMPLOYEE_SELECT} ${whereClause} ORDER BY e.created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  return ok(res, paginatedResponse(rows, total, page, limit), "Employees list");
}

export async function getEmployee(req, res) {
  assertRole(req.user, STAFF_ROLES);
  const { uuid } = req.params;
  const scope = await resolveScopeOrganization(req);
  assertUuid(uuid, "Employee UUID");

  const [rows] = await pool.query(`${EMPLOYEE_SELECT} WHERE e.uuid=?`, [uuid]);
  if (!rows.length) throw new ApiError(404, "Employee not found");

  if (scope.scoped && rows[0].organization_id !== scope.orgId) {
    throw new ApiError(403, "You can only view employees within your organization");
  }

  return ok(res, { employee: rows[0] }, "Employee");
}

export async function updateEmployee(req, res) {
  assertRole(req.user, STAFF_ROLES);
  const { uuid } = req.params;
  const scope = await resolveScopeOrganization(req);
  assertUuid(uuid, "Employee UUID");

  const [rows] = await pool.query("SELECT * FROM employees WHERE uuid=?", [uuid]);
  if (!rows.length) throw new ApiError(404, "Employee not found");
  const emp = rows[0];

  if (scope.scoped && emp.organization_id !== scope.orgId) {
    throw new ApiError(403, "You can only manage employees within your organization");
  }

  const { full_name, email, phone, cnic, designation, department, status, joining_date, emergency_contact, organization_uuid } = req.body;

  const updateFields = [];
  const updateValues = [];

  if (full_name !== undefined && String(full_name).trim() !== "") {
    updateFields.push("full_name = ?");
    updateValues.push(String(full_name).trim());
  }
  if (email !== undefined) {
    const trimmed = email ? String(email).trim() : null;
    if (trimmed && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) throw new ApiError(400, "email is invalid");
    const [dupeEmp] = await pool.query("SELECT uuid FROM employees WHERE email=? AND uuid<>?", [trimmed, uuid]);
    if (dupeEmp.length) throw new ApiError(409, "An employee with this email already exists");
    updateFields.push("email = ?");
    updateValues.push(trimmed);
  }
  if (phone !== undefined) {
    updateFields.push("phone = ?");
    updateValues.push(phone ? String(phone).trim() : null);
  }
  if (cnic !== undefined) {
    const trimmed = String(cnic).trim();
    if (trimmed) {
      const [dupeCnic] = await pool.query("SELECT uuid FROM employees WHERE cnic=? AND uuid<>?", [trimmed, uuid]);
      if (dupeCnic.length) throw new ApiError(409, "An employee with this CNIC already exists");
    }
    updateFields.push("cnic = ?");
    updateValues.push(trimmed);
  }
  if (designation !== undefined) {
    const designationId = await resolveMetaId(pool, emp.organization_id, "designations", designation ? String(designation).trim() : null);
    updateFields.push("designation_id = ?");
    updateValues.push(designationId);
  }
  if (department !== undefined) {
    const departmentId = await resolveMetaId(pool, emp.organization_id, "departments", department ? String(department).trim() : null);
    updateFields.push("department_id = ?");
    updateValues.push(departmentId);
  }
  if (status !== undefined) {
    updateFields.push("status = ?");
    updateValues.push(ALLOWED_EMPLOYEE_STATUS.includes(status) ? status : "active");
  }
  if (joining_date !== undefined) {
    updateFields.push("joining_date = ?");
    updateValues.push(joining_date ? String(joining_date).trim() : null);
  }
  if (emergency_contact !== undefined) {
    updateFields.push("emergency_contact = ?");
    updateValues.push(emergency_contact ? String(emergency_contact).trim() : null);
  }
  if (organization_uuid !== undefined) {
    if (scope.scoped) throw new ApiError(403, "Cannot change the organization of an employee in your scope");
    const newOrgId = await resolveOrganizationId(organization_uuid);
    updateFields.push("organization_id = ?");
    updateValues.push(newOrgId);
  }

  if (updateFields.length === 0) throw new ApiError(400, "At least one field is required to update");

  updateValues.push(uuid);
  await pool.query(`UPDATE employees SET ${updateFields.join(", ")} WHERE uuid=?`, updateValues);

  const [updated] = await pool.query(`${EMPLOYEE_SELECT} WHERE e.uuid=?`, [uuid]);

  logAudit({
    ...getActorFromReq(req),
    action: "employee.update",
    entityType: "employee",
    entityId: uuid,
    details: { fields: Object.keys(req.body || {}) },
    req,
  });

  return ok(res, { employee: updated[0] }, "Employee updated successfully");
}

export async function deleteEmployee(req, res) {
  assertRole(req.user, ["org_admin"]);
  const { uuid } = req.params;
  const scope = await resolveScopeOrganization(req);
  assertUuid(uuid, "Employee UUID");

  const [rows] = await pool.query("SELECT id, organization_id, is_platform_user FROM employees WHERE uuid=?", [uuid]);
  if (!rows.length) throw new ApiError(404, "Employee not found");
  const emp = rows[0];

  if (scope.scoped && emp.organization_id !== scope.orgId) {
    throw new ApiError(403, "You can only manage employees within your organization");
  }

  if (emp.is_platform_user === "yes") {
    throw new ApiError(409, "Cannot delete an employee who is a linked platform user. Deactivate the user account first.");
  }

  await pool.query("DELETE FROM employees WHERE uuid=?", [uuid]);

  logAudit({
    ...getActorFromReq(req),
    action: "employee.delete",
    entityType: "employee",
    entityId: uuid,
    req,
  });

  return ok(res, {}, "Employee deleted successfully");
}

export async function archiveReference(req, res) {
  assertRole(req.user, STAFF_ROLES);
  const { uuid } = req.params;
  assertUuid(uuid, "Employee UUID");
  const scope = await resolveScopeOrganization(req);

  const [rows] = await pool.query("SELECT * FROM employees WHERE uuid=?", [uuid]);
  if (!rows.length) throw new ApiError(404, "Employee not found");
  const emp = rows[0];

  if (scope.scoped && emp.organization_id !== scope.orgId) {
    throw new ApiError(403, "You can only manage employees within your organization");
  }

  await pool.query(
    `UPDATE employees SET record_type='learned_reference', status='resigned' WHERE uuid=?`,
    [uuid]
  );

  const [updated] = await pool.query(`${EMPLOYEE_SELECT} WHERE e.uuid=?`, [uuid]);

  logAudit({
    ...getActorFromReq(req),
    action: "employee.archive_reference",
    entityType: "employee",
    entityId: uuid,
    details: { full_name: emp.full_name, previous_status: emp.status },
    req,
  });

  return ok(res, { employee: updated[0] }, "Employee archived as reference");
}

export async function createReference(req, res) {
  assertRole(req.user, STAFF_ROLES);
  const scope = await resolveScopeOrganization(req);

  const { full_name, cnic } = req.body;
  if (!full_name || String(full_name).trim() === "") throw new ApiError(400, "full_name is required");
  if (!cnic || String(cnic).trim() === "") throw new ApiError(400, "cnic is required");

  let orgId;
  if (scope.scoped) {
    orgId = scope.orgId;
  } else {
    orgId = await resolveOrganizationId(req.body.organization_uuid);
  }

  const trimmedCnic = String(cnic).trim();
  const [dupeCnic] = await pool.query("SELECT uuid FROM employees WHERE cnic=? AND organization_id=?", [trimmedCnic, orgId]);
  if (dupeCnic.length) throw new ApiError(409, "An employee with this CNIC already exists in this organization");

  const addedByUuid = req.admin?.uuid || req.user?.uuid || null;

  const [result] = await pool.query(
    `INSERT INTO employees
     (uuid, organization_id, full_name, cnic, status, record_type,
      is_platform_user, added_by_uuid, created_at)
     VALUES (UUID(), ?, ?, ?, 'active', 'learned_reference', 'no', ?, NOW())`,
    [orgId, String(full_name).trim(), trimmedCnic, addedByUuid]
  );

  const [[createdRow]] = await pool.query("SELECT uuid FROM employees WHERE id=?", [result.insertId]);

  const [employeeRow] = await pool.query(`${EMPLOYEE_SELECT} WHERE e.uuid=?`, [createdRow.uuid]);

  logAudit({
    ...getActorFromReq(req),
    action: "employee.create_reference",
    entityType: "employee",
    entityId: createdRow.uuid,
    details: { full_name: String(full_name).trim(), organization_id: orgId },
    req,
  });

  return created(res, { employee: employeeRow[0] }, "Reference record created");
}
