import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The two public QR endpoints hand a member of the public (a) the facts about a
// verified document and (b) the document itself. Both are unauthenticated; the
// QR token is the entire credential. That makes the failure mode that matters
// "gives something to someone who should not have it", and the one that is easy
// to get wrong is a check that exists on the metadata endpoint but not on the
// file endpoint.
//
// These tests pin:
//   - the SAME fail-closed verdict from both endpoints for a bad token, a
//     tampered signature, and a not-verified request (all 404), with identical
//     bodies so the 404 is not an oracle,
//   - the path-traversal guard, from a poisoned database value as well as from a
//     crafted request, including a symlink out of the root,
//   - PUBLIC_VERIFY_SHOW_DOCUMENT=false turning the document route into a 404,
//   - the response headers, and a CSP with no `sandbox` (which is what stops
//     Chrome displaying a PDF in an <iframe>),
//   - the response shape: masked CNIC, file_type, document_hash, cert code.

const QR_SIGNING_SECRET = "test-signing-secret";
const TOKEN = "a".repeat(64);
const OTHER_TOKEN = "b".repeat(64);
const REQ_UUID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = 5;
const VERIFIED_AT = "2026-09-20 10:00:00";

const hoisted = vi.hoisted(() => {
  // Static imports are evaluated before any top-level statement, and
  // qrCertificate.js / encrypt.js both capture their secrets at module load.
  // vi.hoisted runs before the imports, which is the only place these can be
  // set in time.
  process.env.QR_SIGNING_SECRET = "test-signing-secret";
  process.env.PERSON_DATA_ENCRYPTION_KEY = "test-only-person-data-key";
  // The uploads root is FIXED here, not assigned in beforeEach: the
  // uploadPaths mock factory is evaluated when the module is first imported,
  // which is before any test hook runs, so a path set later would arrive as an
  // empty string and resolve relative to the cwd.
  const nodeOs = require("node:os");
  const nodePath = require("node:path");
  return { root: nodePath.join(nodeOs.tmpdir(), "dverif-public-verify-test") };
});

const ROOT = hoisted.root;
const DOCS = path.join(ROOT, "documents");

vi.mock("../src/config/db.js", () => ({ pool: { query: vi.fn() } }));
vi.mock("../src/config/uploadPaths.js", () => {
  const nodePath = require("node:path");
  const root = hoisted.root;
  return {
    BACKEND_ROOT: root,
    resolveUploadRoot: () => root,
    UPLOAD_ROOT: root,
    DOCS_DIR: nodePath.join(root, "documents"),
    PROFILES_DIR: nodePath.join(root, "profiles"),
    ORGS_DIR: nodePath.join(root, "organizations"),
    ensureUploadDirs: () => ({}),
  };
});

import { pool } from "../src/config/db.js";
import { signQrData } from "../src/utils/qrCertificate.js";
import { encryptCnic } from "../src/utils/personCrypto.js";
import { certificateCodeFor, maskCnic } from "../src/utils/certificateCode.js";
import { classifyPublicDocument, publicVerifyDocumentEnabled } from "../src/utils/publicVerifyGuard.js";
import { resolvePublicDocumentPath } from "../src/utils/publicVerifyGuard.js";
import { verifyPublicQr } from "../src/controllers/verify.controller.js";
import { streamPublicVerifiedDocument } from "../src/controllers/publicDocument.controller.js";

function mockRes() {
  const res = { statusCode: null, body: null, headers: {}, sentFile: null };
  res.status = vi.fn((code) => {
    res.statusCode = code;
    return res;
  });
  res.json = vi.fn((payload) => {
    res.body = payload;
    return res;
  });
  res.setHeader = vi.fn((k, v) => {
    res.headers[k.toLowerCase()] = v;
  });
  res.sendFile = vi.fn((p) => {
    res.sentFile = p;
    return res;
  });
  return res;
}

/** A row that passes every check, with per-test overrides. */
function goodRow(over = {}) {
  return {
    uuid: REQ_UUID,
    document_type: "Degree",
    status: "verified",
    verified_at: VERIFIED_AT,
    qr_token: TOKEN,
    qr_signature: signQrData({
      qrToken: TOKEN,
      requestUuid: REQ_UUID,
      orgId: ORG_ID,
      verifiedAtMillis: new Date(VERIFIED_AT).getTime(),
    }),
    document_path: "uploads/documents/cert_ok.pdf",
    document_format: "pdf",
    document_hash: "f".repeat(64),
    document_owner_name: "Asim Khan",
    linked_person_id: 9,
    issuing_organization_id: ORG_ID,
    unmatched_org_id: null,
    org_name: "Acme University",
    unmatched_org_name: null,
    person_name: "Asim Khan",
    cnic_encrypted: null,
    ...over,
  };
}

