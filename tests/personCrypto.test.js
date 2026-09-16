import { describe, it, expect } from "vitest";

process.env.PERSON_DATA_ENCRYPTION_KEY =
  "test-person-data-encryption-key-0123456789abcdef";

import { encryptCnic, decryptCnic, hashCnic } from "../src/utils/personCrypto.js";

describe("personCrypto", () => {
  const RAW_CNIC = "35202-1234567-1";

  it("encrypt then decrypt returns the original CNIC", () => {
    const ciphertext = encryptCnic(RAW_CNIC);
    // ciphertext is a versioned payload, not the plaintext
    expect(ciphertext).not.toContain(RAW_CNIC);
    expect(decryptCnic(ciphertext)).toBe(RAW_CNIC);
  });

  it("produces a unique ciphertext on every encryption (random IV)", () => {
    expect(encryptCnic(RAW_CNIC)).not.toBe(encryptCnic(RAW_CNIC));
  });

  it("rejects tampered ciphertext", () => {
    const ciphertext = encryptCnic(RAW_CNIC);
    const parts = ciphertext.split(":");
    parts[3] = Buffer.from("TAMPERED").toString("base64");
    expect(() => decryptCnic(parts.join(":"))).toThrow();
  });

  it("hashes CNICs with/without dashes identically", () => {
    const withDashes = hashCnic("12345-1234567-1");
    const withoutDashes = hashCnic("1234512345671");
    const withSpaces = hashCnic("12345 1234567 1");
    expect(withDashes).toBe(withoutDashes);
    expect(withDashes).toBe(withSpaces);
  });

  it("hash is 64-char lowercase hex and deterministic", () => {
    const hash = hashCnic(RAW_CNIC);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashCnic(RAW_CNIC)).toBe(hash);
  });
});