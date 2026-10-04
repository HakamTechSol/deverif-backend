import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Asset files go through the polymorphic attachments table, not path columns.
 *
 * WHY THIS IS ASSERTED RATHER THAN ASSUMED. The module originally carried
 * receipt_path and invoice_path columns on `assets` and `asset_maintenance`.
 * Those look equivalent and are not. An attachment row buys four things a bare
 * path column does not:
 *
 *   1. TENANT ISOLATION. attachments filters organization_id on every query; a
 *      column on `assets` has nothing to filter.
 *   2. PATH-TRAVERSAL DEFENCE. resolveAttachmentPath re-anchors a stored path
 *      against ATTACHMENTS_DIR. A caller-supplied path has no such guard.
 *   3. SOFT DELETE, so a mistaken removal leaves a tombstone.
 *   4. AN AUDIT ENTRY per upload.
 *
 * The most dangerous property here is the FIRST one on the upload path: before
 * the ownership check, attachments.entity_uuid carries no foreign key (it points
 * at a different table per entity_type), so nothing else stops an upload being
 * attached to another organization's asset. That check is what these tests hold
 * in place.
 */
vi.mock("../src/config/db.js", () => ({
  pool: { query: vi.fn(), getConnection: vi.fn() },
}));
vi.mock("../src/utils/auditLog.js", () => ({ logAudit: vi.fn() }));

const attachmentsService = await import("../src/services/attachments.service.js");
const { pool } = await import("../src/config/db.js");
const assets = await import("../src/services/assets.service.js");

const ORG = 3;
const OTHER_ORG = 88;
const ADMIN = "11111111-1111-4111-8111-111111111111";
const ASSET = "33333333-3333-4333-8333-333333333333";
const JOB = "55555555-5555-4555-8555-555555555555";
const ATTACH = "66666666-6666-4666-8666-666666666666";

const assetRow = (over = {}) => ({
  uuid: ASSET,
  organization_id: ORG,
  category_uuid: "22222222-2222-4222-8222-222222222222",
  asset_tag: "AST-0001",
  name: "ThinkPad",
  status: "available",
  ...over,
});

const file = (name = "receipt.pdf") => ({
  originalname: name,
  path: `C:\\uploads\\attachments\\att_1_${name}`,
  mimetype: "application/pdf",
  size: 1200,
});

beforeEach(() => {
  pool.query.mockReset();
  vi.clearAllMocks();
});

describe("asset receipts", () => {
  it("records the receipt against the asset entity, not a path column", async () => {
    const create = vi.spyOn(attachmentsService, "createAttachments").mockResolvedValue([{ uuid: ATTACH }]);
    pool.query = vi.fn(async (sql) => {
      if (String(sql).includes("FROM assets a")) return [[assetRow()], []];
      if (String(sql).includes("FROM asset_assignments")) return [[], []];
      if (String(sql).includes("FROM asset_maintenance")) return [[], []];
      return [[], []];
    });

    const rows = await assets.attachReceipt({
      orgId: ORG,
      actorUuid: ADMIN,
      assetUuid: ASSET,
      files: [file()],
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG,
        entityType: "asset",
        entityUuid: ASSET,
        category: "purchase_receipt",
      }),
    );
    expect(rows).toHaveLength(1);
  });

  it("refuses to attach to an asset this organization cannot see", async () => {
    // The FK cannot do this: entity_uuid references a different table per
    // entity_type, so only this ownership check prevents cross-tenant uploads.
    const create = vi.spyOn(attachmentsService, "createAttachments");
    pool.query = vi.fn(async () => [[], []]);

    await expect(
      assets.attachReceipt({ orgId: ORG, actorUuid: ADMIN, assetUuid: ASSET, files: [file()] }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(create).not.toHaveBeenCalled();
  });

  it("scopes the ownership lookup to the organization", async () => {
    vi.spyOn(attachmentsService, "createAttachments").mockResolvedValue([]);
    pool.query = vi.fn(async (sql) => {
      if (String(sql).includes("FROM assets a")) return [[assetRow()], []];
      return [[], []];
    });

    await assets.attachReceipt({
      orgId: OTHER_ORG,
      actorUuid: ADMIN,
      assetUuid: ASSET,
      files: [file()],
    });

    const lookup = pool.query.mock.calls.find(([sql]) => String(sql).includes("FROM assets a"));
    expect(lookup[1]).toEqual([ASSET, OTHER_ORG]);
  });
});

describe("maintenance invoices", () => {
  it("records invoices against the maintenance entity", async () => {
    const create = vi.spyOn(attachmentsService, "createAttachments").mockResolvedValue([{ uuid: ATTACH }]);
    pool.query = vi.fn(async (sql) => {
      if (String(sql).includes("FROM asset_maintenance WHERE uuid")) return [[{ uuid: JOB }], []];
      return [[], []];
    });

    await assets.attachInvoice({ orgId: ORG, actorUuid: ADMIN, jobUuid: JOB, files: [file("invoice.pdf")] });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: "asset_maintenance",
        entityUuid: JOB,
        category: "maintenance_invoice",
      }),
    );
  });

  it("refuses an invoice against another organization's job", async () => {
    const create = vi.spyOn(attachmentsService, "createAttachments");
    pool.query = vi.fn(async () => [[], []]);

    await expect(
      assets.attachInvoice({ orgId: OTHER_ORG, actorUuid: ADMIN, jobUuid: JOB, files: [file()] }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(create).not.toHaveBeenCalled();
  });
});

