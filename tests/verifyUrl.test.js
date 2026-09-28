import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

// The verification link is the one string in this product that leaves the
// building: it gets printed on a certificate and handed to a member of the
// public. So it has to be (a) configurable per environment, and (b) identical
// everywhere it is produced.
//
// The defect this used to guard: the on-screen QR was built in the browser from
// the frontend's own VITE_PUBLIC_BASE_URL while the PDF's QR came from the
// backend's QR_VERIFY_BASE_URL. One token, two hosts -- the printed certificate
// sent a customer to one domain and the screen sent them to another, and the
// screen's host could not be changed without editing source.
//
// That is no longer possible to get wrong by omission: the backend builds the
// URL once, returns it as `verify_url` on the request, and the frontend renders
// that field verbatim. The assertions below pin both halves of that -- the
// helper's behaviour, and the absence of any second builder.

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

const ORIGINAL = process.env.QR_VERIFY_BASE_URL;

beforeEach(() => {
  process.env.QR_VERIFY_BASE_URL = "http://localhost:8080";
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.QR_VERIFY_BASE_URL;
  else process.env.QR_VERIFY_BASE_URL = ORIGINAL;
  vi.restoreAllMocks();
});

describe("resolveVerifyBaseUrl", () => {
  it("returns the configured value", async () => {
    const { resolveVerifyBaseUrl } = await import("../src/utils/qrCertificate.js");
    expect(resolveVerifyBaseUrl()).toBe("http://localhost:8080");
  });

  it("strips a single trailing slash", async () => {
    const { resolveVerifyBaseUrl } = await import("../src/utils/qrCertificate.js");
    process.env.QR_VERIFY_BASE_URL = "http://localhost:8080/";
    expect(resolveVerifyBaseUrl()).toBe("http://localhost:8080");
  });

  it("strips repeated trailing slashes", async () => {
    const { resolveVerifyBaseUrl } = await import("../src/utils/qrCertificate.js");
    process.env.QR_VERIFY_BASE_URL = "https://www.dverif.com///";
    expect(resolveVerifyBaseUrl()).toBe("https://www.dverif.com");
  });

  it("keeps a path prefix, only trimming the trailing slash", async () => {
    const { resolveVerifyBaseUrl } = await import("../src/utils/qrCertificate.js");
    process.env.QR_VERIFY_BASE_URL = "https://example.com/dverif/";
    expect(resolveVerifyBaseUrl()).toBe("https://example.com/dverif");
  });

  it("tolerates surrounding whitespace", async () => {
    const { resolveVerifyBaseUrl } = await import("../src/utils/qrCertificate.js");
    process.env.QR_VERIFY_BASE_URL = "  https://www.dverif.com  ";
    expect(resolveVerifyBaseUrl()).toBe("https://www.dverif.com");
  });

  // A missing value used to fall back to a live-looking default, so a deploy
  // that forgot it kept working and kept printing live-domain QRs -- the
  // mistake stayed invisible until someone scanned one.
  it("throws when unset rather than falling back to a real domain", async () => {
    const { resolveVerifyBaseUrl } = await import("../src/utils/qrCertificate.js");
    delete process.env.QR_VERIFY_BASE_URL;
    expect(() => resolveVerifyBaseUrl()).toThrow(/QR_VERIFY_BASE_URL is not set/);
  });

  it("throws when set to an empty or whitespace value", async () => {
    const { resolveVerifyBaseUrl } = await import("../src/utils/qrCertificate.js");
    for (const bad of ["", "   "]) {
      process.env.QR_VERIFY_BASE_URL = bad;
      expect(() => resolveVerifyBaseUrl()).toThrow(/QR_VERIFY_BASE_URL is not set/);
    }
  });

  it("throws on a relative value, naming what is wrong", async () => {
    const { resolveVerifyBaseUrl } = await import("../src/utils/qrCertificate.js");
    process.env.QR_VERIFY_BASE_URL = "dverif.com";
    expect(() => resolveVerifyBaseUrl()).toThrow(/not an absolute URL/);
  });

  it("throws on a non-http(s) scheme", async () => {
    const { resolveVerifyBaseUrl } = await import("../src/utils/qrCertificate.js");
    for (const bad of ["ftp://example.com", "javascript:alert(1)"]) {
      process.env.QR_VERIFY_BASE_URL = bad;
      expect(() => resolveVerifyBaseUrl()).toThrow(/must use http or https/);
    }
  });

  it("rejects a base carrying a query string or fragment, which the join would drop", async () => {
    const { resolveVerifyBaseUrl } = await import("../src/utils/qrCertificate.js");
    process.env.QR_VERIFY_BASE_URL = "https://example.com/?a=1";
    expect(() => resolveVerifyBaseUrl()).toThrow(/query string or fragment/);
    process.env.QR_VERIFY_BASE_URL = "https://example.com/#x";
    expect(() => resolveVerifyBaseUrl()).toThrow(/query string or fragment/);
  });

  it("names the offending value in the error, so a bad .env is obvious", async () => {
    const { resolveVerifyBaseUrl } = await import("../src/utils/qrCertificate.js");
    process.env.QR_VERIFY_BASE_URL = "dverif.com";
    expect(() => resolveVerifyBaseUrl()).toThrow(/dverif\.com/);
  });
});

