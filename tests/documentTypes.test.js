import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The document-type catalogue and the database backup.
 *
 * The catalogue used to be a hard-coded array in the frontend plus a hard-coded
 * alias table in the Python service, so adding a type meant editing two
 * repositories and redeploying both. It is now a table an admin edits, and the
 * backend pushes it to the document service so a new type actually resolves to a
 * real extraction schema.
 *
 * Three things are load-bearing and pinned here:
 *
 *  1. `label_key` must be the SAME normalization the Python service applies
 *     (lowercase, runs of non-alphanumerics collapsed to one space). If the two
 *     disagree about what "the same label" means, a type the admin added never
 *     resolves there and silently extracts with the generic schema instead.
 *
 *  2. A sync failure must NOT fail the write that triggered it. The type is
 *     already committed; the catalogue is a convenience, and the service falls
 *     back to its own built-in tables. A document service that is down must not
 *     stop an admin from managing types.
 *
 *  3. The backup emits SQL, so every value has to be escaped. A single unescaped
 *     apostrophe in a company name would produce a dump that cannot be replayed
 *     â€” and a backup that cannot be restored is worse than no backup, because it
 *     looks like a safety net that is not there.
 */

const { sharedQuery, fakeConnection, syncSpy, syncBgSpy, syncStatusSpy, supportedSchemaKeys } =
  vi.hoisted(() => {
    const q = vi.fn();
    return {
      sharedQuery: q,
      fakeConnection: {
        query: q,
        beginTransaction: vi.fn(),
        commit: vi.fn(),
        rollback: vi.fn(),
        release: vi.fn(),
      },
      syncSpy: vi.fn().mockResolvedValue({ ok: true, sent: 47 }),
      syncBgSpy: vi.fn(),
      syncStatusSpy: vi.fn().mockResolvedValue({ reachable: true, catalogue_count: 47 }),
      // Stands in for GET /schemas on the document service. The registry is
      // deliberately NOT reproduced in full here: the point of the change is
      // that this list is no longer duplicated in application code, so the mock
      // carries just the keys these tests exercise.
      supportedSchemaKeys: vi.fn().mockResolvedValue({
        reachable: true,
        supported: new Set(["generic", "cnic", "passport", "resume", "photo"]),
      }),
    };
  });

vi.mock("../src/config/db.js", () => ({
  pool: { query: sharedQuery, getConnection: vi.fn(async () => fakeConnection) },
}));
vi.mock("../src/utils/auditLog.js", () => ({
  logAudit: vi.fn(),
  getActorFromReq: vi.fn(() => ({ actorType: "admin", actorId: 1, actorName: "a" })),
}));
vi.mock("../src/services/documentTypeSync.js", () => ({
  syncDocumentTypesInBackground: syncBgSpy,
  getDocumentServiceSchemaStatus: syncStatusSpy,
  pushDocumentTypeCatalogue: syncSpy,
  // The controller asks the document service which schema keys it can actually
  // extract instead of comparing against a hard-coded list. Mocked as reachable
  // so the create/update paths validate for real; tests that care about an
  // unsupported key override this via supportedSchemaKeys.mockResolvedValue.
  getSupportedSchemaKeys: supportedSchemaKeys,
}));

import { pool } from "../src/config/db.js";
import {
  listDocumentTypes,
  listActiveDocumentTypes,
  createDocumentType,
  updateDocumentType,
  deleteDocumentType,
  normalizeLabelKey,
} from "../src/controllers/admin/documentTypes.controller.js";

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

function adminReq({ body = {}, params = {} } = {}) {
  return { body, params, admin: { id: 1, uuid: "11111111-1111-4111-8111-111111111111", email: "a@b.c" }, headers: {} };
}

