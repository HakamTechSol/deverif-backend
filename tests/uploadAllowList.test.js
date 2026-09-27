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
    ["notes.txt", "text/plain", true],
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

// ---------------------------------------------------------------------------
// Archives and spreadsheets must not be uploadable, under ANY mime label.
//
// The AND-check is the whole defence, so these cases have to sweep the mime
// space rather than test one "typical" spoof. A single matrix entry that
// slipped through would mean a client could pick the filename and the label
// together and walk an arbitrary archive past the filter.
// ---------------------------------------------------------------------------

describe("isDocumentAllowed — zip/Excel/CSV are rejected regardless of the claimed mime", () => {
  const BANNED_EXTENSIONS = [".zip", ".xlsx", ".xls", ".csv"];

  // Every mime that could plausibly be attached to a banned extension, plus the
  // ones an attacker would reach for to disguise it.
  const SPOOF_MIMES = [
    "application/zip",
    "application/x-zip-compressed",
    "application/octet-stream",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel",
    "text/csv",
    "application/csv",
    "text/plain",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/pdf",
    "image/png",
    "", // no mime at all
  ];

  for (const ext of BANNED_EXTENSIONS) {
    for (const mime of SPOOF_MIMES) {
      it(`rejects "report${ext}" claiming "${mime || "(no mime)"}"`, () => {
        expect(isDocumentAllowed(`report${ext}`, mime)).toBe(false);
      });
    }
  }

  it("rejects the banned extensions even with a correctly-matching mime", () => {
    // The honest case, not just the spoofed ones: these formats are simply not
    // supported, so the "right" mime does not earn them a pass.
    expect(isDocumentAllowed("archive.zip", "application/zip")).toBe(false);
    expect(isDocumentAllowed("sheet.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe(false);
    expect(isDocumentAllowed("sheet.xls", "application/vnd.ms-excel")).toBe(false);
    expect(isDocumentAllowed("data.csv", "text/csv")).toBe(false);
  });

  it("rejects banned extensions in mixed case and with extra dots", () => {
    // path.extname + toLowerCase normalise both, so these must not be a bypass.
    expect(isDocumentAllowed("ARCHIVE.ZIP", "application/zip")).toBe(false);
    expect(isDocumentAllowed("data.CsV", "text/csv")).toBe(false);
    expect(isDocumentAllowed("report.final.ZIP", "application/octet-stream")).toBe(false);
  });

  it("still accepts a real .docx, so restricting the container did not break Word", () => {
    // The counterweight to every rejection above: the format that IS a zip has
    // to keep working, otherwise the filter has removed a supported type.
    expect(isDocumentAllowed("letter.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe(true);
    // And with the generic blob marker, which real browsers do send.
    expect(isDocumentAllowed("letter.docx", "application/octet-stream")).toBe(true);
  });
});

describe("the banned extensions are absent from both allow-lists", () => {
  it("backend allow-list excludes them", () => {
    for (const ext of [".zip", ".xlsx", ".xls", ".csv"]) {
      expect(backendAllowedExtensions()).not.toContain(ext);
    }
  });

  it("frontend picker list excludes them", () => {
    for (const ext of [".zip", ".xlsx", ".xls", ".csv"]) {
      expect(frontendAllowedExtensions()).not.toContain(ext);
    }
  });

  it("the human-readable label no longer advertises them", () => {
    const src = fs.readFileSync(
      path.join(FRONTEND_ROOT, "src/lib/documentTypes.ts"),
      "utf8"
    );
    const label = src.match(/UPLOADABLE_DOC_LABEL = "([^"]+)"/);
    expect(label).toBeTruthy();
    // A label still saying "CSV or ZIP" would promise users a picker that then
    // rejects their file.
    for (const word of ["ZIP", "CSV", "Excel", "XLS"]) {
      expect(label[1]).not.toContain(word);
    }
  });
});
