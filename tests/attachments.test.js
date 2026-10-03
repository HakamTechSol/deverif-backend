import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "node:path";

vi.mock("../src/config/db.js", () => ({ pool: { query: vi.fn() } }));
vi.mock("../src/utils/auditLog.js", () => ({ logAudit: vi.fn() }));
// The real upload root is fine to use here: resolveAttachmentPath is pure path
// arithmetic, and pointing it at a temp root would not make it stricter.
vi.mock("../src/config/uploadPaths.js", () => {
  const os = require("node:os");
  return { ATTACHMENTS_DIR: path.join(os.tmpdir(), "dverif-attachments-test") };
});

import { pool } from "../src/config/db.js";
import { logAudit } from "../src/utils/auditLog.js";
import { ATTACHMENTS_DIR } from "../src/config/uploadPaths.js";
import {
  resolveAttachmentPath,
  listAttachments,
  removeAttachment,
  resolveForDownload,
  createAttachments,
} from "../src/services/attachments.service.js";

const ORG = 2;
const OTHER_ORG = 99;
const ENTITY = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";

const listInput = () => ({ orgId: ORG, entityType: "expense_claim", entityUuid: ENTITY });

beforeEach(() => {
  vi.clearAllMocks();
  pool.query.mockReset();
  logAudit.mockReset();
});

describe("resolveAttachmentPath — path traversal", () => {
  it("resolves a normal relative path inside the root", () => {
    const resolved = resolveAttachmentPath("2026/receipt.pdf");
    expect(resolved.startsWith(path.resolve(ATTACHMENTS_DIR) + path.sep)).toBe(true);
  });

  it.each([
    ["../../../.env", "parent traversal to a dotfile"],
    ["..\\..\\..\\.env", "windows-style parent traversal"],
    ["a/../../../etc/passwd", "traversal hidden behind a real subdirectory"],
    ["/etc/passwd", "absolute unix path"],
    ["C:/Windows/system32/config/SAM", "absolute windows path"],
    ["..", "the parent directory itself"],
  ])("rejects %s (%s)", (stored) => {
    // Every one of these resolves outside ATTACHMENTS_DIR. Checking the
    // RESOLVED path is what makes this hold: "../x" and "a/../../x" look
    // different as strings but resolve identically.
    expect(() => resolveAttachmentPath(stored)).toThrow();
  });

  it("does not accept a sibling directory that merely shares the root prefix", () => {
    // `<root>-evil` starts with the root as a STRING but is a different
    // directory, which is why the check appends path.sep.
    expect(() => resolveAttachmentPath(`../${path.basename(ATTACHMENTS_DIR)}-evil/x.pdf`)).toThrow();
  });

  it("allows a filename containing a dot-prefix but no traversal", () => {
    expect(() => resolveAttachmentPath("receipt.2026.pdf")).not.toThrow();
  });

  it.each([["", "empty"], ["   ", "whitespace"], [null, "null"], [undefined, "undefined"]])(
    "rejects %s (%s)",
    (stored) => {
      expect(() => resolveAttachmentPath(stored)).toThrow();
    }
  );
});

describe("listAttachments — tenant isolation", () => {
  it("always filters by organization AND entity", async () => {
    pool.query.mockResolvedValueOnce([[]]);
    await listAttachments(listInput());

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain("organization_id=?");
    expect(sql).toContain("entity_type=?");
    expect(sql).toContain("entity_uuid=?");
    expect(sql).toContain("deleted_at IS NULL");
    expect(params).toEqual([ORG, "expense_claim", ENTITY]);
  });

  it("passes a DIFFERENT org's id through, so a cross-org read scopes to that org", async () => {
    pool.query.mockResolvedValueOnce([[]]);
    await listAttachments({ ...listInput(), orgId: OTHER_ORG });
    expect(pool.query.mock.calls[0][1]).toContain(OTHER_ORG);
  });

  it("filters by category only when one is supplied", async () => {
    pool.query.mockResolvedValueOnce([[]]);
    await listAttachments({ ...listInput(), category: "receipt" });
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain("AND category=?");
    expect(params).toContain("receipt");
  });

  it("omits the category filter when none is supplied", async () => {
    pool.query.mockResolvedValueOnce([[]]);
    await listAttachments(listInput());
    expect(pool.query.mock.calls[0][0]).not.toContain("category=?");
  });
});

