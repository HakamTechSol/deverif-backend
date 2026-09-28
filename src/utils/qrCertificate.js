import crypto from "crypto";
import { pool } from "../config/db.js";

const QR_SIGNING_SECRET = process.env.QR_SIGNING_SECRET || "";

/** The only path segment that sits between the base and the token. */
const VERIFY_PATH = "verify";

/**
 * Resolve and validate the public base URL that every verification link is
 * built from.
 *
 * This is the ONE place the base is read. Everything that produces a verify
 * link -- the certificate PDF, the `verify_url` field on API responses, and
 * therefore the on-screen QR, the copyable link and the "View certificate"
 * button in the frontend -- goes through it. The frontend deliberately builds
 * nothing: it renders `request.verify_url` verbatim, so there is no second
 * variable to keep in step and no way for the printed certificate and the
 * screen to disagree about which host a token points at.
 *
 * Read lazily on every call rather than cached at module load. Reading at
 * import time only worked because `config/db.js` (an import of this module)
 * happened to run `dotenv.config()` first; dropping that import would have
 * silently fallen back to a default instead of failing. The cost is a regex.
 *
 * @returns {string} absolute origin + path, guaranteed free of a trailing slash
 * @throws {Error} when the value is missing or is not an absolute http(s) URL
 */
export function resolveVerifyBaseUrl() {
  const raw = process.env.QR_VERIFY_BASE_URL;
  if (!raw || !raw.trim()) {
    throw new Error(
      "QR_VERIFY_BASE_URL is not set. It is the public site URL that every verification " +
        "QR code and certificate PDF points at (e.g. https://www.dverif.com). Set it in " +
        "backend/.env and restart.",
    );
  }

  // Strip any trailing slash(es) so callers can always join with a single "/".
  const trimmed = raw.trim().replace(/\/+$/, "");

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(
      `QR_VERIFY_BASE_URL is not an absolute URL: ${JSON.stringify(raw)}. ` +
        'It must be a full http(s) origin, e.g. https://www.dverif.com (got "' + trimmed + '").',
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `QR_VERIFY_BASE_URL must use http or https, got ${parsed.protocol} in ${JSON.stringify(raw)}.`,
    );
  }

  // A query or fragment on a base URL would be silently dropped by the join
  // below, producing a link that points somewhere other than what is
  // configured. Reject it rather than quietly disagree with the env var.
  if (parsed.search || parsed.hash) {
    throw new Error(
      `QR_VERIFY_BASE_URL must not contain a query string or fragment: ${JSON.stringify(raw)}.`,
    );
  }

  return trimmed;
}

/**
 * Fail fast at boot if the verify base URL is unusable.
 *
 * A missing value used to fall back to a live-looking default, so a deploy that
 * forgot it kept working and kept printing live-domain QR codes -- the mistake
 * stayed invisible until a member of the public scanned one. In production this
 * now stops the process; outside production (tests, local tooling) it warns and
 * continues, because refusing to boot a test run is not helpful.
 */
export function assertVerifyBaseUrlConfigured() {
  try {
    resolveVerifyBaseUrl();
    return true;
  } catch (err) {
    const isProduction = process.env.NODE_ENV === "production";
    const message = err.message;
    if (isProduction) {
      throw new Error(
        "Refusing to start: " + message + "\n" +
          "   Every certificate PDF and QR code would otherwise be printed with the wrong host.",
      );
    }
    console.warn(
      "⚠️  " + message + "\n" +
        "   The server will start, but verification links will be wrong until this is set.",
    );
    return false;
  }
}

/** The public verification link for a request's QR token. */
export function buildVerifyUrl(qrToken) {
  if (!qrToken) {
    throw new Error("buildVerifyUrl requires a qrToken");
  }
  return `${resolveVerifyBaseUrl()}/${VERIFY_PATH}/${qrToken}`;
}

/**
 * Attach `verify_url` to a request row that carries a QR token.
 *
 * Returns the row untouched when there is no token, so unverified requests do
 * not advertise a link that cannot work. Applied on the way out of every
 * response that returns a request, which is what lets the frontend treat
 * `request.verify_url` as the single source for the displayed link.
 */
export function withVerifyUrl(row) {
  if (!row || !row.qr_token) return row;
  return { ...row, verify_url: buildVerifyUrl(row.qr_token) };
}

/** Map {@link withVerifyUrl} over a list of request rows. */
export function withVerifyUrls(rows) {
  if (!Array.isArray(rows)) return rows;
  return rows.map((row) => withVerifyUrl(row));
}

export function qrSigningConfigured() {
  return Boolean(QR_SIGNING_SECRET);
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