/** Answer the guard's single SELECT for `token`, or find nothing. */
function serveRow(row) {
  pool.query.mockImplementation(async (sql, params = []) => {
    if (String(sql).includes("FROM verification_requests")) {
      const found = row(params[0]);
      return found ? [[found]] : [[]];
    }
    return [[]];
  });
}
const serves = (r) => serveRow((t) => (t === TOKEN ? r : null));

async function hitVerify(token = TOKEN, extra = {}) {
  const res = mockRes();
  await verifyPublicQr({ params: { qr_token: token }, ...extra }, res);
  return res;
}
async function hitDocument(token = TOKEN, extra = {}) {
  const res = mockRes();
  await streamPublicVerifiedDocument({ params: { qr_token: token }, ...extra }, res);
  return res;
}

beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(DOCS, { recursive: true });
  for (const n of ["cert_ok.pdf", "cert_ok.png", "cert_ok.docx", "cert_ok.txt", "cert_ok.html"]) {
    fs.writeFileSync(path.join(DOCS, n), "fake-bytes");
  }
  // A file the traversal tests try to reach.
  fs.writeFileSync(path.join(ROOT, "secret.txt"), "TOP SECRET");
  fs.writeFileSync(path.join(os.tmpdir(), "dverif-outside-root.txt"), "OUTSIDE");

  vi.clearAllMocks();
  process.env.QR_SIGNING_SECRET = QR_SIGNING_SECRET;
  process.env.PERSON_DATA_ENCRYPTION_KEY = "test-only-person-data-key";
  delete process.env.PUBLIC_VERIFY_SHOW_DOCUMENT;
});

afterEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.rmSync(path.join(os.tmpdir(), "dverif-outside-root.txt"), { force: true });
  delete process.env.PUBLIC_VERIFY_SHOW_DOCUMENT;
});

// ---------------------------------------------------------------------------
// The headline requirement: both endpoints, same verdict.
// ---------------------------------------------------------------------------

