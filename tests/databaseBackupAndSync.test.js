import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The database backup endpoint and the document-service catalogue sync.
 *
 * The backup's whole value is that it can be replayed. A dump that cannot be
 * restored is worse than none at all, because it sits in a folder looking like a
 * safety net. So the escaping tests below are not cosmetic: an unescaped
 * apostrophe in one company name produces a file that MySQL refuses to import,
 * and it would only fail at the moment someone actually needed the backup.
 *
 * The sync tests cover the other property that matters: a catalogue edit must
 * SUCCEED even when the document service is unreachable. The type is already
 * committed to the database; the service keeps its own built-in mappings, so a
 * push that cannot land is a nuisance, never a failure.
 */

const { sharedQuery, describeSchemasMock, syncSchemasMock, logAuditMock } = vi.hoisted(() => ({
  sharedQuery: vi.fn(),
  describeSchemasMock: vi.fn(),
  syncSchemasMock: vi.fn(),
  logAuditMock: vi.fn(),
}));

vi.mock("../src/config/db.js", () => ({
  pool: { query: sharedQuery, getConnection: vi.fn() },
}));
vi.mock("../src/utils/auditLog.js", () => ({
  logAudit: logAuditMock,
  getActorFromReq: vi.fn(() => ({ actorType: "admin", actorId: 1, actorName: "admin" })),
}));
vi.mock("../src/services/documentService.js", async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, describeSchemas: describeSchemasMock, syncSchemas: syncSchemasMock };
});

import { pool } from "../src/config/db.js";
import { sqlValue } from "../src/controllers/admin/databaseBackup.controller.js";
import { readActiveCatalogue, pushDocumentTypeCatalogue, getDocumentServiceSchemaStatus } from "../src/services/documentTypeSync.js";

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── catalogue read ─────────────────────────────────────────────────────────

describe("reading the active catalogue for the push", () => {
  it("selects active types in display order", async () => {
    sharedQuery.mockResolvedValue([[]]);
    await readActiveCatalogue();

    const [sql] = sharedQuery.mock.calls[0];
    expect(sql).toContain("is_active = 1");
    expect(sql).toContain("ORDER BY sort_order ASC, id ASC");
  });

  it("maps rows to the {label, schema_key} shape the service expects", async () => {
    sharedQuery.mockResolvedValue([
      [
        { name: "Offer Letter", label_key: "offer letter", schema_key: "offer_letter" },
        { name: "CNIC / National ID Copy", label_key: "cnic national id copy", schema_key: "cnic" },
      ],
    ]);

    const entries = await readActiveCatalogue();
    expect(entries).toEqual([
      { label: "Offer Letter", label_key: "offer letter", schema_key: "offer_letter" },
      { label: "CNIC / National ID Copy", label_key: "cnic national id copy", schema_key: "cnic" },
    ]);
  });
});

// ─── sync failure policy ────────────────────────────────────────────────────

