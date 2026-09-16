/**
 * CNIC-specific encryption + hashing helpers.
 *
 * Thin wrapper around ./encrypt.js so callers get intent-revealing names
 * without duplicating any logic.
 */

import { encrypt, decrypt, hashCnic } from "./encrypt.js";

/**
 * Encrypt a raw CNIC string with AES-256-GCM.
 * Returns the versioned payload string safe for VARCHAR(500) storage.
 */
export function encryptCnic(rawCnic) {
  return encrypt(rawCnic);
}

/**
 * Decrypt a payload produced by encryptCnic() back to the original CNIC string.
 */
export function decryptCnic(ciphertext) {
  return decrypt(ciphertext);
}

/**
 * Deterministic SHA-256 hex hash of a normalized CNIC.
 * Non-digit characters (dashes, spaces) are stripped before hashing so that
 * "12345-1234567-1" and "1234512345671" produce the same 64-char hash.
 */
export { hashCnic };