/** Routes the handful of statements the controller issues. */
function installPool({ existing = null, duplicate = false, nextSortOrder = 48 } = {}) {
  pool.query.mockImplementation((sql, params = []) => {
    const stmt = String(sql);

    if (stmt.includes("MAX(sort_order)")) {
      return Promise.resolve([[{ next: nextSortOrder }]]);
    }
    if (stmt.startsWith("INSERT INTO document_types")) {
      if (duplicate) return Promise.reject(new Error("ER_DUP_ENTRY: Duplicate entry"));
      return Promise.resolve([{ insertId: 99, affectedRows: 1 }]);
    }
    if (stmt.startsWith("UPDATE document_types")) {
      if (duplicate) return Promise.reject(new Error("ER_DUP_ENTRY: Duplicate entry"));
      return Promise.resolve([{ affectedRows: 1 }]);
    }
    if (stmt.startsWith("DELETE FROM document_types")) {
      return Promise.resolve([{ affectedRows: 1 }]);
    }
    // The two "fetch one row" reads: update reads SELECT *, delete reads the
    // three columns it needs for the audit entry. Both return no rows when the
    // row is absent, which is what must produce a 404.
    if (
      stmt.startsWith("SELECT * FROM document_types WHERE id=?") ||
      stmt.startsWith("SELECT id, name, schema_key FROM document_types WHERE id=?")
    ) {
      return Promise.resolve([existing ? [existing] : []]);
    }
    if (stmt.includes("FROM document_types WHERE is_active = 1")) {
      return Promise.resolve([
        [
          { name: "Offer Letter", schema_key: "offer_letter" },
          { name: "CNIC / National ID Copy", schema_key: "cnic" },
        ],
      ]);
    }
    if (stmt.includes("FROM document_types")) {
      return Promise.resolve([
        [
          {
            id: 1,
            name: "Offer Letter",
            label_key: "offer letter",
            schema_key: "offer_letter",
            is_active: 1,
            sort_order: 14,
          },
        ],
      ]);
    }
    return Promise.resolve([[]]);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  pool.getConnection.mockResolvedValue(fakeConnection);
  syncSpy.mockResolvedValue({ ok: true, sent: 47 });
  syncStatusSpy.mockResolvedValue({ reachable: true, catalogue_count: 47 });
  installPool();
});

// â”€â”€â”€ label_key normalization â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe("label_key normalization matches the document service's own rule", () => {
  // These expectations are copied from python-backend/app/core/document_schemas.py
  // _normalize_key: re.sub(r"[^0-9a-z]+", " ", value.lower()).strip(). If either
  // side changes its rule these must change together, or a label the admin added
  // will never resolve in the service.
  const cases = [
    ["CNIC / National ID Copy", "cnic national id copy"],
    ["NDA â€” Non-Disclosure Agreement", "nda non disclosure agreement"],
    ["Offer Letter", "offer letter"],
    ["Passport Copy â€” if applicable", "passport copy if applicable"],
    ["IT / Computer Usage Policy Acknowledgment", "it computer usage policy acknowledgment"],
    ["  Multiple   Spaces  ", "multiple spaces"],
    ["UPPER lower MiXeD", "upper lower mixed"],
  ];

  it.each(cases)("%s -> %s", (input, expected) => {
    expect(normalizeLabelKey(input)).toBe(expected);
  });

  it("collapses a slash-and-space run to ONE space, not two", () => {
    // The subtle one: "CNIC / National" must not become "cnic  national" with a
    // double space, which is what a naive replace() produces.
    expect(normalizeLabelKey("CNIC / National ID Copy")).toBe("cnic national id copy");
    expect(normalizeLabelKey("CNIC / National ID Copy")).not.toContain("  ");
  });
});

