import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isDocumentAllowed } from "../src/middleware/uploadDocs.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.resolve(here, "../../dvarif-verified");

/** Pull the extension list out of the backend allow-list source. */
function backendAllowedExtensions() {
  const src = fs.readFileSync(
    path.resolve(here, "../src/middleware/uploadDocs.js"),
    "utf8"
  );
  const block = src.match(/const allowedExt = \[([\s\S]*?)\];/);
  if (!block) throw new Error("allowedExt block not found in uploadDocs.js");
  return [...block[1].matchAll(/"(\.[a-z0-9]+)"/g)].map((m) => m[1]).sort();
}

/** Pull UPLOADABLE_DOC_EXTENSIONS out of the shared frontend constant. */
function frontendAllowedExtensions() {
  const src = fs.readFileSync(
    path.join(FRONTEND_ROOT, "src/lib/documentTypes.ts"),
    "utf8"
  );
  const block = src.match(/UPLOADABLE_DOC_EXTENSIONS = \[([\s\S]*?)\] as const;/);
  if (!block) throw new Error("UPLOADABLE_DOC_EXTENSIONS not found in documentTypes.ts");
  return [...block[1].matchAll(/"(\.[a-z0-9]+)"/g)].map((m) => m[1]).sort();
}

describe("upload allow-list consistency", () => {
  it("frontend and backend accept exactly the same extensions", () => {
    expect(frontendAllowedExtensions()).toEqual(backendAllowedExtensions());
  });

  it("covers the formats the product advertises", () => {
    const exts = backendAllowedExtensions();
    for (const required of [".pdf", ".png", ".docx", ".jpg", ".jpeg"]) {
      expect(exts).toContain(required);
    }
  });
});

describe("isDocumentAllowed — representative uploads", () => {
  const cases = [
    ["cv.pdf", "application/pdf", true],
    ["photo.png", "image/png", true],
    ["photo.jpg", "image/jpeg", true],
    ["photo.jpeg", "image/jpeg", true],
    ["doc.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", true],
    ["doc.doc", "application/msword", true],
    ["sheet.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", true],
    ["sheet.xls", "application/vnd.ms-excel", true],
    ["notes.txt", "text/plain", true],
    ["data.csv", "text/csv", true],
    ["bundle.zip", "application/zip", true],
    ["photo.webp", "image/webp", true],
    ["photo.gif", "image/gif", true],
    ["photo.bmp", "image/bmp", true],
    // Generic blob marker tolerated for allow-listed extensions.
    ["cv.pdf", "application/octet-stream", true],
  ];

  for (const [name, mime, expected] of cases) {
    it(`${expected ? "accepts" : "rejects"} ${name} (${mime})`, () => {
      expect(isDocumentAllowed(name, mime)).toBe(expected);
    });
  }

  it("rejects an executable renamed to .pdf", () => {
    expect(isDocumentAllowed("virus.pdf", "application/x-msdownload")).toBe(false);
  });

  it("rejects a disallowed extension even with a plausible mime", () => {
    expect(isDocumentAllowed("payload.exe", "application/pdf")).toBe(false);
  });

  it("rejects an allowed extension with no mime at all", () => {
    expect(isDocumentAllowed("cv.pdf", "")).toBe(false);
  });
});
