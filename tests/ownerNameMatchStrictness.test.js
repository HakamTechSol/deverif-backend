import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Part 4: the typed `document_owner_name` is display data, never a match key.
 *
 * It is a human-typed claim on a form, so it carries typos ("Mohammad Ali" for
 * "Muhammad Ali"), transliteration drift, and nickname variants. If it took
 * part in the auto-match decision, every one of those would push an otherwise
 * perfect submission into manual review — for a field the reviewer has no
 * stronger reason to believe than the requester.
 *
 * The decision therefore rests solely on OCR-vs-OCR canonical-field comparison
 * (rapidfuzz, >= 88% after normalization). These tests pin that in both
 * directions: a typo cannot cause a manual-review fallback, and a genuine
 * mismatch between the DOCUMENTS still does.
 */

const { sharedQuery, fakeConnection } = vi.hoisted(() => {
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
  };
});

vi.mock("../src/config/db.js", () => ({
  pool: { query: sharedQuery, getConnection: vi.fn(async () => fakeConnection) },
}));
vi.mock("../src/services/documentService.js", async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, validate: vi.fn(), match: vi.fn(), ocrExtract: vi.fn() };
});
vi.mock("../src/utils/qrCertificate.js", () => ({
  generateQrForRequest: vi.fn().mockResolvedValue(undefined),
  // Identity pass-through: see tests/verifyUrl.test.js for the real behaviour.
  withVerifyUrl: (row) => row,
  withVerifyUrls: (rows) => rows,
}));
vi.mock("../src/utils/auditLog.js", () => ({
  logAudit: vi.fn(),
  getActorFromReq: vi.fn(() => ({})),
}));
vi.mock("../src/utils/mailer.js", () => ({ sendVerificationResultEmailToOrg: vi.fn() }));

import { pool } from "../src/config/db.js";
import { validate, match as matchDocuments } from "../src/services/documentService.js";
import { createRequest } from "../src/controllers/verification.controller.js";
import { runAutoMatchChecks } from "../src/utils/autoMatch.js";
import { nameSimilarityRatio, normalizeNameForMatch, buildDocumentCrossCheck } from "../src/utils/documentConsistency.js";
import { hashCnic } from "../src/utils/personCrypto.js";
import { DOCS_DIR } from "../src/config/uploadPaths.js";

process.env.PERSON_DATA_ENCRYPTION_KEY = "test-only-person-data-key";

const ORG_UUID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ORG_ID = 10;
const OWNER_CNIC = "42101-1234567-1";
const NORMALIZED_CNIC = "4210112345671";
const SUBMITTED_FILE = `ownername_${process.pid}.pdf`;
const SUBMITTED_BYTES = Buffer.from("%PDF-1.7\nName: Muhammad Ali\nCNIC: 42101-1234567-1\n");
const SUBMITTED_HASH = crypto.createHash("sha256").update(SUBMITTED_BYTES).digest("hex");

const TEMP_FILES = [];

beforeAll(() => {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  fs.writeFileSync(path.join(DOCS_DIR, SUBMITTED_FILE), SUBMITTED_BYTES);
  TEMP_FILES.push(path.join(DOCS_DIR, SUBMITTED_FILE));
});

