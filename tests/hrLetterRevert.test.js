import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Revoking a letter was a ONE-WAY DOOR.
 *
 * A letter revoked over a typo could be neither edited into a correct draft nor
 * issued, so HR's only recourse was to create a fresh letter - losing the
 * reference number and the audit trail. revertLetterToDraft is the way back.
 *
 * The properties that matter, and why:
 *
 *  1. IT CLEARS THE ATTESTATION. qr_token/qr_signature and issued_at are exactly
 *     what revokeLetter clears; if this left them, a reverted letter would keep
 *     a public link that still verified.
 *
 *  2. IT DOES NOT RE-ISSUE. status becomes draft and nothing more. If this set
 *     issued_at, one click would put a letter back into circulation without
 *     anyone re-reading it - the exact thing revoking exists to prevent.
 *
 *  3. IT IS STATUS-GUARDED. Only a revoked letter moves, so a double submit
 *     cannot silently discard an issued letter's attestation.
 */
vi.mock("../src/config/db.js", () => ({ pool: { query: vi.fn(), getConnection: vi.fn() } }));
vi.mock("../src/utils/auditLog.js", () => ({ logAudit: vi.fn() }));

const { pool } = await import("../src/config/db.js");
const { revertLetterToDraft, revokeLetter } = await import("../src/services/hrLetters.service.js");

const ORG = 2;
const OTHER_ORG = 99;
const LETTER = "44444444-4444-4444-8444-444444444444";
const ADMIN = "admin-uuid";

const letterRow = (over = {}) => ({
  uuid: LETTER,
  organization_id: ORG,
  employee_uuid: "emp-1",
  template_uuid: null,
  letter_type: "increment",
  reference_no: "HR/2026/0001",
  title: "Annual Salary Increment Letter",
  status: "draft",
  payload: null,
  issued_at: null,
  revoked_at: null,
  revoked_reason: null,
  qr_token: null,
  qr_signature: null,
  ...over,
});

beforeEach(() => {
  pool.query.mockReset();
});

const sqlOf = (call = 0) => String(pool.query.mock.calls[call][0]);

describe("revertLetterToDraft", () => {
  it("returns the letter to draft", async () => {
    pool.query
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[letterRow()], []]);

    const result = await revertLetterToDraft({ orgId: ORG, letterUuid: LETTER, actorUuid: ADMIN });

    expect(sqlOf()).toContain("status='draft'");
    expect(result.status).toBe("draft");
  });

  it("clears the attestation, exactly as revoking does", async () => {
    pool.query
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[letterRow()], []]);

    await revertLetterToDraft({ orgId: ORG, letterUuid: LETTER, actorUuid: ADMIN });

    const sql = sqlOf();
    expect(sql).toContain("qr_token=NULL");
    expect(sql).toContain("qr_signature=NULL");
    expect(sql).toContain("issued_at=NULL");
    expect(sql).toContain("revoked_at=NULL");
    expect(sql).toContain("revoked_reason=NULL");
  });

  it("drops the frozen body so a corrected template takes effect", async () => {
    pool.query
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[letterRow()], []]);

    await revertLetterToDraft({ orgId: ORG, letterUuid: LETTER, actorUuid: ADMIN });

    // Keeping it would make the re-issued letter identical to the revoked one,
    // which defeats the purpose of reverting.
    expect(sqlOf()).toContain("body_snapshot=NULL");
  });

  it("does NOT re-issue: it never sets issued_at or a token", async () => {
    pool.query
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[letterRow()], []]);

    await revertLetterToDraft({ orgId: ORG, letterUuid: LETTER, actorUuid: ADMIN });

    const sql = sqlOf();
    expect(sql).not.toMatch(/issued_at\s*=\s*(NOW\(\)|CURRENT_TIMESTAMP)/i);
    expect(sql).not.toMatch(/status\s*=\s*'issued'/i);
  });

  it("is scoped to the organization", async () => {
    pool.query
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[letterRow()], []]);

    await revertLetterToDraft({ orgId: ORG, letterUuid: LETTER, actorUuid: ADMIN });

    expect(sqlOf()).toContain("organization_id=?");
    expect(pool.query.mock.calls[0][1]).toContainEqual(ORG);
  });

  it("only moves a revoked letter, so a double submit cannot discard an issued one", async () => {
    pool.query.mockResolvedValueOnce([{ affectedRows: 0 }]);

    await expect(
      revertLetterToDraft({ orgId: ORG, letterUuid: LETTER, actorUuid: ADMIN }),
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(sqlOf()).toContain("status='revoked'");
  });

  it("rejects a malformed uuid before touching the database", async () => {
    await expect(revertLetterToDraft({ orgId: ORG, letterUuid: "nope", actorUuid: ADMIN })).rejects.toThrow();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("cannot be used to reach into another organization", async () => {
    pool.query.mockResolvedValueOnce([{ affectedRows: 0 }]);
    await expect(
      revertLetterToDraft({ orgId: OTHER_ORG, letterUuid: LETTER, actorUuid: ADMIN }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(pool.query.mock.calls[0][1]).toContainEqual(OTHER_ORG);
  });
});

describe("revocation and reverting are inverses", () => {
  it("both clear issued_at and the QR token", async () => {
    pool.query
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[letterRow({ status: "draft" })], []]);
    await revertLetterToDraft({ orgId: ORG, letterUuid: LETTER, actorUuid: ADMIN });
    const revertSql = sqlOf();

    pool.query
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[letterRow({ status: "revoked" })], []]);
    await revokeLetter({ orgId: ORG, letterUuid: LETTER, actorUuid: ADMIN, reason: "Error" });
    const revokeSql = sqlOf();

    for (const fragment of ["issued_at=NULL", "qr_token=NULL", "qr_signature=NULL"]) {
      expect(revertSql).toContain(fragment);
      expect(revokeSql).toContain(fragment);
    }
  });
});