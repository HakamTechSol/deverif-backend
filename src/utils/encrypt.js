import crypto from "crypto";
import ApiError from "./ApiError.js";

/*
 * Field-level encryption for sensitive person data (e.g. CNIC).
 *
 * AES-256-GCM with a random 96-bit IV per value. The key is derived from the
 * PERSON_DATA_ENCRYPTION_KEY env variable via SHA-256, so any non-empty secret
 * is normalized to the 32 bytes AES-256 requires.
 *
 * Ciphertext payload format (self-describing, versioned):
 *   v1:<iv base64>:<auth tag base64>:<ciphertext base64>
 */

const ALGORITHM = "aes-256-gcm";
const VERSION = "v1";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function getKey() {
  const secret = process.env.PERSON_DATA_ENCRYPTION_KEY;
  if (!secret || secret === "change_me") {
    throw new ApiError(500, "PERSON_DATA_ENCRYPTION_KEY is not configured");
  }
  return crypto.createHash("sha256").update(String(secret)).digest();
}

/**
 * Encrypt a value with AES-256-GCM. Returns null for null/undefined input so it
 * can be used directly against nullable columns.
 */
export function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined) return null;
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(String(plaintext), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

/**
 * Decrypt a payload produced by encrypt(). Returns null for null/undefined/"".
 * Throws if the payload is malformed or the GCM auth tag fails to verify
 * (tampered data or wrong key).
 */
export function decrypt(payload) {
  if (payload === null || payload === undefined || payload === "") return null;
  const parts = String(payload).split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new ApiError(500, "Invalid encrypted payload");
  }
  const [, ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");
  if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) {
    throw new ApiError(500, "Invalid encrypted payload");
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

/**
 * Deterministic SHA-256 (hex, 64 chars) of a CNIC, for the indexed
 * `persons.cnic_hash` lookup column. Non-digits are stripped first so that
 * formatting differences (dashes/spaces) still match the same person.
 */
export function hashCnic(cnic) {
  const normalized = String(cnic ?? "").replace(/\D/g, "");
  return crypto.createHash("sha256").update(normalized).digest("hex");
}
