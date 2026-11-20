import crypto from "node:crypto";
import { pool } from "../config/db.js";
import { hashPassword } from "../utils/password.js";
import { assertIdentityAvailable, normalizePhone } from "../utils/identityUniqueness.js";
import { normalizeCnic } from "../utils/contactFormat.js";
import { firstFrontendUrl } from "../utils/frontendUrl.js";
import { sendInviteEmail } from "../utils/mailer.js";
import ApiError from "../utils/ApiError.js";

const USER_IDENTITY_COLUMNS =
  "id, uuid, full_name, email, phone, cnic, status, org_role, organization, deleted_at";

async function findUserByEmail(conn, email) {
  const [rows] = await conn.query(
    `SELECT ${USER_IDENTITY_COLUMNS} FROM users WHERE email=? LIMIT 1`,
    [email]
  );
  return rows[0] || null;
}

/**
 * Find an existing login by the person's national identity or phone.
 *
 * This is how we avoid creating a second account for someone who already has one
 * under a different email. It is only used to REFUSE clearly, never to link
 * silently: an email the caller did not supply must not be moved to a new
 * organization on a guess.
 */
async function findUserByIdentity(conn, { cnic, phone }) {
  if (cnic) {
    const [rows] = await conn.query(
      `SELECT ${USER_IDENTITY_COLUMNS} FROM users
        WHERE REPLACE(REPLACE(cnic, '-', ''), ' ', '')=? LIMIT 1`,
      [cnic]
    );
    if (rows[0]) return rows[0];
  }
  if (phone) {
    const [rows] = await conn.query(
      `SELECT ${USER_IDENTITY_COLUMNS} FROM users WHERE phone_normalized=? LIMIT 1`,
      [phone]
    );
    if (rows[0]) return rows[0];
  }
  return null;
}

/**
 * Link an existing platform account to a new employment record.
 *
 * This is the rehire path: the person left Company A (their employee row is
 * `ex_employee`) and is joining Company B with the same CNIC/email/phone. We do
 * not create a duplicate login. Instead the one account is moved to B, and the
 * new employee row becomes its current employment.
 *
 * Safety rules, in order:
 *   1. the account must belong to the employee role, not a staff/admin account;
 *   2. CNIC or phone must match the employee data being entered;
 *   3. the account must not be linked to a current employment elsewhere;
 *   4. it must not already be linked to another current employee in this org.
 *
 * Previous employee rows keep their history but lose the operational link, so
 * every `linked_user_uuid` lookup (attendance, leave, `/my/*`) resolves to the
 * new employment rather than picking an arbitrary old row.
 */
async function linkExistingAccount({
  conn,
  user,
  employeeUuid,
  organizationId,
  cnic,
  phone,
  actorUuid,
}) {
  if (user.deleted_at) {
    throw new ApiError(
      409,
      "This email address belongs to a platform account that has been removed. Contact support to restore it."
    );
  }
  if (user.org_role !== "employee") {
    throw new ApiError(
      409,
      "This email address belongs to a staff account and cannot be linked as an employee account. Use a different email address."
    );
  }

  const cnicMatches = Boolean(cnic) && cnic === normalizeCnic(user.cnic);
  const phoneMatches =
    Boolean(phone) && Boolean(user.phone) && phone === normalizePhone(user.phone);
  if (!cnicMatches && !phoneMatches) {
    throw new ApiError(
      409,
      "This email address is already registered to a different person. Check the email, CNIC and phone number."
    );
  }

  const [employments] = await conn.query(
    "SELECT uuid, organization_id, status FROM employees WHERE linked_user_uuid=?",
    [user.uuid]
  );

  const activeElsewhere = employments.find(
    (row) =>
      Number(row.organization_id) !== Number(organizationId) &&
      row.status !== "ex_employee"
  );
  if (activeElsewhere) {
    throw new ApiError(
      409,
      "This person is still active at another organization. Their exit must be completed before they can be linked here."
    );
  }

  const activeHere = employments.find(
    (row) =>
      Number(row.organization_id) === Number(organizationId) &&
      row.uuid !== employeeUuid &&
      row.status !== "ex_employee"
  );
  if (activeHere) {
    throw new ApiError(
      409,
      "This person is already linked to another active employee record in this organization."
    );
  }

  // One account, one current employment. The account follows the person to
  // their new organization; `users.organization` is what the access token and
  // every org-scoped query use.
  await conn.query("UPDATE users SET organization=?, status='active' WHERE uuid=?", [
    organizationId,
    user.uuid,
  ]);

  // Unlink every previous employment, including an old row in the destination
  // org. The rows remain as history (payslips, assets, exits); only the live
  // account pointer moves.
  await conn.query(
    "UPDATE employees SET is_platform_user='no', linked_user_uuid=NULL WHERE linked_user_uuid=? AND uuid<>?",
    [user.uuid, employeeUuid]
  );

  await conn.query(
    `UPDATE employees
        SET is_platform_user='yes', linked_user_uuid=?, promoted_by_uuid=?, promoted_at=NOW()
      WHERE uuid=? AND organization_id=?`,
    [user.uuid, actorUuid || null, employeeUuid, organizationId]
  );

  return {
    userUuid: user.uuid,
    linkedExisting: true,
    tokenId: null,
    rawToken: null,
  };
}

