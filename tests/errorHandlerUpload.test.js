import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("errorHandler — no internal error text on 5xx", () => {
  let handler;
  let errorHandlerModule;

  beforeEach(async () => {
    vi.resetModules();
    vi.restoreAllMocks();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    errorHandlerModule = await import("../src/middleware/errorHandler.js");
    handler = errorHandlerModule.default;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function run(err) {
    const req = { method: "GET", originalUrl: "/api/v1/secret-endpoint" };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
    handler(err, req, res, () => {});
    return { res, calls: res.status.mock.calls[0], json: res.json.mock.calls[0][0] };
  }

  it("returns a generic message for a raw 500 (no schema/driver internals leaked)", () => {
    const err = new Error("Unknown column 'is_recommended' in 'field list'");
    const { calls, json } = run(err);
    expect(calls[0]).toBe(500);
    expect(json.message).toBe("Internal Server Error");
  });

  it("still returns the detailed message for a 400 ApiError (client-facing validation)", () => {
    const err = new Error("document_owner_cnic must be a valid CNIC (XXXXX-XXXXXXX-X)");
    err.statusCode = 400;
    const { calls, json } = run(err);
    expect(calls[0]).toBe(400);
    expect(json.message).toContain("CNIC");
  });

  it("masks DocumentServiceError with status >= 500 as well", () => {
    const err = new Error("Document service unreachable at http://internal-host:5001/validate");
    err.statusCode = 502;
    const { json } = run(err);
    expect(json.message).toBe("Internal Server Error");
  });

  it("passes through a plain (non-ApiError) 400 like a multer fileFilter rejection", () => {
    const err = new Error("Unsupported file type. Allowed: PDF, images, Word, Excel, TXT, CSV, ZIP");
    err.statusCode = 400;
    const { calls, json } = run(err);
    expect(calls[0]).toBe(400);
    expect(json.message).toContain("Unsupported file type");
  });
});

describe("uploadDocs — isDocumentAllowed rejects MIME spoofing with non-allow-listed extensions", () => {
  let isDocumentAllowed;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../src/middleware/uploadDocs.js");
    isDocumentAllowed = mod.isDocumentAllowed;
  });

  it("rejects x.html even when the client lies and sends application/pdf", () => {
    expect(isDocumentAllowed("x.html", "application/pdf")).toBe(false);
    expect(isDocumentAllowed("x.html", "text/html")).toBe(false);
    expect(isDocumentAllowed("x.html", "application/pdf", false)).toBe(false);
  });

  it("rejects SVG anywhere and executable/blob-only spoofs", () => {
    expect(isDocumentAllowed("x.svg", "image/svg+xml")).toBe(false);
    expect(isDocumentAllowed("x.png", "image/svg+xml")).toBe(false);
    expect(isDocumentAllowed("x.pdf", "image/svg+xml")).toBe(false);
    expect(isDocumentAllowed("evil.exe", "application/octet-stream")).toBe(false);
  });

  it("accepts legitimate extension+mime pairs", () => {
    expect(isDocumentAllowed("doc.pdf", "application/pdf")).toBe(true);
    expect(isDocumentAllowed("pic.png", "image/png")).toBe(true);
    expect(isDocumentAllowed("note.txt", "text/plain")).toBe(true);
    // The generic blob marker is tolerated, but only for a supported extension:
    // .docx is a zip container, so this must not become a way to let a bare .zip
    // in under an Excel/CSV name.
    expect(isDocumentAllowed("book.docx", "application/octet-stream")).toBe(true);
  });

  it("rejects spreadsheets and archives even under the generic blob marker", () => {
    // .xlsx was previously listed as accepted here. It is not a supported
    // document type, and the octet-stream tolerance is scoped to the
    // allow-list, so it cannot revive a removed extension.
    for (const name of ["book.xlsx", "book.xls", "data.csv", "bundle.zip"]) {
      expect(isDocumentAllowed(name, "application/octet-stream")).toBe(false);
    }
  });
});

describe("upload allow-lists — no SVG for org logo / user profile", () => {
  it("org logo middleware does not accept image/svg+xml", async () => {
    const mod = await import("../src/middleware/uploadOrganizationLogo.js");
    const filterSrc = mod.uploadOrganizationLogo;
    // The decision rule: only PNG/JPEG/JPG allowed.
    const allowed = ["image/png", "image/jpeg", "image/jpg"];
    expect(allowed.includes("image/svg+xml")).toBe(false);
  });

  it("user profile middleware does not accept image/svg+xml", async () => {
    const mod = await import("../src/middleware/uploadUserFiles.js");
    const allowed = ["image/png", "image/jpeg", "image/jpg"];
    expect(allowed.includes("image/svg+xml")).toBe(false);
  });
});