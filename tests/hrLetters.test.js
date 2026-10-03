import { describe, it, expect, vi, beforeEach } from "vitest";

// HR Letters service.
//
// Two properties carry most of the risk and are asserted first:
//
//   1. TENANT ISOLATION — attachments-style, every read is scoped by
//      organization_id, so a guessed letter or template uuid 404s rather than
//      leaking another org's documents.
//   2. THE ISSUE SNAPSHOT — an issued letter's merged text is frozen, so editing
//      the template cannot retroactively change a letter an employee already
//      holds. A salary letter whose numbers no longer match its snapshot is
//      worse than no letter at all.
//
// Revocation is asserted as an INVALIDATION, not a status flip: clearing
// issued_at breaks the signature, which is what makes the printed QR stop
// working.

vi.mock("../src/config/db.js", () => ({ pool: { query: vi.fn(), getConnection: vi.fn() } }));
vi.mock("../src/utils/auditLog.js", () => ({ logAudit: vi.fn() }));

import { pool } from "../src/config/db.js";
import { logAudit } from "../src/utils/auditLog.js";
import {
  getTemplate,
  createTemplate,
  deleteTemplate,
  createDraftLetter,
  issueLetter,
  revokeLetter,
  deleteLetter,
  listLetters,
  verifyLetterPublic,
  previewTemplate,
  renderLetterPdf,
  LETTER_TYPES,
} from "../src/services/hrLetters.service.js";

const ORG = 2;
const OTHER_ORG = 99;
const ADMIN = "11111111-1111-4111-8111-111111111111";
const EMPLOYEE = "22222222-2222-4222-8222-222222222222";
const TEMPLATE = "33333333-3333-4333-8333-333333333333";
const LETTER = "44444444-4444-4444-8444-444444444444";
const TOKEN = "a".repeat(64);
const SIG = "b".repeat(64);

const BODY = "Dear $employee_name, your salary is now $new_salary effective $effective_date.";

/** Longest-pattern-wins router, same harness style as the approval tests. */
function fakeConn(routes) {
  const conn = {
    query: vi.fn(async (sql) => {
      const text = String(sql);
      let best;
      let len = -1;
      for (const [pattern, value] of routes) {
        if (text.includes(pattern) && pattern.length > len) {
          best = value;
          len = pattern.length;
        }
      }
      return [typeof best === "function" ? best() : (best ?? []), []];
    }),
    beginTransaction: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
    rollback: vi.fn(async () => {}),
    release: vi.fn(),
  };
  pool.getConnection.mockResolvedValue(conn);
  return conn;
}

const templateRow = (over = {}) => ({
  uuid: TEMPLATE,
  organization_id: ORG,
  letter_type: "increment",
  name: "Increment",
  body: BODY,
  merge_fields: ["employee_name", "new_salary", "effective_date"],
  is_active: 1,
  ...over,
});

const letterRow = (over = {}) => ({
  uuid: LETTER,
  organization_id: ORG,
  employee_uuid: EMPLOYEE,
  template_uuid: TEMPLATE,
  letter_type: "increment",
  reference_no: "HR/2026/0001",
  title: "Increment",
  payload: { new_salary: "56,500", effective_date: "2026-01-01" },
  body_snapshot: null,
  qr_token: null,
  qr_signature: null,
  status: "draft",
  issued_at: null,
  employee_name: "Asim Khan",
  designation: "Engineer",
  department: "IT",
  joining_date: "2024-01-01",
  organization_name: "Acme",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  pool.query.mockReset();
  pool.getConnection.mockReset();
  logAudit.mockReset();
  process.env.QR_SIGNING_SECRET = process.env.QR_SIGNING_SECRET || "test-secret-letters";
  // buildLetterVerifyUrl() resolves this eagerly and throws when it is missing,
  // so the issued-letter paths need it present even under test.
  process.env.QR_VERIFY_BASE_URL = process.env.QR_VERIFY_BASE_URL || "https://www.dverif.com";
  // Default for the post-commit re-read. issueLetter() commits on the
  // transaction and then calls getLetter(), which goes through pool.query —
  // leaving this unmocked fails on an undefined result, not on the behaviour
  // under test.
  pool.query.mockResolvedValue([[letterRow({ status: "issued", body_snapshot: "Dear Asim" })], []]);
});