/** Create a fresh employee login and one-time setup token inside the caller's transaction.
 * Existing accounts are never linked by matching email alone; linkExistingAccount
 * additionally requires a CNIC/phone match and a finished previous employment.
 */
export async function createEmployeePortalInvite({ conn, employeeUuid, organizationId, fullName, email, phone, cnic, actorUuid }) {
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ApiError(400, "A valid email address is required for portal access");
  }

  const normalizedCnic = normalizeCnic(cnic);
  const normalizedPhone = normalizePhone(phone);

  // A returning employee brings the same email. Link that account instead of
  // failing with "a platform user with this email already exists".
  const sameEmail = await findUserByEmail(conn, email);
  if (sameEmail) {
    return linkExistingAccount({
      conn,
      user: sameEmail,
      employeeUuid,
      organizationId,
      cnic: normalizedCnic,
      phone: normalizedPhone,
      actorUuid,
    });
  }

  // Same person, different email: we cannot create a second account because
  // users.cnic / users.phone_normalized are globally unique. Say so plainly
  // instead of leaking a raw duplicate-key error.
  const identityUser = await findUserByIdentity(conn, {
    cnic: normalizedCnic,
    phone: normalizedPhone,
  });
  if (identityUser) {
    throw new ApiError(
      409,
      "This person already has a platform account under a different email address. Use the email address already registered on that account to link it."
    );
  }

  await assertIdentityAvailable({ phone, cnic, executor: conn });
  const dummyHash = await hashPassword(crypto.randomBytes(32).toString("hex"));
  const [userInsert] = await conn.query(
    `INSERT INTO users
      (full_name,email,phone,password,cnic,status,org_role,feature_access,organization,profile_image,is_verified,created_at)
     VALUES (?,?,?,?,?,'inactive','employee',NULL,?,NULL,'no',NOW())`,
    [fullName, email, phone || null, dummyHash, cnic || null, organizationId],
  );
  const [[user]] = await conn.query("SELECT uuid FROM users WHERE id=?", [userInsert.insertId]);
  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  const expiry = Math.max(1, Math.min(720, Number.parseInt(process.env.INVITE_EXPIRES_IN_HOURS || "72", 10) || 72));
  const [tokenInsert] = await conn.query(
    "INSERT INTO invite_tokens (user_uuid,token_hash,expires_at,delivery_status) VALUES (?,?,DATE_ADD(NOW(), INTERVAL ? HOUR),'pending')",
    [user.uuid, tokenHash, expiry],
  );
  await conn.query(
    "UPDATE employees SET is_platform_user='yes',linked_user_uuid=?,promoted_by_uuid=?,promoted_at=NOW() WHERE uuid=? AND organization_id=?",
    [user.uuid, actorUuid || null, employeeUuid, organizationId],
  );
  return {
    userUuid: user.uuid,
    linkedExisting: false,
    tokenId: tokenInsert.insertId,
    rawToken,
  };
}

/** Deliver after the employee/account transaction commits; keep the record on mail failure. */
export async function deliverEmployeePortalInvite({ tokenId, rawToken, to, invitedByName, conn = pool }) {
  const setLinkBase = firstFrontendUrl(process.env.FRONTEND_SET_PASSWORD_URL, "http://localhost:8080/set-password");
  const setLink = `${setLinkBase}?token=${encodeURIComponent(rawToken)}`;
  try {
    await sendInviteEmail({ to, setLink, invitedByName });
    await conn.query("UPDATE invite_tokens SET delivery_status='sent',delivery_error=NULL WHERE id=?", [tokenId]);
    return { sent: true, warning: null };
  } catch (e) {
    const detail = String(e?.message || "Invitation delivery failed").slice(0, 500);
    await conn.query("UPDATE invite_tokens SET delivery_status='failed',delivery_error=? WHERE id=?", [detail, tokenId]);
    return { sent: false, warning: "Employee record was saved, but the portal invitation could not be delivered. Use Resend invitation after correcting mail configuration." };
  }
}