afterAll(() => {
  for (const f of TEMP_FILES) {
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch {
      /* best-effort */
    }
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  pool.getConnection.mockResolvedValue(fakeConnection);
  validate.mockResolvedValue({ success: true, data: { valid: true } });
  matchDocuments.mockResolvedValue({
    success: true,
    data: { match: true, confidence: 100, reasons: ["name matches (100%)"] },
  });
});

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

function makeReq(body, user = {}) {
  return {
    body,
    user: { id: 1, org_role: "org_admin", ...user },
    file: { filename: SUBMITTED_FILE, mimetype: "application/pdf", originalname: SUBMITTED_FILE },
  };
}

/**
 * A createRequest pool where the target org DOES know this person and has a
 * reference document for them — i.e. the auto-match path is live.
 *
 * The reference row doubles as both shapes the reference is read in: the staging
 * lookup's row (employee_uuid / doc_id) and the match engine's row (id /
 * file_path / extracted_data). It carries a cached canonical field map, which is
 * what a reference uploaded after Part 2 has on it.
 */
function installCreatePoolWithReference(typedName) {
  const REFERENCE_ROW = {
    id: 777,
    doc_id: 777,
    employee_uuid: "emp-uuid",
    // A PDF reference and this PDF submission: byte-identical would be fine,
    // but the point of the test is the canonical-field path, so differ.
    document_hash: "f".repeat(64),
    file_path: "documents/does-not-need-to-exist.pdf",
    document_type: "CNIC / National ID Copy",
    extracted_data: JSON.stringify({
      document_type: "cnic",
      document_type_label: "CNIC / National ID Copy",
      fields: {
        name: { value: "Muhammad Ali", confidence: "high" },
        cnic: { value: NORMALIZED_CNIC, confidence: "high" },
        dob: { value: "1990-08-05", confidence: "high" },
      },
    }),
    extraction_status: "succeeded",
  };

  pool.query.mockImplementation((sql) => {
    const stmt = String(sql);
    if (stmt.includes("SELECT id FROM organizations")) return Promise.resolve([[{ id: ORG_ID }]]);
    if (stmt.includes("document_hash=?")) return Promise.resolve([[]]);
    if (stmt.includes("INSERT INTO verification_requests")) return Promise.resolve([{ insertId: 1 }]);
    // The staging lookup joins the other way round from the match engine's read,
    // so match on the table name rather than one particular join clause.
    if (stmt.includes("employee_documents ed")) return Promise.resolve([[REFERENCE_ROW]]);
    if (stmt.includes("FROM employees emp")) return Promise.resolve([[{ uuid: "emp-uuid" }]]);
    if (stmt.includes("issuing_org_name")) {
      return Promise.resolve([[{
        id: 1,
        uuid: "req-uuid",
        issuing_organization_id: ORG_ID,
        document_type: "CNIC / National ID Copy",
        document_path: `/uploads/documents/${SUBMITTED_FILE}`,
        document_hash: SUBMITTED_HASH,
        document_owner_name: typedName,
        linked_person_id: 42,
        status: "under_review",
        match_status: "not_attempted",
        matched_employee_document_id: 777,
      }]]);
    }
    if (/^(INSERT|UPDATE|DELETE)\b/.test(stmt)) return Promise.resolve([{ affectedRows: 1 }]);
    return Promise.resolve([[]]);
  });
}

describe("Part 4.1 — the typed owner name never gates the match decision", () => {
  it("a typo in document_owner_name does not cause a manual-review fallback", async () => {
    // The scenario from the audit: the form says "Mohammad Ali", the document
    // says "Muhammad Ali". The typed field is not part of the decision, so the
    // canonical-field match runs exactly as it would for a correct spelling.
    const TYPED = "Mohammad Ali";
    installCreatePoolWithReference(TYPED);

    const res = mockRes();
    await createRequest(
      makeReq({
        document_type: "CNIC / National ID Copy",
        issuing_organization_uuid: ORG_UUID,
        document_owner_name: TYPED,
        document_owner_cnic: OWNER_CNIC,
      }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(201);

    // The reference was staged (the lookup is by CNIC, never by name) and the
    // inline match was run.
    const stagingWrite = pool.query.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("SET match_status=?, matched_employee_document_id=?")
    );
    expect(stagingWrite[1][0]).toBe("not_attempted");
    expect(stagingWrite[1][1]).toBe(777);

    // The comparison was made on canonical fields and returned a perfect score.
    expect(matchDocuments).toHaveBeenCalledTimes(1);
    const [, , options] = matchDocuments.mock.calls[0];
    expect(options.documentTypeA).toBe("CNIC / National ID Copy");

    // The result was an automatic approval, not manual review.
    const approve = pool.query.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("match_status='auto_matched'")
    );
    expect(approve).toBeDefined();
    for (const [sql] of pool.query.mock.calls) {
      if (typeof sql !== "string") continue;
      expect(sql).not.toContain("match_status='manual_review'");
    }

    const payload = res.json.mock.calls[0][0];
    expect(payload.data.request.auto_verified).toBe(true);
    // The typed value is still stored and returned: it is display data.
    expect(payload.data.request.document_owner_name).toBe(TYPED);
  });

  it("the staging lookup never filters on the typed name", async () => {
    installCreatePoolWithReference("Mohammad Ali");

    await createRequest(
      makeReq({
        document_type: "CNIC / National ID Copy",
        issuing_organization_uuid: ORG_UUID,
        document_owner_name: "Mohammad Ali",
        document_owner_cnic: OWNER_CNIC,
      }),
      mockRes()
    );

    for (const [sql] of pool.query.mock.calls) {
      if (typeof sql !== "string") continue;
      // The only identity the staging path is allowed to look up is the CNIC.
      expect(sql).not.toMatch(/full_name\s*=/);
      expect(sql).not.toMatch(/document_owner_name\s*=/);
    }

    // The CNIC is what resolved the reference.
    const staging = pool.query.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("employee_documents ed")
    );
    expect(staging[1]).toEqual([ORG_ID, NORMALIZED_CNIC]);
  });

  it("a genuinely different document still falls through to manual review", async () => {
    // The tolerance must not become a blanket pass: when the DOCUMENTS disagree,
    // the comparison decides, and the typed name is irrelevant either way.
    matchDocuments.mockResolvedValue({
      success: true,
      data: { match: false, confidence: 0, reasons: ["cnic differs (0%)"] },
    });

    const request = {
      id: 810,
      uuid: "req-real-mismatch",
      status: "under_review",
      match_status: "not_attempted",
      matched_employee_document_id: 777,
      issuing_organization_id: ORG_ID,
      // Even a PERFECTLY spelled typed name does not rescue a document mismatch.
      document_owner_name: "Muhammad Ali",
      document_type: "CNIC / National ID Copy",
      document_path: `/uploads/documents/${SUBMITTED_FILE}`,
      document_hash: SUBMITTED_HASH,
      user_id: 1,
      requester_uuid: "requester-uuid",
      requester_organization: null,
    };

    pool.query.mockImplementation((sql) => {
      const stmt = String(sql);
      if (stmt.includes("FROM verification_requests vr")) return Promise.resolve([[request]]);
      if (stmt.includes("employee_documents ed")) {
        return Promise.resolve([[
          {
            id: 777,
            document_hash: "a".repeat(64),
            file_path: "documents/never-read.pdf",
            document_type: "CNIC / National ID Copy",
            extracted_data: JSON.stringify({
              document_type: "cnic",
              document_type_label: "CNIC / National ID Copy",
              fields: {
                name: { value: "Someone Else", confidence: "high" },
                cnic: { value: "3520276543211", confidence: "high" },
              },
            }),
            extraction_status: "succeeded",
          },
        ]]);
      }
      return Promise.resolve([{ affectedRows: 1 }]);
    });

    await runAutoMatchChecks({ orgId: ORG_ID });

    const update = pool.query.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("match_status='manual_review'")
    );
    expect(update).toBeDefined();
    expect(update[1]).toEqual([0, 810]);
  });
});