describe("buildVerifyUrl", () => {
  it("joins base + /verify/ + token", async () => {
    const { buildVerifyUrl } = await import("../src/utils/qrCertificate.js");
    expect(buildVerifyUrl("tok123")).toBe("http://localhost:8080/verify/tok123");
  });

  it("never emits a double slash from a trailing-slash base", async () => {
    const { buildVerifyUrl } = await import("../src/utils/qrCertificate.js");
    for (const base of ["http://localhost:8080/", "http://localhost:8080//"]) {
      process.env.QR_VERIFY_BASE_URL = base;
      const url = buildVerifyUrl("tok123");
      expect(url).not.toContain("//verify");
      expect(url).toBe("http://localhost:8080/verify/tok123");
    }
  });

  it("is an absolute http(s) URL a scanner can open", async () => {
    const { buildVerifyUrl } = await import("../src/utils/qrCertificate.js");
    const parsed = new URL(buildVerifyUrl("tok123"));
    expect(["http:", "https:"]).toContain(parsed.protocol);
    expect(parsed.pathname).toBe("/verify/tok123");
  });

  it("refuses to build a link with no token", async () => {
    const { buildVerifyUrl } = await import("../src/utils/qrCertificate.js");
    for (const bad of ["", null, undefined]) {
      expect(() => buildVerifyUrl(bad)).toThrow(/requires a qrToken/);
    }
  });

  it("tracks the environment: change it and every link moves together", async () => {
    const { buildVerifyUrl } = await import("../src/utils/qrCertificate.js");
    expect(buildVerifyUrl("t")).toBe("http://localhost:8080/verify/t");
    process.env.QR_VERIFY_BASE_URL = "https://www.dverif.com";
    expect(buildVerifyUrl("t")).toBe("https://www.dverif.com/verify/t");
  });
});

describe("withVerifyUrl / withVerifyUrls", () => {
  it("attaches verify_url to a row that has a token", async () => {
    const { withVerifyUrl } = await import("../src/utils/qrCertificate.js");
    const row = { uuid: "u", status: "verified", qr_token: "abc" };
    expect(withVerifyUrl(row).verify_url).toBe("http://localhost:8080/verify/abc");
  });

  it("leaves a row without a token untouched, so no dead link is advertised", async () => {
    const { withVerifyUrl } = await import("../src/utils/qrCertificate.js");
    for (const row of [{ uuid: "u", status: "under_review" }, { uuid: "u", qr_token: null }, null, undefined]) {
      expect(withVerifyUrl(row)).toBe(row);
    }
  });

  it("does not mutate the input row", async () => {
    const { withVerifyUrl } = await import("../src/utils/qrCertificate.js");
    const row = { uuid: "u", qr_token: "abc" };
    withVerifyUrl(row);
    expect("verify_url" in row).toBe(false);
  });

  it("maps a list, skipping tokenless rows", async () => {
    const { withVerifyUrls } = await import("../src/utils/qrCertificate.js");
    const out = withVerifyUrls([
      { uuid: "a", qr_token: "t1" },
      { uuid: "b" },
      { uuid: "c", qr_token: "t3" },
    ]);
    expect(out[0].verify_url).toBe("http://localhost:8080/verify/t1");
    expect("verify_url" in out[1]).toBe(false);
    expect(out[2].verify_url).toBe("http://localhost:8080/verify/t3");
  });

  it("passes a non-array through unchanged", async () => {
    const { withVerifyUrls } = await import("../src/utils/qrCertificate.js");
    expect(withVerifyUrls(null)).toBeNull();
    expect(withVerifyUrls(undefined)).toBeUndefined();
  });
});

