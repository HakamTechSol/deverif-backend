import { describe, it, expect, vi } from "vitest";

vi.mock("../src/config/db.js", () => ({ pool: { query: vi.fn() } }));

process.env.QR_SIGNING_SECRET = "test-secret-for-qr-tamper-check-0123456789abcdef";

const { signQrData, verifyQrSignature } = await import("../src/utils/qrCertificate.js");
import crypto from "crypto";

const base = {
  qrToken: crypto.randomBytes(32).toString("hex"),
  requestUuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  orgId: 38,
  verifiedAtMillis: 1755700000000,
};

describe("QR certificate HMAC", () => {
  it("accepts a legitimately signed token", () => {
    const sig = signQrData(base);
    expect(verifyQrSignature({ ...base, signature: sig })).toBe(true);
  });

  it("rejects a tampered token (payload altered after signing)", () => {
    const sig = signQrData(base);
    const tamperedToken =
      base.qrToken.slice(0, -1) +
      (base.qrToken.endsWith("a") ? "b" : "a");
    expect(
      verifyQrSignature({ ...base, qrToken: tamperedToken, signature: sig })
    ).toBe(false);
  });

  it("rejects a tampered org id binding", () => {
    const sig = signQrData(base);
    expect(verifyQrSignature({ ...base, orgId: 39, signature: sig })).toBe(false);
  });

  it("rejects a tampered verified_at binding", () => {
    const sig = signQrData(base);
    expect(
      verifyQrSignature({ ...base, verifiedAtMillis: base.verifiedAtMillis + 1, signature: sig })
    ).toBe(false);
  });

  it("rejects a forged signature produced with a different secret", () => {
    const forged = crypto
      .createHmac("sha256", "attacker-secret")
      .update(`${base.qrToken}:${base.requestUuid}:${base.orgId}:${base.verifiedAtMillis}`)
      .digest("hex");
    expect(verifyQrSignature({ ...base, signature: forged })).toBe(false);
  });

  it("rejects truncated / malformed signatures", () => {
    const sig = signQrData(base);
    expect(verifyQrSignature({ ...base, signature: sig.slice(0, 62) })).toBe(false);
    expect(verifyQrSignature({ ...base, signature: "zz" + sig.slice(2) })).toBe(false);
    expect(verifyQrSignature({ ...base, signature: "" })).toBe(false);
  });
});