describe("Part 4.2 — normalization is applied to both sides before comparing", () => {
  it("folds case, padding whitespace and punctuation on a name", () => {
    expect(normalizeNameForMatch("  muhammad   ali  ")).toBe("MUHAMMAD ALI");
    expect(normalizeNameForMatch("Muhammad-Ali")).toBe("MUHAMMAD ALI");
    expect(normalizeNameForMatch("Muhammad, Ali")).toBe("MUHAMMAD ALI");
    expect(normalizeNameForMatch("Muhammad. Ali;")).toBe("MUHAMMAD ALI");
  });

  it("scores cosmetically different renderings of one name as a match", () => {
    const canonical = "Muhammad Ali";
    for (const variant of [
      "muhammad ali",
      "MUHAMMAD   ALI",
      "Muhammad-Ali",
      "Muhammad, Ali",
      "  Muhammad   Ali.  ",
    ]) {
      expect(nameSimilarityRatio(canonical, variant)).toBe(100);
    }
  });

  it("keeps the >=88% threshold semantics for a minor spelling variant", () => {
    // The fuzzy tolerance the design calls for: a one-character transcription
    // slip is still the same person and still clears the threshold.
    const ratio = nameSimilarityRatio("Muhammad Ali", "Mohammad Ali");
    expect(ratio).toBeGreaterThanOrEqual(88);
  });

  it("still scores a different person well below the threshold", () => {
    const ratio = nameSimilarityRatio("Muhammad Ali", "Bilal Ahmed");
    expect(ratio).toBeLessThan(60);
  });

  it("is symmetric", () => {
    const a = "muhammad, ali";
    const b = "MUHAMMAD ALI";
    expect(nameSimilarityRatio(a, b)).toBe(nameSimilarityRatio(b, a));
  });

  it("treats a missing name on either side as no evidence, never as agreement", () => {
    // An empty name must not silently score 100 in one direction: the caller
    // decides what to do with a null, and it must never look like a pass.
    expect(nameSimilarityRatio("", "Muhammad Ali")).toBe(0);
    expect(nameSimilarityRatio("Muhammad Ali", "")).toBe(0);
  });
});

