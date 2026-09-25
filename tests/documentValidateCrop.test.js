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

import { assertDocumentValid } from "../src/utils/documentValidate.js";

const FILE = "/tmp/doc.pdf";

beforeEach(() => {
  vi.resetAllMocks();
});

describe("assertDocumentValid — cropped documents", () => {
  it("rejects a cropped document with the detector's own reason", async () => {
    h.validateMock.mockResolvedValue({
      success: true,
      data: {
        valid: true,
        reason: null,
        file_type: "pdf",
        cropped: true,
        crop_reason: "Content runs off the top edge of the scan — the document looks cropped",
        crop_score: 0.42,
      },
    });

    await expect(assertDocumentValid(FILE)).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("cropped"),
    });
  });

  it("falls back to a generic message when the detector gives no reason", async () => {
    h.validateMock.mockResolvedValue({
      success: true,
      data: { valid: true, cropped: true, crop_reason: null, crop_score: 0.5 },
    });

    await expect(assertDocumentValid(FILE)).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("cropped"),
    });
  });

  it("accepts a clean document", async () => {
    h.validateMock.mockResolvedValue({
      success: true,
      data: { valid: true, reason: null, file_type: "pdf", cropped: false, crop_score: 0 },
    });

    await expect(assertDocumentValid(FILE)).resolves.toMatchObject({ cropped: false });
  });
});

describe("assertDocumentValid — pre-existing behaviour is preserved", () => {
  it("still rejects a corrupt file", async () => {
    h.validateMock.mockResolvedValue({
      success: true,
      data: { valid: false, reason: "Image is corrupt", file_type: "jpeg" },
    });

    await expect(assertDocumentValid(FILE)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("fails open when the service times out", async () => {
    h.validateMock.mockRejectedValue(
      new h.FakeDocumentServiceError(503, "timed out", { kind: "timeout" })
    );
    await expect(assertDocumentValid(FILE)).resolves.toBeNull();
  });

  it("fails open when the service is unreachable", async () => {
    h.validateMock.mockRejectedValue(
      new h.FakeDocumentServiceError(502, "refused", { kind: "connection" })
    );
    await expect(assertDocumentValid(FILE)).resolves.toBeNull();
  });

  it("fails closed on any other service failure", async () => {
    h.validateMock.mockRejectedValue(
      new h.FakeDocumentServiceError(500, "boom", { kind: "http" })
    );
    await expect(assertDocumentValid(FILE)).rejects.toMatchObject({ statusCode: 400 });
  });
});
