import crypto from "node:crypto";
import { pool } from "../config/db.js";
import { hashPassword } from "../utils/password.js";
import { assertIdentityAvailable } from "../utils/identityUniqueness.js";
import { firstFrontendUrl } from "../utils/frontendUrl.js";
import { sendInviteEmail } from "../utils/mailer.js";
import ApiError from "../utils/ApiError.js";

/** Create a fresh employee login and one-time setup token inside the caller's transaction.
 * Existing accounts are deliberately never linked by matching email alone.
 */
export async function createEmployeePortalInvite({ conn, employeeUuid, organizationId, fullName, email, phone, cnic, actorUuid }) {
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ApiError(400, "A valid email address is required for portal access");
  }
  const [existingUser] = await conn.query("SELECT uuid FROM users WHERE email=?", [email]);
  if (existingUser.length) {
    throw new ApiError(409, "A platform user with this email already exists. Accounts are not linked automatically; resolve the identity through the organization account workflow.");
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
  return { userUuid: user.uuid, tokenId: tokenInsert.insertId, rawToken };
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