describe("Part 4 — the form-vs-document cross-check is informational only", () => {
  /** The document service's OCR output for the submitted PDF. */
  function stubOcr() {
    return import("../src/services/documentService.js").then(({ ocrExtract }) => {
      ocrExtract.mockResolvedValue({
        success: true,
        data: {
          document_type: "cnic",
          fields: {
            name: { value: "Muhammad Ali", confidence: "high" },
            cnic: { value: NORMALIZED_CNIC, confidence: "high" },
          },
        },
      });
    });
  }

  beforeEach(() => {
    pool.query.mockImplementation((sql) => {
      const stmt = String(sql);
      if (stmt.includes("cnic_hash FROM persons")) {
        return Promise.resolve([[{ cnic_hash: hashCnic(NORMALIZED_CNIC) }]]);
      }
      return Promise.resolve([[]]);
    });
  });

  it("tolerates a typed-name typo: it is reported as agreeing, and blocks nothing", async () => {
    await stubOcr();

    const result = await buildDocumentCrossCheck({
      uuid: "req-1",
      linked_person_id: 42,
      document_path: `/uploads/documents/${SUBMITTED_FILE}`,
      document_type: "CNIC / National ID Copy",
      document_owner_name: "Mohammad Ali", // the typo
    });

    // Fuzzy comparison, not string equality: the one-character slip is inside
    // the 88% tolerance, so the cross-check sees agreement.
    expect(result.matchStatus).toBe("matched");
    expect(result.reason).toMatch(/Name matches/);
    expect(result.extractedName).toBe("Muhammad Ali");
  });

  it("reports a wholly different typed name as a data-quality note, without throwing", async () => {
    await stubOcr();

    const result = await buildDocumentCrossCheck({
      uuid: "req-3",
      linked_person_id: 42,
      document_path: `/uploads/documents/${SUBMITTED_FILE}`,
      document_type: "CNIC / National ID Copy",
      document_owner_name: "Bilal Ahmed", // an entirely different person
    });

    // Reported honestly...
    expect(result.matchStatus).toBe("mismatched");
    expect(result.reason).toMatch(/Name differs/);
    // ...and only ever as a note: the function returns a verdict object and
    // never throws, so approval is unaffected. Nothing here can change a
    // request's status, which is what makes the typed field safe to ignore.
    expect(result.extractedName).toBe("Muhammad Ali");
  });

  it("normalizes the typed name the same way the document side is normalized", async () => {
    await stubOcr();

    const result = await buildDocumentCrossCheck({
      uuid: "req-2",
      linked_person_id: 42,
      document_path: `/uploads/documents/${SUBMITTED_FILE}`,
      document_type: "CNIC / National ID Copy",
      document_owner_name: "  muhammad,  ali ", // same name, messy form input
    });

    expect(result.matchStatus).toBe("matched");
    expect(result.reason).toMatch(/Name matches/);
  });
});
