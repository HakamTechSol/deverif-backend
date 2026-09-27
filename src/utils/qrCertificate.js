import crypto from "crypto";
import { pool } from "../config/db.js";

const QR_SIGNING_SECRET = process.env.QR_SIGNING_SECRET || "";

/**
 * Public base URL stamped into every QR code and certificate PDF.
 *
 * Read once at module load, which is safe here only because config/db.js (an
 * import of this module) runs dotenv.config() during its own evaluation, before
 * this body executes. Removing that import would silently make this fall back.
 *
 * The frontend builds the SAME url from VITE_PUBLIC_BASE_URL. They are separate
 * runtimes so they cannot share one variable, but they must be set to the same
 * value: the backend's copy lands in the downloadable PDF, the frontend's copy
 * lands in the QR shown on screen, and a customer scanning one while holding the
 * other must not be sent to two different hosts.
 *
 * The fallback is intentionally a placeholder rather than a real domain. It used
 * to be a hardcoded live hostname, which meant a deploy that simply forgot to set
 * QR_VERIFY_BASE_URL would keep working and keep printing live-domain QR codes —
 * so the mistake stayed invisible until someone scanned one.
 */
const QR_VERIFY_BASE_URL = (process.env.QR_VERIFY_BASE_URL || "http://localhost:8080").replace(/\/+$/, "");

if (!process.env.QR_VERIFY_BASE_URL) {
  console.warn(
    "QR_VERIFY_BASE_URL is not set — QR codes will point at the local fallback. " +
      "Set it to the public site URL, and keep the frontend's VITE_PUBLIC_BASE_URL identical."
  );
}

export function qrSigningConfigured() {
  return Boolean(QR_SIGNING_SECRET);
}

export function buildVerifyUrl(qrToken) {
  return `${QR_VERIFY_BASE_URL}/verify/${qrToken}`;
}

function toEpochMillis(value) {
  if (value instanceof Date) return value.getTime();
  if (value === null || value === undefined || value === "") return 0;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

/**
 * HMAC-SHA256 over the token + the immutable fields the certificate binds to
 * (request uuid, issuing org id, verified_at). Signing on the server with the
 * QR_SIGNING_SECRET means the QR cannot be forged for a fake/mutated record.
 */
export function signQrData({ qrToken, requestUuid, orgId, verifiedAtMillis }) {
  return crypto
    .createHmac("sha256", QR_SIGNING_SECRET)
    .update(`${qrToken}:${requestUuid}:${orgId ?? 0}:${verifiedAtMillis}`)
    .digest("hex");
}

export function verifyQrSignature({ qrToken, requestUuid, orgId, verifiedAtMillis, signature }) {
  if (!QR_SIGNING_SECRET || !signature) return false;
  const expected = signQrData({ qrToken, requestUuid, orgId, verifiedAtMillis });
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(String(signature), "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Generates a fresh QR token + HMAC signature for an already-verified request
 * row (row must include id, uuid, issuing_organization_id, verified_at).
 * Returns null when QR_SIGNING_SECRET is not configured.
 */
export async function generateQrForRequest(requestRow) {
  if (!QR_SIGNING_SECRET) {
    console.warn("QR_SIGNING_SECRET is not set — skipping QR certificate generation");
    return null;
  }

  const qrToken = crypto.randomBytes(32).toString("hex");
  const qrSignature = signQrData({
    qrToken,
    requestUuid: requestRow.uuid,
    orgId: requestRow.issuing_organization_id,
    verifiedAtMillis: toEpochMillis(requestRow.verified_at),
  });

  await pool.query(
    "UPDATE verification_requests SET qr_token=?, qr_signature=? WHERE id=?",
    [qrToken, qrSignature, requestRow.id]
  );

  return { qr_token: qrToken, qr_signature: qrSignature };
}