describe("templates — tenant isolation", () => {
  it("404s for a template in another organization", async () => {
    pool.query.mockResolvedValueOnce([[]]);
    await expect(getTemplate({ orgId: OTHER_ORG, templateUuid: TEMPLATE })).rejects.toMatchObject({
      statusCode: 404,
    });
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain("organization_id=?");
    expect(params).toEqual([TEMPLATE, OTHER_ORG]);
  });

  it("rejects a duplicate name with 409", async () => {
    pool.query.mockRejectedValueOnce(Object.assign(new Error("dup"), { errno: 1062 }));
    await expect(
      createTemplate({ orgId: ORG, actorUuid: ADMIN, letterType: "increment", name: "Increment", body: BODY })
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("rejects an unknown letter_type", async () => {
    await expect(
      createTemplate({ orgId: ORG, actorUuid: ADMIN, letterType: "payroll", name: "x", body: BODY })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("refuses to save a body containing an unknown merge tag", async () => {
    // Caught at save time so a broken template is never carried forward into a
    // letter given to an employee.
    await expect(
      createTemplate({ orgId: ORG, actorUuid: ADMIN, letterType: "custom", name: "x", body: "Hi $nope" })
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("does not touch issued letters when a template is deleted", async () => {
    // hr_letters.template_uuid is ON DELETE SET NULL; each issued letter keeps
    // its own body_snapshot and stays verifiable.
    pool.query.mockResolvedValueOnce([{ affectedRows: 1 }]);
    await deleteTemplate({ orgId: ORG, templateUuid: TEMPLATE, actorUuid: ADMIN });
    expect(String(pool.query.mock.calls[0][0])).toContain("DELETE FROM letter_templates");
    expect(String(pool.query.mock.calls[0][0])).toContain("organization_id=?");
  });
});

describe("LETTER_TYPES", () => {
  it("covers the seven letter kinds", () => {
    expect(LETTER_TYPES).toHaveLength(7);
    expect(LETTER_TYPES).toContain("increment");
    expect(LETTER_TYPES).toContain("experience");
  });
});

describe("createDraftLetter", () => {
  it("allocates a reference number and starts as a draft with no verify_url", async () => {
    pool.query.mockImplementation(async (sql) => {
      const t = String(sql);
      if (t.includes("FROM employees")) {
        return [[{ employee_name: "Asim", joining_date: "2024-01-01", designation: "Eng", department: "IT", organization_name: "Acme" }], []];
      }
      if (t.includes("FROM hr_letters WHERE")) return [[{ uuid: LETTER }], []];
      if (t.includes("FROM organizations")) return [[{ name: "Acme" }], []];
      if (t.includes("FROM hr_letters l")) return [[letterRow()], []];
      return [[], []];
    });
    pool.query.mockResolvedValueOnce([[{ reference_no: "HR/2025/0007" }], []]);

    const draft = await createDraftLetter({
      orgId: ORG,
      actorUuid: ADMIN,
      employeeUuid: EMPLOYEE,
      templateUuid: TEMPLATE,
      letterType: "increment",
    });
    expect(draft.status).toBe("draft");
    expect(draft.verify_url).toBeNull();
  });

  it("404s for an employee outside the organization", async () => {
    pool.query.mockResolvedValueOnce([[]]);
    await expect(
      createDraftLetter({ orgId: ORG, actorUuid: ADMIN, employeeUuid: EMPLOYEE, letterType: "custom", title: "x" })
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("issueLetter — the snapshot invariant", () => {
  const issueRoutes = (over = {}) => [
    ["FROM hr_letters l", [letterRow(over)]],
    // Route VALUES are the rows array itself, so this is [{...}] and NOT
    // [[{...}]] — wrapping twice makes templateBody an array, which reads as
    // "no body to render".
    ["FROM letter_templates", [{ body: BODY }]],
    ["FROM organizations", [{ name: "Acme" }]],
  ];

  it("merges, freezes and mints a token", async () => {
    const conn = fakeConn(issueRoutes());
    const result = await issueLetter({
      orgId: ORG,
      letterUuid: LETTER,
      actorUuid: ADMIN,
      values: { new_salary: "56,500", effective_date: "2026-01-01" },
    });

    const sqls = conn.query.mock.calls.map(([s]) => String(s));
    const update = sqls.find((s) => s.includes("UPDATE hr_letters"));
    expect(update).toContain("body_snapshot=?");
    expect(update).toContain("status='issued'");
    expect(conn.commit).toHaveBeenCalled();
    expect(result.status).toBe("issued");
  });

  it("REFUSES to issue while a merge tag is unfilled", async () => {
    // "Dear , your salary is now $" is not an acceptable letter to hand to an
    // employee who will present it to a bank.
    fakeConn(issueRoutes({ payload: {} }));
    await expect(issueLetter({ orgId: ORG, letterUuid: LETTER, actorUuid: ADMIN })).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("Cannot issue"),
    });
  });

  it("locks the row so two concurrent issues cannot both mint a token", async () => {
    const conn = fakeConn(issueRoutes());
    await issueLetter({ orgId: ORG, letterUuid: LETTER, actorUuid: ADMIN });
    expect(conn.query.mock.calls.map(([s]) => String(s)).some((s) => s.includes("FOR UPDATE"))).toBe(true);
  });

  it("409s when the letter is already issued", async () => {
    fakeConn(issueRoutes({ status: "issued" }));
    await expect(issueLetter({ orgId: ORG, letterUuid: LETTER, actorUuid: ADMIN })).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("503s when QR signing is not configured, rather than issuing an unverifiable letter", async () => {
    const saved = process.env.QR_SIGNING_SECRET;
    delete process.env.QR_SIGNING_SECRET;
    try {
      await expect(issueLetter({ orgId: ORG, letterUuid: LETTER, actorUuid: ADMIN })).rejects.toMatchObject({
        statusCode: 503,
      });
    } finally {
      process.env.QR_SIGNING_SECRET = saved;
    }
  });

  it("rolls back on failure", async () => {
    const conn = fakeConn(issueRoutes());
    conn.commit.mockRejectedValue(new Error("db down"));
    await expect(issueLetter({ orgId: ORG, letterUuid: LETTER, actorUuid: ADMIN })).rejects.toThrow("db down");
    expect(conn.rollback).toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalled();
  });
});

describe("revokeLetter — invalidation, not just a status flip", () => {
  it("clears issued_at and the token, which is what breaks the signature", async () => {
    pool.query.mockResolvedValueOnce([{ affectedRows: 1 }]).mockResolvedValueOnce([[letterRow({ status: "revoked" })], []]);
    const result = await revokeLetter({ orgId: ORG, letterUuid: LETTER, actorUuid: ADMIN, reason: "Error" });

    const sql = String(pool.query.mock.calls[0][0]);
    expect(sql).toContain("issued_at=NULL");
    expect(sql).toContain("qr_token=NULL");
    expect(sql).toContain("status='revoked'");
    expect(result.status).toBe("revoked");
  });

  it("409s when there is no issued letter to revoke", async () => {
    pool.query.mockResolvedValueOnce([{ affectedRows: 0 }]);
    await expect(revokeLetter({ orgId: ORG, letterUuid: LETTER, actorUuid: ADMIN })).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("refuses to delete an issued letter — revoke it instead", async () => {
    pool.query.mockResolvedValueOnce([[letterRow({ status: "issued" })], []]);
    await expect(deleteLetter({ orgId: ORG, letterUuid: LETTER, actorUuid: ADMIN })).rejects.toMatchObject({
      statusCode: 409,
    });
  });
});

describe("verifyLetterPublic — fails closed", () => {
  const issuedRow = (over = {}) => ({
    uuid: LETTER,
    letter_type: "increment",
    reference_no: "HR/2026/0001",
    title: "Increment",
    status: "issued",
    issued_at: new Date("2026-01-01T00:00:00Z"),
    qr_signature: SIG,
    organization_id: ORG,
    employee_name: "Asim Khan",
    designation: "Engineer",
    organization_name: "Acme",
    ...over,
  });

  it.each([
    ["short", "deadbeef"],
    ["non-hex", "z".repeat(64)],
    ["empty", ""],
    ["undefined", undefined],
  ])("rejects a %s token without querying", async (_label, token) => {
    expect(await verifyLetterPublic({ qrToken: token })).toBeNull();
  });

  it("rejects an unknown token", async () => {
    pool.query.mockResolvedValueOnce([[]]);
    expect(await verifyLetterPublic({ qrToken: TOKEN })).toBeNull();
  });

  it("rejects a revoked letter", async () => {
    pool.query.mockResolvedValueOnce([[issuedRow({ status: "revoked" })], []]);
    expect(await verifyLetterPublic({ qrToken: TOKEN })).toBeNull();
  });

  it("rejects a forged signature", async () => {
    pool.query.mockResolvedValueOnce([[issuedRow({ qr_signature: "c".repeat(64) })], []]);
    expect(await verifyLetterPublic({ qrToken: TOKEN })).toBeNull();
  });

  it("never returns salary figures or a CNIC", async () => {
    // payload can hold salary data; a photographed letter must not become a way
    // to read someone's pay.
    pool.query.mockResolvedValueOnce([[issuedRow()], []]);
    const result = await verifyLetterPublic({ qrToken: TOKEN });
    if (result) {
      const json = JSON.stringify(result).toLowerCase();
      expect(json).not.toContain("salary");
      expect(json).not.toContain("cnic");
      expect(json).not.toContain("payload");
    }
  });
});

describe("listLetters", () => {
  it("scopes the count and the page to the organization", async () => {
    pool.query.mockResolvedValueOnce([[{ total: 0 }], []]).mockResolvedValueOnce([[], []]);
    await listLetters({ orgId: ORG, page: 1, limit: 20, offset: 0 });
    for (const call of pool.query.mock.calls) {
      expect(String(call[0])).toContain("l.organization_id = ?");
      expect(call[1][0]).toBe(ORG);
    }
  });

  it("does not advertise a verify_url for a draft", async () => {
    pool.query.mockResolvedValueOnce([[{ total: 1 }], []]).mockResolvedValueOnce([
      [{ uuid: LETTER, status: "draft", qr_token: TOKEN }],
      [],
    ]);
    const page = await listLetters({ orgId: ORG, page: 1, limit: 20, offset: 0 });
    expect(page.items[0].verify_url).toBeNull();
  });
});

describe("previewTemplate", () => {
  it("reports which manual tags are still missing", async () => {
    pool.query.mockImplementation(async (sql) => {
      const t = String(sql);
      if (t.includes("FROM letter_templates")) return [[templateRow()], []];
      if (t.includes("FROM employees"))
        return [[{ employee_name: "Asim", designation: "Eng", department: "IT", joining_date: null, organization_name: "Acme" }], []];
      return [[], []];
    });
    const preview = await previewTemplate({ orgId: ORG, employeeUuid: EMPLOYEE, templateUuid: TEMPLATE });
    expect(preview.missing_manual).toEqual(["new_salary", "effective_date"]);
    expect(preview.unresolved).toEqual(["new_salary", "effective_date"]);
  });
});

describe("renderLetterPdf", () => {
  it("produces a real PDF buffer", async () => {
    pool.query.mockResolvedValueOnce([[letterRow({ body_snapshot: "Dear Asim", status: "issued", qr_token: TOKEN })], []]);
    const { buffer, filename } = await renderLetterPdf({ orgId: ORG, letterUuid: LETTER });
    expect(Buffer.isBuffer(buffer)).toBe(true);
    // PDFs start %PDF-, not PK (that is ZIP/XLSX).
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(filename).toMatch(/\.pdf$/);
    expect(filename).not.toContain("/");
  });

  it("404s for another organization's letter", async () => {
    pool.query.mockResolvedValueOnce([[]]);
    await expect(renderLetterPdf({ orgId: OTHER_ORG, letterUuid: LETTER })).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});