describe("assertVerifyBaseUrlConfigured", () => {
  it("returns true when the value is usable", async () => {
    const { assertVerifyBaseUrlConfigured } = await import("../src/utils/qrCertificate.js");
    expect(assertVerifyBaseUrlConfigured()).toBe(true);
  });

  it("warns and continues outside production", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { assertVerifyBaseUrlConfigured } = await import("../src/utils/qrCertificate.js");
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    delete process.env.QR_VERIFY_BASE_URL;
    try {
      expect(assertVerifyBaseUrlConfigured()).toBe(false);
      expect(warn).toHaveBeenCalled();
      expect(String(warn.mock.calls[0][0])).toMatch(/QR_VERIFY_BASE_URL/);
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
  });

  it("throws in production, so a bad deploy cannot start", async () => {
    const { assertVerifyBaseUrlConfigured } = await import("../src/utils/qrCertificate.js");
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    delete process.env.QR_VERIFY_BASE_URL;
    try {
      expect(() => assertVerifyBaseUrlConfigured()).toThrow(/Refusing to start/);
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
  });
});

describe("one source of truth", () => {
  const backendSrc = (rel) => fs.readFileSync(path.join(BACKEND_DIR, "src", rel), "utf8");
  const frontendSrc = (rel) => {
    const file = path.join(FRONTEND_DIR, "src", rel);
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  };

  it("reads the base from the environment, with no hardcoded fallback domain", () => {
    const src = backendSrc("utils/qrCertificate.js");
    expect(src).toContain("process.env.QR_VERIFY_BASE_URL");
    // The old fallback was a live hostname, which is what made a forgotten
    // setting invisible.
    expect(src).not.toMatch(/["']https?:\/\/[a-z0-9.-]*dverif/);
  });

  it("builds the string in exactly one backend module", () => {
    const files = [
      "utils/qrCertificate.js",
      "utils/certificatePdf.js",
      "controllers/verification.controller.js",
      "controllers/admin/verification.controller.js",
      "controllers/certificate.controller.js",
    ];
    for (const f of files) {
      const src = backendSrc(f);
      // Anyone joining "/verify" by hand is reintroducing a second builder.
      expect(src, f).not.toMatch(/`\$\{[^}]+\}\/verify\//);
    }
  });

  it("has the PDF import the shared builder rather than rebuilding it", () => {
    const pdf = backendSrc("utils/certificatePdf.js");
    expect(pdf).toMatch(/import \{[^}]*buildVerifyUrl[^}]*\} from "\.\/qrCertificate\.js"/);
    expect(pdf).toContain("buildVerifyUrl(request.qr_token)");
  });

  it("does not hardcode the verify host in the PDF prose", () => {
    // It used to be fixed text naming the production domain, which is wrong on
    // every other deploy.
    const pdf = backendSrc("utils/certificatePdf.js");
    expect(pdf).not.toMatch(/dverif\.com/i);
    // ...and now takes the host from the URL it already built.
    expect(pdf).toContain("new URL(verifyUrl).host");
  });

  it("gives the frontend no base URL of its own", () => {
    expect(frontendSrc("lib/verifyUrl.ts")).toBe("");
    for (const rel of [
      "components/requests/VerificationCertificate.tsx",
      "components/common/RequestSubmittedModal.tsx",
      "routes/verify.$qrToken.tsx",
      "services/index.ts",
    ]) {
      const src = frontendSrc(rel);
      expect(src, rel).not.toMatch(/VITE_PUBLIC_BASE_URL\s*[),]/);
      expect(src, rel).not.toMatch(/["']https?:\/\/[a-z0-9.-]*dverif/i);
    }
  });

  it("renders the backend's verify_url rather than assembling one", () => {
    expect(frontendSrc("components/requests/VerificationCertificate.tsx")).toContain("request.verify_url");
    expect(frontendSrc("components/common/RequestSubmittedModal.tsx")).toContain("request.verify_url");
  });

  it("validates the value at startup, outside the DB try/catch", () => {
    const server = backendSrc("server.js");
    expect(server).toContain("assertVerifyBaseUrlConfigured");
    // It must not sit inside the boot try, or a bad URL would be reported as
    // "DB connection failed".
    const idx = server.indexOf("assertVerifyBaseUrlConfigured()");
    const tryIdx = server.indexOf("(async () =>");
    expect(idx).toBeGreaterThan(-1);
    expect(idx).toBeLessThan(tryIdx);
  });

  it("configures a usable base in the checked-in env", () => {
    const base = envValue(readEnv(BACKEND_DIR), "QR_VERIFY_BASE_URL");
    expect(base).toBeTruthy();
    expect(() => new URL(base)).not.toThrow();
  });
});