describe("both endpoints fail closed, identically", () => {
  it("404s a token that is not 64 hex characters", async () => {
    serves(goodRow());
    for (const bad of ["", "nope", "a".repeat(63), "a".repeat(65), "z".repeat(64), "../../etc/passwd"]) {
      expect((await hitVerify(bad)).statusCode, `verify ${JSON.stringify(bad)}`).toBe(404);
      expect((await hitDocument(bad)).statusCode, `document ${JSON.stringify(bad)}`).toBe(404);
    }
  });

  it("404s a well-formed token that matches no request", async () => {
    serves(null);
    expect((await hitVerify()).statusCode).toBe(404);
    expect((await hitDocument()).statusCode).toBe(404);
  });

  it("404s a token that is well-formed but belongs to a different request", async () => {
    serves(goodRow());
    expect((await hitVerify(OTHER_TOKEN)).statusCode).toBe(404);
    expect((await hitDocument(OTHER_TOKEN)).statusCode).toBe(404);
  });

  it("404s when the signature has been tampered with", async () => {
    serves(goodRow({ qr_signature: "0".repeat(128) }));
    expect((await hitVerify()).statusCode).toBe(404);
    expect((await hitDocument()).statusCode).toBe(404);
  });

  it("404s when the signature is the wrong length or absent", async () => {
    for (const sig of ["", "abc", "0".repeat(64), "0".repeat(200)]) {
      serves(goodRow({ qr_signature: sig }));
      expect((await hitVerify()).statusCode, `verify len=${sig.length}`).toBe(404);
      expect((await hitDocument()).statusCode, `document len=${sig.length}`).toBe(404);
    }
  });

  it("404s a request that is not verified", async () => {
    for (const status of ["under_review", "unverified"]) {
      serves(goodRow({ status }));
      expect((await hitVerify()).statusCode, `verify ${status}`).toBe(404);
      expect((await hitDocument()).statusCode, `document ${status}`).toBe(404);
    }
  });

  it("404s when the signature is valid but the request uuid does not match", async () => {
    serves(goodRow({ uuid: "22222222-2222-4222-8222-222222222222" }));
    expect((await hitVerify()).statusCode).toBe(404);
    expect((await hitDocument()).statusCode).toBe(404);
  });

  it("404s everything when QR signing is not configured", async () => {
    vi.resetModules();
    process.env.QR_SIGNING_SECRET = "";
    try {
      const guard = await import("../src/utils/publicVerifyGuard.js");
      expect(await guard.loadVerifiedRequestForPublicToken(TOKEN)).toBeNull();
    } finally {
      process.env.QR_SIGNING_SECRET = QR_SIGNING_SECRET;
      vi.resetModules();
    }
  });

  it("returns byte-identical 404 bodies, so the 404 is not an oracle", async () => {
    const bodies = [];
    const cases = [
      [goodRow({ status: "under_review" }), TOKEN],
      [goodRow({ status: "unverified" }), TOKEN],
      [goodRow({ qr_signature: "0".repeat(128) }), TOKEN],
      [null, TOKEN],
      [goodRow(), "short"],
    ];
    for (const [row, token] of cases) {
      serves(row);
      const v = await hitVerify(token);
      const d = await hitDocument(token);
      expect(v.statusCode, token).toBe(404);
      expect(d.statusCode, token).toBe(404);
      bodies.push(JSON.stringify(v.body) + "||" + JSON.stringify(d.body));
    }
    expect(new Set(bodies).size, "bodies differed:\n" + bodies.join("\n")).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe("PUBLIC_VERIFY_SHOW_DOCUMENT", () => {
  it("defaults to enabled", () => {
    delete process.env.PUBLIC_VERIFY_SHOW_DOCUMENT;
    expect(publicVerifyDocumentEnabled()).toBe(true);
  });

  it.each(["false", "FALSE", "0", "no", "off", " false "])("treats %j as off", (v) => {
    process.env.PUBLIC_VERIFY_SHOW_DOCUMENT = v;
    expect(publicVerifyDocumentEnabled()).toBe(false);
  });

  it.each(["true", "1", "yes", "on", "whatever"])("treats %j as on", (v) => {
    process.env.PUBLIC_VERIFY_SHOW_DOCUMENT = v;
    expect(publicVerifyDocumentEnabled()).toBe(true);
  });

  it("404s the document route when disabled but still serves the metadata", async () => {
    process.env.PUBLIC_VERIFY_SHOW_DOCUMENT = "false";
    serves(goodRow({ cnic_encrypted: encryptCnic("4210112345673") }));

    expect((await hitDocument()).statusCode).toBe(404);

    const verify = await hitVerify();
    expect(verify.statusCode).toBe(200);
    expect(verify.body.data.document_available).toBe(false);
    // The hash only exists to support the preview, so it is withheld too.
    expect(verify.body.data.document_hash).toBeNull();
  });

  it("answers a bad token identically when disabled, so it is still not an oracle", async () => {
    process.env.PUBLIC_VERIFY_SHOW_DOCUMENT = "false";
    serves(goodRow());
    const bad = await hitDocument("nope");
    expect(bad.statusCode).toBe(404);
    expect(JSON.stringify(bad.body)).toBe(JSON.stringify({ success: false, message: "Not found" }));
  });
});

// ---------------------------------------------------------------------------

describe("path traversal guard", () => {
  it("resolves a real file inside the documents directory", () => {
    const resolved = resolvePublicDocumentPath("uploads/documents/cert_ok.pdf");
    expect(resolved).toBeTruthy();
    expect(path.basename(String(resolved))).toBe("cert_ok.pdf");
    expect(String(resolved).startsWith(fs.realpathSync(DOCS))).toBe(true);
  });

  it.each([
    "../secret.txt",
    "../../secret.txt",
    "uploads/documents/../../secret.txt",
    "documents/../../secret.txt",
    "../dverif-outside-root.txt",
    "..%2Fsecret.txt",
    "....//secret.txt",
    ".",
    "..",
    "",
    "   ",
    "has space.pdf",
    "semi;colon.pdf",
    "sub/dir/file.pdf",
  ])("refuses %j", (bad) => {
    expect(resolvePublicDocumentPath(bad)).toBeNull();
  });

  it("refuses Windows-style traversal and an absolute path", () => {
    expect(resolvePublicDocumentPath("..\\secret.txt")).toBeNull();
    expect(resolvePublicDocumentPath("..\\..\\secret.txt")).toBeNull();
    expect(resolvePublicDocumentPath("C:\\Windows\\win.ini")).toBeNull();
  });

  it("refuses a directory and a missing file", () => {
    expect(resolvePublicDocumentPath("uploads")).toBeNull();
    expect(resolvePublicDocumentPath("uploads/documents/not_there.pdf")).toBeNull();
  });

  it("refuses a symlink pointing outside the documents directory", () => {
    const link = path.join(DOCS, "escape.pdf");
    try {
      fs.symlinkSync(path.join(ROOT, "secret.txt"), link);
    } catch {
      return; // not permitted here
    }
    // Lexical checks pass; the realpath check is the one that stops it.
    expect(resolvePublicDocumentPath("uploads/documents/escape.pdf")).toBeNull();
  });

  it("the document route 404s rather than reading a file outside the root", async () => {
    for (const p of ["../secret.txt", "../../secret.txt", "/etc/hostname", "..\\secret.txt"]) {
      serves(goodRow({ document_path: p }));
      const res = await hitDocument();
      expect(res.statusCode, p).toBe(404);
      expect(res.sentFile, p).toBeNull();
    }
  });

  it("404s a format outside the preview allow-list", async () => {
    for (const n of ["cert_ok.txt", "cert_ok.html", "cert_ok.zip", "cert_ok.svg", "cert_ok.exe"]) {
      serves(goodRow({ document_path: `uploads/documents/${n}` }));
      const res = await hitDocument();
      expect(res.statusCode, n).toBe(404);
      expect(res.sentFile, n).toBeNull();
    }
  });

  it("classifies by extension, not by anything the file claims", () => {
    expect(classifyPublicDocument("uploads/documents/a.pdf")).toBe("pdf");
    expect(classifyPublicDocument("uploads/documents/a.PDF")).toBe("pdf");
    expect(classifyPublicDocument("uploads/documents/a.png")).toBe("image");
    expect(classifyPublicDocument("uploads/documents/a.jpeg")).toBe("image");
    expect(classifyPublicDocument("uploads/documents/a.docx")).toBe("docx");
    expect(classifyPublicDocument("uploads/documents/a.svg")).toBe("other");
    expect(classifyPublicDocument("uploads/documents/a.pdf.html")).toBe("other");
    expect(classifyPublicDocument(null)).toBe("other");
  });
});

// ---------------------------------------------------------------------------

describe("document response headers", () => {
  it("sends nosniff, private no-store and an inline PDF", async () => {
    serves(goodRow());
    const res = await hitDocument();

    // The handler delegates the 200 to res.sendFile, so success is observed by
    // the file having been sent, not by a status this handler never sets.
    expect(res.sentFile).toBeTruthy();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["cache-control"]).toContain("no-store");
    expect(res.headers["cache-control"]).toContain("private");
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["content-disposition"]).toMatch(/^inline;/);
    expect(res.sentFile).toBeTruthy();
  });

  it("omits a CSP sandbox, which is what breaks Chrome's PDF viewer", async () => {
    serves(goodRow());
    const res = await hitDocument();
    const csp = res.headers["content-security-policy"] || "";
    expect(csp).toBeTruthy();
    expect(csp).not.toMatch(/sandbox/);
    expect(csp).toMatch(/frame-ancestors 'self'/);
    expect(csp).toMatch(/object-src 'self'/);
  });

  it("sends an image inline and a docx as an attachment", async () => {
    serves(goodRow({ document_path: "uploads/documents/cert_ok.png" }));
    const img = await hitDocument();
    expect(img.sentFile).toBeTruthy();
    expect(img.headers["content-type"]).toBe("image/jpeg");
    expect(img.headers["content-disposition"]).toMatch(/^inline;/);

    serves(goodRow({ document_path: "uploads/documents/cert_ok.docx" }));
    const docx = await hitDocument();
    expect(docx.sentFile).toBeTruthy();
    expect(docx.headers["content-type"]).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(docx.headers["content-disposition"]).toMatch(/^attachment;/);
  });

  it("ignores any Content-Type the caller tries to supply", async () => {
    serves(goodRow());
    const res = await hitDocument(TOKEN, {
      headers: { "content-type": "text/html", accept: "text/html" },
      query: { type: "text/html" },
    });
    expect(res.headers["content-type"]).toBe("application/pdf");
  });
});

// ---------------------------------------------------------------------------

describe("metadata response", () => {
  it("includes everything a verifier needs", async () => {
    serves(goodRow({ cnic_encrypted: encryptCnic("4210112345673") }));
    const { data } = (await hitVerify()).body;

    expect(data.valid).toBe(true);
    expect(data.person_name).toBe("Asim Khan");
    expect(data.document_type).toBe("Degree");
    expect(data.organization_name).toBe("Acme University");
    expect(data.cnic_masked).toBe("*****-****567-3");
    expect(data.file_type).toBe("pdf");
    expect(data.document_available).toBe(true);
    expect(data.document_hash).toBe("f".repeat(64));
    expect(data.certificate_code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{5}$/);
    expect(data.verification_date).toBe(new Date(VERIFIED_AT).toISOString());
  });

  it("never returns the full CNIC or the ciphertext", async () => {
    serves(goodRow({ cnic_encrypted: encryptCnic("4210112345673") }));
    const body = JSON.stringify((await hitVerify()).body);
    expect(body).not.toContain("4210112345673");
    expect(body).not.toContain("cnic_encrypted");
  });

  it("omits document_hash for a format that cannot be byte-compared", async () => {
    serves(goodRow({ document_path: "uploads/documents/cert_ok.docx" }));
    const { data } = (await hitVerify()).body;
    expect(data.file_type).toBe("docx");
    expect(data.document_hash).toBeNull();
  });

  it("falls back to the linked person's name", async () => {
    serves(goodRow({ document_owner_name: null, person_name: "Stored Name" }));
    expect((await hitVerify()).body.data.person_name).toBe("Stored Name");
  });

  it("survives an undecryptable CNIC without failing the request", async () => {
    serves(goodRow({ cnic_encrypted: "not-a-valid-payload" }));
    const res = await hitVerify();
    expect(res.statusCode).toBe(200);
    expect(res.body.data.cnic_masked).toBeNull();
    expect(res.body.data.person_name).toBe("Asim Khan");
  });

  it("never leaks the document path, the token or the signature", async () => {
    serves(goodRow());
    const body = JSON.stringify((await hitVerify()).body);
    expect(body).not.toContain("uploads/documents");
    expect(body).not.toContain(TOKEN);
    expect(body).not.toContain("qr_token");
    expect(body).not.toContain("qr_signature");
  });

  it("reports file_type null and the card unavailable for an unpreviewable format", async () => {
    serves(goodRow({ document_path: "uploads/documents/cert_ok.txt" }));
    const { data } = (await hitVerify()).body;
    expect(data.file_type).toBeNull();
    expect(data.document_available).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("maskCnic", () => {
  it("keeps the last four digits in standard CNIC grouping", () => {
    expect(maskCnic("4210112345673")).toBe("*****-****567-3");
    expect(maskCnic("42101-1234567-3")).toBe("*****-****567-3");
    expect(maskCnic(" 4210112345673 ")).toBe("*****-****567-3");
  });

  it("reveals exactly four of the thirteen digits", () => {
    expect(String(maskCnic("4210112345673")).replace(/\D/g, "").length).toBe(4);
  });

  it("refuses anything that is not a 13-digit CNIC", () => {
    for (const bad of ["", null, undefined, "123", "12345678901234", "abcdefghijklm"]) {
      expect(maskCnic(bad), String(bad)).toBeNull();
    }
  });
});

describe("certificateCodeFor", () => {
  it("is stable for a token and formatted XXXX-XXXXX", () => {
    const a = certificateCodeFor(TOKEN);
    expect(a).toBe(certificateCodeFor(TOKEN));
    expect(a).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{5}$/);
  });

  it("differs between tokens and avoids ambiguous letters", () => {
    expect(certificateCodeFor(TOKEN)).not.toBe(certificateCodeFor(OTHER_TOKEN));
    expect(certificateCodeFor(TOKEN)).not.toMatch(/[ILOU]/);
  });

  it("returns null without a valid token", () => {
    expect(certificateCodeFor("")).toBeNull();
    expect(certificateCodeFor("nope")).toBeNull();
    expect(certificateCodeFor("a".repeat(63))).toBeNull();
  });
});
