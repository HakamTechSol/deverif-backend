import crypto from "crypto";

/**
 * A short, human-readable code for a certificate, derived from the QR token.
 *
 * The public page needs something a verifier can read out loud or copy off a
 * screen ("is that the same one?") — a 64-character hex token is not that. It is
 * derived rather than stored, so it needs no schema change, is stable across
 * every reload and every surface, and cannot drift from the token it names.
 *
 * 8 data characters from the front of the token, plus one check character
 * computed over the WHOLE token, so a mistyped or truncated code is detectable
 * without a server round trip. The check character is not a security control —
 * authentication is the HMAC — it only catches transcription mistakes.
 */

// Crockford base32: digits then the letters, with I, L, O and U omitted so a
// code read aloud or retyped from a blurry print is unambiguous. 32 symbols,
// so 5 bits per character. (Crockford's indices deliberately differ from
// RFC 4648 above 17; that is expected, not a bug.)
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function toBase32(bytes) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(value >>> bits) & 31];
      // Drop the bits already consumed. Without this the accumulator keeps
      // growing past 32 bits, the shift wraps, and every character after the
      // first few is garbage.
      value &= bits === 0 ? 0 : (1 << bits) - 1;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * "XXXX-XXXXC" for a 64-hex token, or null when there is no token.
 *
 * Stable: the same token always yields the same code, on every call and in
 * every process.
 */
export function certificateCodeFor(qrToken) {
  if (typeof qrToken !== "string" || !/^[0-9a-f]{64}$/i.test(qrToken)) return null;
  const bytes = Buffer.from(qrToken, "hex");
  const data = toBase32(bytes.subarray(0, 5)).slice(0, 8).padEnd(8, "0");
  // One byte yields two base32 characters; only the first is the check digit.
  const check = toBase32(crypto.createHash("sha256").update(qrToken).digest().subarray(0, 1))[0];
  return `${data.slice(0, 4)}-${data.slice(4)}${check}`;
}

/**
 * Mask a CNIC for display on a public page: keep the standard grouping, show
 * only the last 4 digits, e.g. 4210112345673 -> "*****-****234-3".
 *
 * The full value is NEVER returned. Anything that is not exactly 13 digits is
 * fully masked rather than partially revealed, so a malformed or unexpected
 * stored value cannot leak a fragment of itself by accident.
 */
export function maskCnic(rawCnic) {
  const digits = String(rawCnic ?? "").replace(/\D/g, "");
  if (digits.length !== 13) return null;
  return `*****-****${digits.slice(9, 12)}-${digits.slice(12)}`;
}
