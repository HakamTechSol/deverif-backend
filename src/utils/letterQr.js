import crypto from "crypto";
import { resolveVerifyBaseUrl } from "./qrCertificate.js";

/**
 * QR signing for HR Letters.
 *
 * Reuses the same HMAC-SHA256 scheme as utils/qrCertificate.js (same
 * QR_SIGNING_SECRET, same 64-hex token, same timing-safe comparison) so there is
 * exactly one signing convention in the system to reason about.
 *
 * WHY DOMAIN SEPARATION. The signed string is prefixed "letter:" rather than
 * being reused verbatim. Both letters and document-verification certificates are
 * signed with the SAME secret, and a verification endpoint that only checked the
 * MAC would accept a letter's signature if the token/uuid/org/timestamp fields
 * happened to line up. They never will in practice — tokens are 256-bit random —
 * but "cannot collide because the tokens are random" is exactly the kind of
 * reasoning that rots the first time someone reuses a token format. Prefixing
 * the label makes a cross-domain forgery structurally impossible: the two MACs
 * are computed over different inputs, so one can never equal the other.
 *
 * The secret is read LAZILY on every call, matching resolveVerifyBaseUrl in
 * qrCertificate.js. Reading it at import time only worked because config/db.js
 * happened to call dotenv.config() first; dropping that import would silently
 * sign with an empty key.
 */
function signingSecret() {
  return process.env.QR_SIGNING_SECRET || "";
}

export function letterQrSigningConfigured() {
  return Boolean(signingSecret());
}

const DOMAIN = "letter:";

function toEpochMillis(value) {
  if (value instanceof Date) return value.getTime();
  if (value === null || value === undefined || value === "") return 0;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

/**
 * Floor a timestamp to whole seconds.
 *
 * This is load-bearing, not cosmetic. `issued_at` is a MySQL DATETIME, which has
 * SECOND precision — mysql2 truncates the milliseconds on the way in. Signing
 * `Date.now()` with its millisecond component therefore produces a MAC over
 * bytes the database will never give back, so re-deriving the signature from the
 * stored row fails EVERY time and no letter can verify. Flooring on both the
 * signing and the verifying side makes the signed value identical to what
 * survives the round trip.
 */
function storedEpochMillis(value) {
  return Math.floor(toEpochMillis(value) / 1000) * 1000;
}

/**
 * HMAC over the token plus the immutable facts the QR attests to.
 *
 * `issuedAtMillis` is part of the signed input, which is what makes REVOCATION
 * meaningful: a revoked letter has its `issued_at` cleared, so the stored
 * signature can no longer validate and the public endpoint refuses it. Without
 * binding the timestamp, a revoked letter's printed QR would keep verifying
 * forever.
 */
export function signLetterData({ qrToken, letterUuid, orgId, issuedAtMillis }) {
  const secret = signingSecret();
  if (!secret) return null;
  return crypto
    .createHmac("sha256", secret)
    .update(`${DOMAIN}${qrToken}:${letterUuid}:${orgId ?? 0}:${storedEpochMillis(issuedAtMillis)}`)
    .digest("hex");
}

/** Constant-time signature check. Returns false when unconfigured or unsigned. */
export function verifyLetterSignature({ qrToken, letterUuid, orgId, issuedAtMillis, signature }) {
  if (!signingSecret() || !signature) return false;
  const expected = signLetterData({ qrToken, letterUuid, orgId, issuedAtMillis });
  if (!expected) return false;
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(String(signature), "hex");
  // timingSafeEqual throws on a length mismatch, so compare lengths first.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** A fresh 256-bit token, hex encoded — same shape as a document QR token. */
export function newLetterQrToken() {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Public URL for a letter's QR.
 *
 * A DISTINCT path segment, not a sibling of /verify/: a letter token and a
 * document token share a token format, and routing them through different paths
 * means the public surface stays unambiguous even if one of the two loaders
 * ever loosens its checks.
 */
export function buildLetterVerifyUrl(qrToken) {
  if (!qrToken) throw new Error("buildLetterVerifyUrl requires a qrToken");
  return `${resolveVerifyBaseUrl()}/verify/letter/${qrToken}`;
}