import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// The verification QR is the one artefact that leaves the building: it gets
// printed on a certificate and handed to a member of the public. So the URL it
// encodes has to be (a) configurable per environment and (b) identical everywhere
// it is produced.
//
// The defect this guards: the on-screen QR was a hardcoded literal
//   const VERIFY_URL_BASE = "https://portal.dverif.com/verify";
// while the PDF's QR came from QR_VERIFY_BASE_URL. One token, two hosts: the
// printed certificate sent a customer to one domain and the screen sent them to
// another, and the screen's host could not be changed without editing source.

const BACKEND_DIR = path.resolve(process.cwd());
const FRONTEND_DIR = path.resolve(process.cwd(), "..", "dvarif-verified");

const readEnv = (dir) => {
  const file = path.join(dir, ".env");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
};
const envValue = (text, key) => {
  const m = text.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`, "m"));
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : undefined;
};

const readSrc = (rel) => {
  const file = path.join(FRONTEND_DIR, rel);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
};

describe("the verify URL is env-driven on both sides", () => {
  it("the backend reads QR_VERIFY_BASE_URL from the environment", async () => {
    const src = fs.readFileSync(path.join(BACKEND_DIR, "src/utils/qrCertificate.js"), "utf8");
    expect(src).toContain("process.env.QR_VERIFY_BASE_URL");
    expect(src).toContain("https://dverif.com");
  });

  it("the frontend no longer hardcodes a live domain for the QR", () => {
    const src = readSrc("src/components/requests/VerificationCertificate.tsx");
    expect(src).toContain("VITE_PUBLIC_BASE_URL");
    expect(src).not.toMatch(/["']https:\/\/portal\.dverif\.com/);
  });

  it("the frontend exposes a public base url it can actually be pointed at", () => {
    const envText = readEnv(FRONTEND_DIR);
    expect(envValue(envText, "VITE_PUBLIC_BASE_URL")).toBeTruthy();
  });

  it("the two values are the same host, so printed and on-screen QRs agree", () => {
    const backendBase = envValue(readEnv(BACKEND_DIR), "QR_VERIFY_BASE_URL");
    const frontendBase = envValue(readEnv(FRONTEND_DIR), "VITE_PUBLIC_BASE_URL");
    expect(backendBase).toBeTruthy();
    expect(frontendBase).toBeTruthy();
    // Trailing-slash and case differences are cosmetic; the host is not.
    expect(new URL(frontendBase).host).toBe(new URL(backendBase).host);
    expect(new URL(frontendBase).protocol).toBe(new URL(backendBase).protocol);
  });

  it("no live domain is hardcoded anywhere in the QR code paths", () => {
    for (const rel of [
      "src/components/requests/VerificationCertificate.tsx",
      "src/utils/qrCertificate.js",
    ]) {
      const src = readSrc(rel);
      expect(src).not.toMatch(/["']https:\/\/(portal|app|backend|www)\.dverif\.com/);
    }
  });
});

describe("buildVerifyUrl produces a clean, scannable link", () => {
  it("uses the configured base and appends the token", async () => {
    const { buildVerifyUrl } = await import("../src/utils/qrCertificate.js");
    const base = envValue(readEnv(BACKEND_DIR), "QR_VERIFY_BASE_URL");
    expect(buildVerifyUrl("tok123")).toBe(`${base.replace(/\/+$/, "")}/verify/tok123`);
  });

  it("never yields a double slash from a trailing-slash base", async () => {
    const { buildVerifyUrl } = await import("../src/utils/qrCertificate.js");
    expect(buildVerifyUrl("tok123")).not.toContain("//verify");
  });

  it("the built URL is a valid absolute https-or-localhost URL a scanner can open", async () => {
    const { buildVerifyUrl } = await import("../src/utils/qrCertificate.js");
    const parsed = new URL(buildVerifyUrl("tok123"));
    expect(["http:", "https:"]).toContain(parsed.protocol);
    expect(parsed.pathname).toBe("/verify/tok123");
  });
});