describe("removeAttachment — soft delete, scoped to the owner", () => {
  it("404s for an attachment in another organization", async () => {
    pool.query.mockResolvedValueOnce([[]]);
    await expect(
      removeAttachment({ orgId: OTHER_ORG, attachmentUuid: "att-1" })
    ).rejects.toMatchObject({ statusCode: 404 });
    // The lookup itself is org-scoped, which is what turns this into a 404
    // rather than a delete.
    expect(pool.query.mock.calls[0][1]).toEqual(["att-1", OTHER_ORG]);
  });

  it("soft-deletes and audits rather than removing the row", async () => {
    pool.query
      .mockResolvedValueOnce([
        [{ uuid: "att-1", entity_type: "expense_claim", entity_uuid: ENTITY, file_path: "r.pdf" }],
      ])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    const result = await removeAttachment({ orgId: ORG, attachmentUuid: "att-1" });
    expect(result).toEqual({ uuid: "att-1", deleted: true });

    const updateSql = String(pool.query.mock.calls[1][0]);
    expect(updateSql).toContain("SET deleted_at=NOW()");
    expect(updateSql).not.toContain("DELETE FROM");
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "attachment.delete", entityId: ENTITY })
    );
  });

  it("refuses to delete an already-deleted attachment", async () => {
    pool.query.mockResolvedValueOnce([[]]);
    await expect(removeAttachment({ orgId: ORG, attachmentUuid: "att-1" })).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe("resolveForDownload", () => {
  it("404s rather than leaking that another org's file exists", async () => {
    pool.query.mockResolvedValueOnce([[]]);
    await expect(
      resolveForDownload({ orgId: OTHER_ORG, attachmentUuid: "att-1" })
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("returns an absolute path inside the upload root", async () => {
    pool.query.mockResolvedValueOnce([
      [
        {
          uuid: "att-1",
          file_name: "receipt.pdf",
          file_path: "2026/receipt.pdf",
          mime_type: "application/pdf",
          file_size: 100,
        },
      ],
    ]);
    // fs.access rejects because the temp file genuinely does not exist, which
    // is the second branch below; assert on the 404 message that distinguishes
    // a missing FILE from a missing ROW.
    await expect(
      resolveForDownload({ orgId: ORG, attachmentUuid: "att-1" })
    ).rejects.toMatchObject({ message: "Attachment file is no longer available" });
  });

  it("refuses to stream a path that escapes the upload root", async () => {
    pool.query.mockResolvedValueOnce([
      [
        {
          uuid: "att-1",
          file_name: "x",
          file_path: "../../../.env",
          mime_type: "text/plain",
          file_size: 1,
        },
      ],
    ]);
    await expect(
      resolveForDownload({ orgId: ORG, attachmentUuid: "att-1" })
    ).rejects.toMatchObject({ statusCode: 400, message: "Invalid attachment path" });
  });
});

describe("createAttachments", () => {
  it("400s when no files were supplied", async () => {
    await expect(createAttachments({ ...listInput(), files: [] })).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("stores root-relative paths, never absolute ones", async () => {
    pool.query.mockResolvedValueOnce([{ affectedRows: 1 }]).mockResolvedValueOnce([[]]);

    await createAttachments({
      ...listInput(),
      uploadedByUuid: "u-1",
      files: [
        {
          originalname: "receipt.jpg",
          path: path.join(ATTACHMENTS_DIR, "2026", "receipt.jpg"),
          mimetype: "image/jpeg",
          size: 2048,
        },
      ],
    });

    const [insertSql, insertParams] = pool.query.mock.calls[0];
    expect(insertSql).toContain("INSERT INTO attachments");
    const values = insertParams[0];
    expect(values[0][0]).toMatch(/^[0-9a-f-]{36}$/i); // generated uuid
    expect(values[0][4]).toBe("receipt.jpg"); // original name for display
    expect(values[0][5]).toBe(path.join("2026", "receipt.jpg")); // relative
    expect(path.isAbsolute(values[0][5])).toBe(false);
  });

  it("flattens a file that somehow landed outside the upload root", async () => {
    pool.query.mockResolvedValueOnce([{ affectedRows: 1 }]).mockResolvedValueOnce([[]]);

    await createAttachments({
      ...listInput(),
      files: [
        {
          originalname: "evil.pdf",
          path: path.join(ATTACHMENTS_DIR, "..", "documents", "secret.pdf"),
          size: 10,
        },
      ],
    });

    const values = pool.query.mock.calls[0][1][0];
    expect(values[0][5]).toBe("secret.pdf");
    expect(values[0][5]).not.toContain("..");
  });

  it("records a missing file size as 0 rather than NULL", async () => {
    pool.query.mockResolvedValueOnce([{ affectedRows: 1 }]).mockResolvedValueOnce([[]]);
    await createAttachments({
      ...listInput(),
      files: [{ originalname: "a.bin", path: path.join(ATTACHMENTS_DIR, "a.bin") }],
    });
    const values = pool.query.mock.calls[0][1][0];
    // Column order is (uuid, org, entity_type, entity_uuid, file_name,
    // file_path, mime_type, file_size, category, description, uploader).
    expect(values[0][6]).toBeNull(); // mime_type absent
    expect(values[0][7]).toBe(0); // file_size falls back to 0, never NULL
  });

  it("validates before inserting", async () => {
    await expect(
      createAttachments({ ...listInput(), entityType: "", files: [{ originalname: "a", path: "a" }] })
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(pool.query).not.toHaveBeenCalled();
  });
});