describe("attachment deletion", () => {
  it("will not delete a file that is not an asset attachment", async () => {
    // entity_type is free-form, so an attachment belonging to, say, an expense
    // claim must not be removable through the asset routes.
    const remove = vi.spyOn(attachmentsService, "removeAttachment");
    pool.query = vi.fn(async () => [
      [{ uuid: ATTACH, entity_type: "expense_claim", entity_uuid: ASSET }],
      [],
    ]);

    await expect(
      assets.removeAssetAttachment({ orgId: ORG, actorUuid: ADMIN, attachmentUuid: ATTACH }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(remove).not.toHaveBeenCalled();
  });

  it("will not delete a receipt off an asset in another organization", async () => {
    const remove = vi.spyOn(attachmentsService, "removeAttachment");
    pool.query = vi.fn(async (sql) => {
      if (String(sql).includes("FROM attachments")) {
        return [[{ uuid: ATTACH, entity_type: "asset", entity_uuid: ASSET }], []];
      }
      // The asset is not visible in this org.
      return [[], []];
    });

    await expect(
      assets.removeAssetAttachment({ orgId: OTHER_ORG, actorUuid: ADMIN, attachmentUuid: ATTACH }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(remove).not.toHaveBeenCalled();
  });

  it("scopes the attachment lookup by organization before deleting", async () => {
    const remove = vi.spyOn(attachmentsService, "removeAttachment").mockResolvedValue({ deleted: true });
    pool.query = vi.fn(async (sql) => {
      const s = String(sql);
      if (s.includes("FROM attachments")) return [[{ uuid: ATTACH, entity_type: "asset", entity_uuid: ASSET }], []];
      if (s.includes("FROM assets a")) return [[assetRow()], []];
      return [[], []];
    });

    await assets.removeAssetAttachment({ orgId: ORG, actorUuid: ADMIN, attachmentUuid: ATTACH });

    const lookup = pool.query.mock.calls.find(([sql]) => String(sql).includes("FROM attachments"));
    expect(lookup[1]).toEqual([ATTACH, ORG]);
    expect(remove).toHaveBeenCalled();
  });

  it("404s rather than 403 for another organization's file", async () => {
    // Existence itself is not disclosed: a 403 would confirm the uuid is real.
    pool.query = vi.fn(async () => [[], []]);
    await expect(
      assets.removeAssetAttachment({ orgId: OTHER_ORG, actorUuid: ADMIN, attachmentUuid: ATTACH }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("asset detail", () => {
  it("includes receipts and per-job invoices", async () => {
    vi.spyOn(attachmentsService, "listAttachments").mockImplementation(async ({ entityType, entityUuid }) => {
      if (entityType === "asset") return [{ uuid: ATTACH, file_name: "receipt.pdf" }];
      return entityUuid === JOB ? [{ uuid: ATTACH, file_name: "invoice.pdf" }] : [];
    });

    pool.query = vi.fn(async (sql) => {
      const s = String(sql);
      if (s.includes("FROM assets a")) return [[assetRow()], []];
      if (s.includes("FROM asset_assignments g")) return [[], []];
      if (s.includes("FROM asset_maintenance")) return [[{ uuid: JOB, status: "open" }], []];
      return [[], []];
    });

    const asset = await assets.getAsset({ orgId: ORG, assetUuid: ASSET });
    expect(asset.receipts).toHaveLength(1);
    expect(asset.maintenance[0].invoices).toHaveLength(1);
  });

  it("still returns custody history when an attachment lookup fails", async () => {
    // A 500 here would blank the whole asset page over a missing invoice.
    vi.spyOn(attachmentsService, "listAttachments").mockRejectedValue(new Error("attachments down"));

    pool.query = vi.fn(async (sql) => {
      const s = String(sql);
      if (s.includes("FROM assets a")) return [[assetRow()], []];
      if (s.includes("FROM asset_assignments g")) {
        return [[{ uuid: "g1", employee_uuid: EMPLOYEE_UUID, employee_name: "Kinza", returned_at: null }], []];
      }
      if (s.includes("FROM asset_maintenance")) return [[], []];
      return [[], []];
    });

    const asset = await assets.getAsset({ orgId: ORG, assetUuid: ASSET });
    expect(asset.receipts).toEqual([]);
    expect(asset.holder.employee_name).toBe("Kinza");
  });
});

const EMPLOYEE_UUID = "44444444-4444-4444-8444-444444444444";

describe("schema", () => {
  it("no longer carries receipt_path or invoice_path columns", () => {
    const sql = require("node:fs").readFileSync("src/services/assets.service.js", "utf8");
    // The only mentions left should be in prose explaining why they are gone.
    const code = sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\*.*$/gm, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/receipt_path/);
    expect(code).not.toMatch(/invoice_path/);
  });
});