describe("a catalogue sync failure never breaks the caller", () => {
  it("reports ok:false instead of throwing when the service is unreachable", async () => {
    sharedQuery.mockResolvedValue([[{ name: "Offer Letter", schema_key: "offer_letter" }]]);
    const { DocumentServiceError } = await import("../src/services/documentService.js");
    syncSchemasMock.mockRejectedValue(
      new DocumentServiceError(502, "connection refused", { kind: "connection" })
    );

    const report = await pushDocumentTypeCatalogue({ reason: "test" });
    expect(report.ok).toBe(false);
    expect(report.kind).toBe("connection");
    expect(report.sent).toBe(0);
  });

  it("reports ok:false when the catalogue itself cannot be read", async () => {
    sharedQuery.mockRejectedValue(new Error("ER_NO_SUCH_TABLE"));
    const report = await pushDocumentTypeCatalogue({ reason: "test" });
    expect(report.ok).toBe(false);
    expect(report.reason).toBe("catalogue_read_failed");
  });

  it("surfaces entries the service rejected instead of hiding them", async () => {
    // A rejected entry means that type will extract with the generic schema —
    // safe, but not what the admin asked for, so it has to be visible.
    sharedQuery.mockResolvedValue([[{ name: "Odd Form", schema_key: "resume" }]]);
    syncSchemasMock.mockResolvedValue({
      data: {
        stored: 0,
        rejected_count: 1,
        rejected: [{ label: "Odd Form", schema_key: "resume", reason: "unknown schema_key" }],
      },
    });

    const report = await pushDocumentTypeCatalogue({ reason: "test" });
    expect(report.ok).toBe(true);
    expect(report.rejected).toHaveLength(1);
    expect(report.rejected[0].label).toBe("Odd Form");
  });

  it("sends only label and schema_key, not internal columns", async () => {
    sharedQuery.mockResolvedValue([
      [{ name: "Offer Letter", label_key: "offer letter", schema_key: "offer_letter", id: 7, is_active: 1 }],
    ]);
    syncSchemasMock.mockResolvedValue({ data: { stored: 1, rejected: [] } });

    await pushDocumentTypeCatalogue({ reason: "test" });
    const [types] = syncSchemasMock.mock.calls[0];
    expect(types).toEqual([{ label: "Offer Letter", schema_key: "offer_letter" }]);
  });

  it("reports a successful push with the count sent", async () => {
    sharedQuery.mockResolvedValue([
      [
        { name: "A", schema_key: "generic" },
        { name: "B", schema_key: "cnic" },
      ],
    ]);
    syncSchemasMock.mockResolvedValue({ data: { stored: 2, rejected: [] } });

    const report = await pushDocumentTypeCatalogue({ reason: "test" });
    expect(report).toMatchObject({ ok: true, sent: 2, stored: 2 });
  });
});

// ─── sync status probe ──────────────────────────────────────────────────────

describe("the sync-status probe the admin panel shows", () => {
  it("reports reachable with the catalogue size when the service answers", async () => {
    describeSchemasMock.mockResolvedValue({
      data: { catalogue_count: 47, auto_match_ineligible: ["photo"] },
    });
    const status = await getDocumentServiceSchemaStatus();
    expect(status.reachable).toBe(true);
    expect(status.catalogue_count).toBe(47);
  });

  it("reports unreachable rather than throwing when the service is down", async () => {
    describeSchemasMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const status = await getDocumentServiceSchemaStatus();
    expect(status.reachable).toBe(false);
    expect(status.error).toContain("ECONNREFUSED");
  });
});

// ─── backup escaping ────────────────────────────────────────────────────────

/**
 * True when the literal body contains a quote that is NOT escaped — i.e. a
 * quote preceded by an even number of backslashes (0, 2, 4, ...).
 *
 * A correct unescape-and-compare round trip is NOT used instead, because the
 * obvious implementation of one is subtly wrong: unescaping `\'` inside
 * `back\\slash\'quote` corrupts the `\\` pair. The escaping itself is correct
 * (a backslash before a quote must be doubled AND the quote escaped); it is the
 * naive inverse that is unsafe. The end-to-end proof that these literals really
 * do replay is scripts/_verify_backup_restorable.mjs, which restores a real
 * dump into a scratch database with the mysql client.
 */
function hasUnescapedQuote(body) {
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch !== "'" && ch !== '"') continue;
    let backslashes = 0;
    for (let j = i - 1; j >= 0 && body[j] === "\\"; j -= 1) backslashes += 1;
    if (backslashes % 2 === 0) return true;
  }
  return false;
}