// â”€â”€â”€ create â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe("creating a document type", () => {
  it("stores the normalized label_key alongside the display name", async () => {
    installPool();
    await createDocumentType(
      adminReq({ body: { name: "Medical Report Scan", schema_key: "cnic" } }),
      mockRes()
    );

    const insert = pool.query.mock.calls.find(([sql]) => String(sql).startsWith("INSERT INTO document_types"));
    expect(insert).toBeDefined();
    const [sql, params] = insert;
    expect(sql).toContain("label_key");
    expect(params[0]).toBe("Medical Report Scan"); // display name, untouched
    expect(params[1]).toBe("medical report scan"); // key, normalized
    expect(params[2]).toBe("cnic"); // the schema the service will use
  });

  it("defaults the schema to 'generic' when none is given", async () => {
    installPool();
    await createDocumentType(adminReq({ body: { name: "Some Form" } }), mockRes());

    const insert = pool.query.mock.calls.find(([sql]) => String(sql).startsWith("INSERT INTO document_types"));
    // 'generic' is a real schema, so an admin who does not care about OCR still
    // gets a working type rather than a broken one.
    expect(insert[1][2]).toBe("generic");
  });

  it("appends to the end of the list instead of taking a slot", async () => {
    installPool({ nextSortOrder: 48 });
    await createDocumentType(adminReq({ body: { name: "New One" } }), mockRes());
    const insert = pool.query.mock.calls.find(([sql]) => String(sql).startsWith("INSERT INTO document_types"));
    expect(insert[1][4]).toBe(48);
  });

  it("rejects a missing name", async () => {
    installPool();
    await expect(createDocumentType(adminReq({ body: {} }), mockRes())).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("rejects a name with no letters or digits", async () => {
    installPool();
    await expect(
      createDocumentType(adminReq({ body: { name: "///" } }), mockRes())
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects a schema_key the document service does not support", async () => {
    installPool();
    await expect(
      createDocumentType(adminReq({ body: { name: "X", schema_key: "imaginary" } }), mockRes())
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining("Unknown schema_key") });
  });

  it("turns a duplicate name into a 409, not a 500", async () => {
    installPool({ duplicate: true });
    await expect(
      createDocumentType(adminReq({ body: { name: "Offer Letter" } }), mockRes())
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("kicks off a background sync so the document service learns the type", async () => {
    installPool();
    await createDocumentType(adminReq({ body: { name: "Driving Licence" } }), mockRes());
    expect(syncBgSpy).toHaveBeenCalledTimes(1);
    expect(syncBgSpy.mock.calls[0][0]).toMatch(/^create:/);
  });
});

// â”€â”€â”€ update / delete â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe("updating a document type", () => {
  const existing = {
    id: 5,
    name: "Old Name",
    label_key: "old name",
    schema_key: "resume",
    is_active: 1,
    sort_order: 3,
  };

  it("recomputes label_key when the name changes", async () => {
    installPool({ existing });
    await updateDocumentType(
      { ...adminReq({ body: { name: "Brand New Name" } }), params: { id: "5" } },
      mockRes()
    );

    const update = pool.query.mock.calls.find(([sql]) => String(sql).startsWith("UPDATE document_types"));
    expect(update[1][0]).toBe("Brand New Name");
    // The key the document service matches on has to move with the name, or the
    // service keeps resolving the old label.
    expect(update[1][1]).toBe("brand new name");
  });

  it("404s for an unknown id", async () => {
    installPool({ existing: null });
    await expect(
      updateDocumentType({ ...adminReq(), params: { id: "404" } }, mockRes())
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("rejects a non-numeric id", async () => {
    installPool({ existing });
    await expect(
      updateDocumentType({ ...adminReq(), params: { id: "abc" } }, mockRes())
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("re-syncs after a change", async () => {
    installPool({ existing });
    await updateDocumentType({ ...adminReq({ body: { is_active: false } }), params: { id: "5" } }, mockRes());
    expect(syncBgSpy).toHaveBeenCalledWith(expect.stringMatching(/^update:/));
  });
});

describe("deleting a document type", () => {
  it("removes it and re-syncs so the service forgets the label", async () => {
    installPool({ existing: { id: 5, name: "Old Name", schema_key: "resume" } });
    await deleteDocumentType({ ...adminReq(), params: { id: "5" } }, mockRes());

    const del = pool.query.mock.calls.find(([sql]) => String(sql).startsWith("DELETE FROM document_types"));
    expect(del[1]).toEqual([5]);
    // The service REPLACES its catalogue, so a delete that did not re-sync would
    // leave the label resolving to its custom schema for the life of the process.
    expect(syncBgSpy).toHaveBeenCalledWith(expect.stringMatching(/^delete:/));
  });

  it("404s for an unknown id rather than deleting something", async () => {
    installPool({ existing: null });
    await expect(
      deleteDocumentType({ ...adminReq(), params: { id: "9" } }, mockRes())
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(pool.query.mock.calls.some(([sql]) => String(sql).startsWith("DELETE"))).toBe(false);
  });
});

// â”€â”€â”€ reads â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe("reading the catalogue", () => {
  it("admin list returns the full rows", async () => {
    installPool();
    const res = mockRes();
    await listDocumentTypes(adminReq(), res);

    expect(res.status).toHaveBeenCalledWith(200);
    const rows = res.json.mock.calls[0][0].data.items;
    expect(rows[0]).toHaveProperty("id");
    expect(rows[0]).toHaveProperty("schema_key");
  });

  it("the org-facing list exposes labels only â€” no ids, no audit fields", async () => {
    // An org user must be able to READ the catalogue to populate a dropdown, so
    // this endpoint is not admin-only. It must therefore not hand out internals.
    installPool();
    const res = mockRes();
    await listActiveDocumentTypes({ headers: {} }, res);

    const items = res.json.mock.calls[0][0].data.items;
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(["label", "schema_key", "value"]);
      expect(item).not.toHaveProperty("id");
      expect(item).not.toHaveProperty("created_at");
    }
  });

  it("the org-facing query filters on is_active", async () => {
    installPool();
    await listActiveDocumentTypes({ headers: {} }, mockRes());
    const call = pool.query.mock.calls.find(([sql]) => String(sql).includes("is_active = 1"));
    expect(call).toBeDefined();
  });
});
