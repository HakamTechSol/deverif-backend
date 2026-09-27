import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock factories are hoisted above imports, so the mock fn and the error
// class they close over must be created with vi.hoisted too.
const h = vi.hoisted(() => {
  class FakeDocumentServiceError extends Error {
    constructor(statusCode, message, { kind = "generic" } = {}) {
      super(message);
      this.name = "DocumentServiceError";
      this.kind = kind;
      this.statusCode = statusCode;
    }
  }
  return { validateMock: vi.fn(), FakeDocumentServiceError };
});

vi.mock("../src/services/documentService.js", () => ({
  validate: (p) => h.validateMock(p),
  DocumentServiceError: h.FakeDocumentServiceError,
}));

import {
  assertDocumentValid,
  VALIDATION_PASSED,
  VALIDATION_FLAGGED,
  VALIDATION_UNVALIDATED,
} from "../src/utils/documentValidate.js";

const FILE = "/tmp/doc.pdf";

/** A verdict the tiered service returns. */
function serviceSays(overrides = {}) {
  return {
    success: true,
    data: {
      valid: true,
      reason: null,
      file_type: "pdf",
      check_type: "structural",
      cropped: false,
      crop_reason: null,
      crop_score: 0,
      ...overrides,
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// structural: a hard fact about the bytes. Must always block.
// ---------------------------------------------------------------------------

describe("assertDocumentValid — structural failures are always a hard block", () => {
  it("rejects a corrupt file", async () => {
    h.validateMock.mockResolvedValue(
      serviceSays({ valid: false, check_type: "structural", reason: "PDF is truncated (missing %%EOF marker)" })
    );

    await expect(assertDocumentValid(FILE)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("surfaces the service's own reason to the user", async () => {
    h.validateMock.mockResolvedValue(
      serviceSays({ valid: false, check_type: "structural", reason: "PDF is truncated (missing %%EOF marker)" })
    );

    await expect(assertDocumentValid(FILE)).rejects.toThrow(/missing %%EOF marker/);
  });

  it("still hard-blocks a MIME-spoofed file (HTML announced as PDF)", async () => {
    // The security-audit case. HTML bytes, .pdf filename, application/pdf type.
    // If this ever softens into a flag, a file lying about its own type would
    // become a reviewable request.
    h.validateMock.mockResolvedValue(
      serviceSays({
        valid: false,
        check_type: "structural",
        file_type: "text",
        reason: "File type mismatch: declared content type 'application/pdf' but content is TEXT",
      })
    );

    await expect(assertDocumentValid(FILE)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("blocks a spoofed file even when a heuristic is ALSO present on the payload", async () => {
    // Defence in depth: structural is checked first and throws regardless of
    // anything else on the payload, so no extra signal can launder the file.
    h.validateMock.mockResolvedValue(
      serviceSays({
        valid: false,
        check_type: "structural",
        cropped: true,
        crop_reason: "Content runs off the top edge",
        reason: "File type mismatch",
      })
    );

    await expect(assertDocumentValid(FILE)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("treats a missing check_type on an invalid file as structural, not heuristic", async () => {
    // An older service has no tier field. The safe default for an unidentifiable
    // failure is the hard block — never a flag.
    h.validateMock.mockResolvedValue({
      success: true,
      data: { valid: false, reason: "Image is corrupt", file_type: "jpeg" },
    });

    await expect(assertDocumentValid(FILE)).rejects.toMatchObject({ statusCode: 400 });
  });
});

// ---------------------------------------------------------------------------
// heuristic: a quality judgement. Flagged, never blocked.
// ---------------------------------------------------------------------------

describe("assertDocumentValid — heuristic failures are flagged, not blocked", () => {
  it("resolves a flagged verdict for a cropped document instead of throwing", async () => {
    h.validateMock.mockResolvedValue(
      serviceSays({
        valid: false,
        check_type: "heuristic",
        cropped: true,
        crop_score: 0.42,
        reason: "Content runs off the left edge of the scan — the document looks cropped",
        crop_reason: "Content runs off the left edge of the scan — the document looks cropped",
      })
    );

    const result = await assertDocumentValid(FILE);
    expect(result.status).toBe(VALIDATION_FLAGGED);
    expect(result.checkType).toBe("heuristic");
  });

  it("carries the service's message so the reviewer sees the actual measurement", async () => {
    const message = "The scan is under-exposed: brightest pixel 214/255";
    h.validateMock.mockResolvedValue(
      serviceSays({
        valid: false,
        check_type: "heuristic",
        cropped: true,
        reason: message,
        crop_reason: message,
      })
    );

    const result = await assertDocumentValid(FILE);
    expect(result.reason).toBe(message);
  });

  it("falls back to crop_reason when reason is absent", async () => {
    h.validateMock.mockResolvedValue(
      serviceSays({
        valid: false,
        check_type: "heuristic",
        cropped: true,
        reason: null,
        crop_reason: "Content runs off the top edge",
      })
    );

    const result = await assertDocumentValid(FILE);
    expect(result.reason).toBe("Content runs off the top edge");
  });

  it("supplies an explanation when the service flags without saying why", async () => {
    // A badge with no reason is worse than useless to a reviewer.
    h.validateMock.mockResolvedValue(
      serviceSays({ valid: false, check_type: "heuristic", cropped: true, reason: null, crop_reason: null })
    );

    const result = await assertDocumentValid(FILE);
    expect(result.status).toBe(VALIDATION_FLAGGED);
    expect(result.reason).toBeTruthy();
    expect(result.reason.trim().length).toBeGreaterThan(0);
  });

  it("flags the darkness/low-contrast verdict too", async () => {
    h.validateMock.mockResolvedValue(
      serviceSays({
        valid: false,
        check_type: "heuristic",
        file_type: "jpeg",
        cropped: true,
        reason: "The scan is under-exposed: no pixel is bright enough to be paper",
      })
    );

    const result = await assertDocumentValid(FILE);
    expect(result.status).toBe(VALIDATION_FLAGGED);
    expect(result.reason).toMatch(/under-exposed/);
  });
});

// ---------------------------------------------------------------------------
// clean pass
// ---------------------------------------------------------------------------

describe("assertDocumentValid — a clean document passes", () => {
  it("reports passed for a structurally clean file", async () => {
    h.validateMock.mockResolvedValue(serviceSays());

    const result = await assertDocumentValid(FILE);
    expect(result.status).toBe(VALIDATION_PASSED);
    expect(result.reason).toBeNull();
  });

  it("reports passed whatever tier a clean file is tagged with", async () => {
    h.validateMock.mockResolvedValue(serviceSays({ check_type: "heuristic" }));

    const result = await assertDocumentValid(FILE);
    // valid:true is a pass whatever the tier says.
    expect(result.status).toBe(VALIDATION_PASSED);
  });
});

// ---------------------------------------------------------------------------
// rolling deploy: an older service with no tier field
// ---------------------------------------------------------------------------

describe("assertDocumentValid — compatibility with a pre-tier service", () => {
  it("still flags the old valid:true + cropped:true signal", async () => {
    // Before tiering, the only way the service could say "quality problem" was
    // valid:true alongside cropped:true. Dropping that would silently lose the
    // warning mid-deploy, so it is mapped onto the heuristic tier.
    h.validateMock.mockResolvedValue({
      success: true,
      data: { valid: true, file_type: "pdf", cropped: true, crop_reason: "Looks cropped", crop_score: 0.4 },
    });

    const result = await assertDocumentValid(FILE);
    expect(result.status).toBe(VALIDATION_FLAGGED);
    expect(result.checkType).toBe("heuristic");
    expect(result.reason).toBe("Looks cropped");
  });

  it("still hard-blocks a corrupt file reported by the old service", async () => {
    h.validateMock.mockResolvedValue({
      success: true,
      data: { valid: false, reason: "Image is corrupt", file_type: "jpeg" },
    });

    await expect(assertDocumentValid(FILE)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("still passes a clean file reported by the old service", async () => {
    h.validateMock.mockResolvedValue({
      success: true,
      data: { valid: true, file_type: "pdf", cropped: false },
    });

    const result = await assertDocumentValid(FILE);
    expect(result.status).toBe(VALIDATION_PASSED);
  });
});

// ---------------------------------------------------------------------------
// service ERRORS: layered on top of the tiers, orthogonal to them
// ---------------------------------------------------------------------------

describe("assertDocumentValid — service errors (unchanged fail-open / fail-closed split)", () => {
  it("fails open when the service times out, recording that nothing was checked", async () => {
    h.validateMock.mockRejectedValue(new h.FakeDocumentServiceError(503, "timed out", { kind: "timeout" }));

    const result = await assertDocumentValid(FILE);
    // NOT 'passed': the file was never validated, and recording it as a clean
    // pass would be a lie a reviewer could not detect.
    expect(result.status).toBe(VALIDATION_UNVALIDATED);
    expect(result.reason).toBeNull();
  });

  it("fails open when the service is unreachable", async () => {
    h.validateMock.mockRejectedValue(new h.FakeDocumentServiceError(502, "refused", { kind: "connection" }));

    const result = await assertDocumentValid(FILE);
    expect(result.status).toBe(VALIDATION_UNVALIDATED);
  });

  it("fails closed on any other service failure", async () => {
    h.validateMock.mockRejectedValue(new h.FakeDocumentServiceError(500, "boom", { kind: "http" }));
    await expect(assertDocumentValid(FILE)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("fails closed on a malformed payload", async () => {
    h.validateMock.mockRejectedValue(
      new h.FakeDocumentServiceError(500, "unexpected payload", { kind: "generic" })
    );
    await expect(assertDocumentValid(FILE)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("fails closed when the service returns an unsuccessful envelope", async () => {
    h.validateMock.mockResolvedValue({ success: false, data: null });

    await expect(assertDocumentValid(FILE)).rejects.toMatchObject({ statusCode: 400 });
  });
});
