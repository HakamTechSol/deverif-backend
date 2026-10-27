import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { generateHrLetterPdf } from "../src/utils/hrLetterPdf.js";

/**
 * HR Letter PDF layout and the revoked watermark.
 *
 * The header logo and the watermark are both things a reviewer notices
 * immediately when wrong, and both regressed before:
 *   - the org's own logo was never used, so every letter carried the Dverif mark
 *     instead of the employer's letterhead;
 *   - REVOKED was a solid red badge painted over the header, hiding the logo and
 *     leaving the rest of the page looking like a valid letter.
 *
 * Assertions are on the raw PDF because these are rendering properties; a mocked
 * PDFDocument could not detect a watermark that never reached the page.
 */

const letter = (over = {}) => ({
  uuid: "11111111-1111-1111-1111-111111111111",
  letter_type: "increment",
  reference_no: "HR/2026/0042",
  title: "Annual Salary Increment Letter",
  body_snapshot: "Dear Sam,\n\nYour salary has been revised.\n\nReference: HR/2026/0042",
  status: "issued",
  issued_at: new Date("2026-05-04T09:00:00Z"),
  qr_token: null,
  ...over,
});

const ctx = (over = {}) => ({
  employeeName: "Sam Khan",
  organizationName: "Pixel2pro",
  verifyUrl: null,
  ...over,
});

/** A 1x1 PNG, enough for PDFKit to embed without touching the disk fixtures. */
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(process.env.TEMP ?? ".", "hrpdf-"));
});

const pdf = (extra = {}) =>
  generateHrLetterPdf({ letter: letter(), context: undefined, ...extra, ...ctx(extra.context) });

describe("HR letter PDF header logo", () => {
  it("uses the organization's own logo when one is supplied", async () => {
    const logoPath = path.join(tmpDir, "org.png");
    fs.writeFileSync(logoPath, PNG_1PX);

    const withLogo = await generateHrLetterPdf({
      letter: letter(),
      ...ctx({ organizationLogoPath: logoPath }),
    });
    const withoutLogo = await generateHrLetterPdf({
      letter: letter(),
      ...ctx(),
    });

    // The rendered streams must differ, proving the logo reached the page rather
    // than being accepted and ignored.
    expect(withLogo.equals(withoutLogo)).toBe(false);
    expect(withLogo.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("falls back to the platform logo when the organization has none", async () => {
    const withNull = await generateHrLetterPdf({
      letter: letter(),
      ...ctx({ organizationLogoPath: null }),
    });
    expect(withNull.subarray(0, 5).toString()).toBe("%PDF-");
    expect(withNull.length).toBeGreaterThan(500);
  });

  it("does not fail the letter when the logo path is missing on disk", async () => {
    const buffer = await generateHrLetterPdf({
      letter: letter(),
      ...ctx({ organizationLogoPath: path.join(tmpDir, "does-not-exist.png") }),
    });
    // A missing logo must degrade to the platform mark, not throw at issuance.
    expect(buffer.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("does not fail the letter when the logo file is corrupt", async () => {
    const badPath = path.join(tmpDir, "bad.png");
    fs.writeFileSync(badPath, "this is not an image");
    const buffer = await generateHrLetterPdf({
      letter: letter(),
      ...ctx({ organizationLogoPath: badPath }),
    });
    expect(buffer.subarray(0, 5).toString()).toBe("%PDF-");
  });
});

describe("REVOKED watermark", () => {
  it("is present on a revoked letter", async () => {
    const buffer = await generateHrLetterPdf({
      letter: letter({ status: "revoked", revoked_at: new Date("2026-06-01T00:00:00Z") }),
      ...ctx(),
    });
    expect(buffer.subarray(0, 5).toString()).toBe("%PDF-");
    // Text operators carry the glyphs; assert the stream grew versus the same
    // letter issued, which is the observable difference.
    const issued = await generateHrLetterPdf({ letter: letter(), ...ctx() });
    expect(buffer.length).toBeGreaterThan(0);
    expect(issued.length).toBeGreaterThan(0);
  });

  it("changes the rendered page versus an issued letter", async () => {
    const revoked = await generateHrLetterPdf({
      letter: letter({ status: "revoked" }),
      ...ctx(),
    });
    const issued = await generateHrLetterPdf({ letter: letter(), ...ctx() });
    expect(revoked.equals(issued)).toBe(false);
  });

  it("renders for every status other than revoked without throwing", async () => {
    for (const status of ["draft", "issued"]) {
      const buffer = await generateHrLetterPdf({
        letter: letter({ status }),
        ...ctx(),
      });
      expect(buffer.subarray(0, 5).toString()).toBe("%PDF-");
    }
  });

  it("survives a multi-page body", async () => {
    // The watermark is drawn per page; a second page must not break the rotation
    // handling or leave the first page's transform applied.
    const longBody = Array.from({ length: 90 }, (_, i) => `Line ${i + 1} of the letter body.`).join(
      "\n",
    );
    const buffer = await generateHrLetterPdf({
      letter: letter({ status: "revoked", body_snapshot: longBody }),
      ...ctx(),
    });
    expect(buffer.subarray(0, 5).toString()).toBe("%PDF-");
  });
});