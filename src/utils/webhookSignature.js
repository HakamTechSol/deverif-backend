import crypto from "crypto";

// Max skew allowed between the event timestamp and our clock, in ms.
const MAX_AGE_MS = 5 * 60 * 1000;
// Tolerated skew for the older unix-seconds timestamp variant.
const MAX_STAMP_AGE_SEC = 5 * 60;

function constantTimeEquals(a, b) {
  const strip = (s) => (typeof s === "string" && s.startsWith("sha256=") ? s.slice("sha256=".length) : String(s));
  let bufA;
  let bufB;
  try {
    bufA = Buffer.from(strip(a), "hex");
    bufB = Buffer.from(strip(b), "hex");
  } catch {
    return false;
  }
  if (!bufA.length || !bufB.length || bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

const hexDigest = (buf) => buf.toString("hex");

// Normalise the configured secret into all plausible HMAC key bytes:
//  * the raw secret string (UTF-8 bytes)
//  * the Base64-decoded secret (Safepay's newer Raast spec)
// This lets the check succeed regardless of how the secret is stored/used.
function secretKeyCandidates(secret) {
  const keys = new Set([Buffer.from(secret, "utf8")]);
  try {
    const decoded = Buffer.from(secret, "base64");
    // Only add if it actually differs meaningfully from the raw bytes.
    if (decoded.length > 0 && !decoded.equals(Buffer.from(secret, "utf8"))) keys.add(decoded);
  } catch {
    /* ignore */
  }
  return [...keys];
}

/**
 * Verify the Safepay webhook HMAC signature.
 *
 * Safepay has shipped several signing schemes across API generations, so we
 * verify against every documented variant and accept whichever matches:
 *
 *  A) Payments 2.0 / Raast (current docs):
 *       payload = `<X-SFPY-TIMESTAMP>.<rawBody>`   (RFC3339 timestamp)
 *       key     = base64-decoded webhook secret
 *       sig     = `sha256=` + HMAC-SHA256 hex
 *
 *  B) Legacy checkout (Payments 1.0, ASP.NET/dotnet SDK era):
 *       payload = raw body
 *       key     = raw secret (UTF-8 bytes)
 *       sig     = HMAC-SHA512 hex (and sometimes bare SHA-256)
 *
 * We additionally tolerate bare-digest (no `sha256=` prefix) signatures and
 * unix-seconds timestamps, and allow a small clock skew.
 */
export function verifyWebhookSignature({ rawBody, signature, timestamp }) {
  const secret = process.env.PAYMENT_GATEWAY_WEBHOOK_SECRET;
  if (!secret) return { ok: false, error: "Webhook secret is not configured" };
  if (typeof rawBody !== "string" || !rawBody) return { ok: false, error: "Webhook payload is empty" };

  const given = String(signature || "").trim();
  if (!given) return { ok: false, error: "Missing X-SFPY-SIGNATURE header" };

  const candidates = [];
  const keys = secretKeyCandidates(secret);

  // Collect every plausible timestamp representation: the raw value, and the
  // RFC3339 form derived from a unix-seconds value (if given in seconds).
  const timestamps = new Set();
  if (typeof timestamp === "string" && timestamp) timestamps.add(timestamp);
  const asNum = Number(timestamp);
  if (Number.isFinite(asNum) && asNum > 0) {
    try {
      timestamps.add(new Date(asNum * 1000).toISOString().replace(/\.\d+Z$/, "Z"));
    } catch {
      /* ignore */
    }
  }

  // ---- Scheme A: HMAC-SHA256 over `<timestamp>.<body>` ----
  for (const key of keys) {
    for (const ts of timestamps) {
      let fresh = true;
      const parsed = Date.parse(ts);
      if (Number.isFinite(parsed)) {
        if (Math.abs(Date.now() - parsed) > MAX_AGE_MS) fresh = false;
      } else if (Number.isFinite(Number(ts)) && Number(ts) > 0) {
        if (Math.abs(Date.now() - Number(ts) * 1000) > MAX_STAMP_AGE_SEC * 1000) fresh = false;
      } else {
        fresh = false;
      }
      if (!fresh) continue;

      const digest = hexDigest(crypto.createHmac("sha256", key).update(`${ts}.${rawBody}`).digest());
      candidates.push(`sha256=${digest}`, digest);
    }
  }

  // ---- Scheme B: legacy raw-body signing (SHA-512 and SHA-256), always ----
  for (const key of keys) {
    for (const algo of ["sha512", "sha256"]) {
      const digest = hexDigest(crypto.createHmac(algo, key).update(rawBody).digest());
      candidates.push(`sha256=${digest}`, digest);
    }
  }

  const matched = candidates.some((expected) => constantTimeEquals(expected, given));
  return matched ? { ok: true } : { ok: false, error: "Webhook signature mismatch" };
}