describe("the backup emits SQL that can actually be replayed", () => {
  // Tested against the REAL exported helper, not a copy of the rules: a test that
  // re-implements the escaping only proves the copy agrees with itself. An
  // unescaped apostrophe in one company name produces a dump MySQL refuses to
  // import, and that failure would only surface at the moment somebody actually
  // needed the backup.
  it("escapes an apostrophe", () => {
    expect(sqlValue("O'Brien")).toBe("'O\\'Brien'");
  });

  it("escapes a backslash", () => {
    expect(sqlValue("a\\b")).toBe("'a\\\\b'");
  });

  it("escapes a newline, a tab and a carriage return", () => {
    expect(sqlValue("l1\nl2")).toBe("'l1\\nl2'");
    expect(sqlValue("a\tb")).toBe("'a\\tb'");
    expect(sqlValue("a\rb")).toBe("'a\\rb'");
  });

  it("escapes a real NUL byte rather than emitting it raw", () => {
    // A literal NUL inside a quoted string is what truncates a dump for most
    // tools, so it must never survive unescaped.
    expect(sqlValue("a\u0000b")).toBe("'a\\0b'");
    expect(sqlValue("a\u0000b")).not.toContain("\u0000");
  });

  it("escapes other control characters as hex", () => {
    expect(sqlValue("a\u0001b")).toBe("'a\\x01b'");
    expect(sqlValue("a\u007fb")).toBe("'a\\x7fb'");
  });

  it("escapes a double quote", () => {
    // Built from char codes: writing this as a literal would need four levels of
    // backslash escaping and the test would be unreadable (and, as it turns out,
    // easy to get wrong).
    const q = String.fromCharCode(34); // "
    const bs = String.fromCharCode(92); // \
    expect(sqlValue(`say ${q}hi${q}`)).toBe(`'say ${bs}${q}hi${bs}${q}'`);
  });

  it("leaves ordinary and non-Latin text untouched", () => {
    // Urdu and emoji are exactly what gets mangled by a dump that escapes
    // greedily, so they must pass through verbatim.
    expect(sqlValue("محمد علی")).toBe("'محمد علی'");
    expect(sqlValue("Ali \u{1F600}")).toBe("'Ali \u{1F600}'");
    expect(sqlValue("HakamTechSol")).toBe("'HakamTechSol'");
  });

  it("renders NULL for null and undefined", () => {
    expect(sqlValue(null)).toBe("NULL");
    expect(sqlValue(undefined)).toBe("NULL");
  });

  it("renders numbers bare and booleans as 1/0", () => {
    expect(sqlValue(42)).toBe("42");
    expect(sqlValue(0)).toBe("0");
    expect(sqlValue(-3.5)).toBe("-3.5");
    expect(sqlValue(NaN)).toBe("NULL");
    expect(sqlValue(true)).toBe("1");
    expect(sqlValue(false)).toBe("0");
  });

  it("emits a Buffer as a hex literal so a BLOB round-trips", () => {
    expect(sqlValue(Buffer.from([0x00, 0x01, 0xff]))).toBe("X'0001ff'");
  });

  it("re-stringifies a JSON column rather than emitting [object Object]", () => {
    // mysql2 parses JSON columns; Object.values() would otherwise hand the
    // escaper a plain object and the dump would lose the document.
    const value = sqlValue({ name: "Asim Khan", cnic: "4210112345671" });
    expect(value).toContain("Asim Khan");
    expect(value).not.toContain("[object Object]");
  });

  it("produces a balanced-quote literal for the nastiest realistic value", () => {
    // Company names and remarks are where real quotes live. Every escaped form
    // must still be a single well-formed literal.
    for (const input of [
      "O'Brien & Sons",
      "Al-Hassan \"Ltd\"",
      "back\\slash'quote",
      "multi\nline'remark",
    ]) {
      const out = sqlValue(input);
      expect(out.startsWith("'")).toBe(true);
      expect(out.endsWith("'")).toBe(true);
      // No unescaped quote of either kind may survive inside the literal, or the
      // statement terminates early and the rest of the row is read as SQL.
      expect(hasUnescapedQuote(out.slice(1, -1))).toBe(false);
    }
  });
});
