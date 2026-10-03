import { describe, it, expect, beforeEach } from "vitest";
import {
  MERGE_TAGS,
  MANUAL_TAGS,
  extractTags,
  unknownTags,
  renderTemplate,
  validateBody,
} from "../src/utils/letterMerge.js";
import {
  signLetterData,
  verifyLetterSignature,
  newLetterQrToken,
  letterQrSigningConfigured,
} from "../src/utils/letterQr.js";

describe("merge tag extraction", () => {
  it("finds tags in first-appearance order, de-duplicated", () => {
    expect(extractTags("$employee_name and $new_salary, then $employee_name again")).toEqual([
      "employee_name",
      "new_salary",
    ]);
  });

  it("returns nothing for a body with no tags", () => {
    expect(extractTags("No tags here.")).toEqual([]);
    expect(extractTags(null)).toEqual([]);
  });

  it("ignores a bare $ not followed by a tag", () => {
    expect(extractTags("costs $50 total")).toEqual([]);
  });

  it("normalises tag case, so a shouted tag is the same tag", () => {
    // extractTags must agree with renderTemplate, which resolves
    // case-insensitively — otherwise a template written $Employee_Name renders
    // fine but is rejected by validateBody as an unknown tag.
    expect(extractTags("$EMPLOYEE_NAME")).toEqual(["employee_name"]);
    expect(unknownTags("$EMPLOYEE_NAME")).toEqual([]);
  });

  it("accepts a single-character tag", () => {
    expect(extractTags("$x $a")).toEqual(["x", "a"]);
  });

  it("does not treat a currency amount as a tag", () => {
    expect(extractTags("costs $50 and $1,200")).toEqual([]);
  });
});

describe("unknown tags", () => {
  it("flags a tag with no known source", () => {
    expect(unknownTags("$employee_name $nope")).toEqual(["nope"]);
  });

  it("accepts every documented tag", () => {
    const body = MERGE_TAGS.map((t) => `$${t.tag}`).join(" ");
    expect(unknownTags(body)).toEqual([]);
  });
});

describe("renderTemplate", () => {
  it("substitutes known values", () => {
    const { text, unresolved } = renderTemplate("Dear $employee_name", { employee_name: "Asim Khan" });
    expect(text).toBe("Dear Asim Khan");
    expect(unresolved).toEqual([]);
  });

  it("leaves an unfilled tag VISIBLE rather than blanking it", () => {
    // A salary letter printing "Dear ," or "increases to $" is a document the
    // employee notices and the employer has to correct. The gap is the bug
    // report; a blank is not.
    const { text, unresolved } = renderTemplate("Dear $employee_name, salary $new_salary", {
      employee_name: "Asim",
    });
    expect(text).toBe("Dear Asim, salary $new_salary");
    expect(unresolved).toEqual(["new_salary"]);
  });

  it("treats empty string, null and undefined as unresolved", () => {
    const { unresolved } = renderTemplate("$a $b $c", { a: "", b: null, c: undefined });
    expect(unresolved).toEqual(["a", "b", "c"]);
  });

  it("lets values override defaults", () => {
    const { text } = renderTemplate("$x", { x: "override" }, { x: "default" });
    expect(text).toBe("override");
  });

  it("formats a *_date tag as a readable date, not an ISO string", () => {
    const { text } = renderTemplate("Effective $effective_date", {
      effective_date: "2026-01-01",
    });
    expect(text).toContain("2026");
    expect(text).not.toContain("2026-01-01");
  });

  it("does NOT date-format a non-date tag even when it looks like one", () => {
    const { text } = renderTemplate("Ref $reference_no", { reference_no: "2026-01-01" });
    expect(text).toBe("Ref 2026-01-01");
  });

  it("does not evaluate the body — a template is never executed", () => {
    // The whole reason this module exists instead of eval/new Function: anyone
    // who can edit a template could otherwise run code on the server.
    const { text } = renderTemplate("${require('child_process')}", {});
    expect(text).toBe("${require('child_process')}");
  });

  it("is not fooled by an HTML/script payload in a value", () => {
    const { text } = renderTemplate("Name: $employee_name", {
      employee_name: "<script>alert(1)</script>",
    });
    // Substitution is literal; escaping for HTML is the renderer's job.
    expect(text).toBe("Name: <script>alert(1)</script>");
  });
});

describe("validateBody", () => {
  it("accepts a valid body and reports its tags", () => {
    const result = validateBody("Dear $employee_name, ref $reference_no");
    expect(result.valid).toBe(true);
    expect(result.tags).toEqual(["employee_name", "reference_no"]);
  });

  it("rejects an empty body", () => {
    expect(validateBody("   ").valid).toBe(false);
    expect(validateBody(null).valid).toBe(false);
  });

  it("rejects a body referencing an unknown tag", () => {
    const result = validateBody("Hello $not_a_field");
    expect(result.valid).toBe(false);
    expect(result.problems.join(" ")).toContain("$not_a_field");
  });

  it("rejects an over-long body", () => {
    expect(validateBody("x".repeat(70000)).valid).toBe(false);
  });
});

describe("MANUAL_TAGS", () => {
  it("are the tags issuance must be given a value for", () => {
    expect(MANUAL_TAGS).toContain("current_salary");
    expect(MANUAL_TAGS).toContain("new_salary");
    expect(MANUAL_TAGS).toContain("effective_date");
  });

  it("exclude the ones the system can fill itself", () => {
    expect(MANUAL_TAGS).not.toContain("employee_name");
    expect(MANUAL_TAGS).not.toContain("reference_no");
  });
});

describe("letter QR signing", () => {
  const base = {
    qrToken: "a".repeat(64),
    letterUuid: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
    orgId: 2,
    issuedAtMillis: Date.UTC(2026, 0, 1, 12, 0, 0, 500),
  };

  beforeEach(() => {
    process.env.QR_SIGNING_SECRET = process.env.QR_SIGNING_SECRET || "test-secret-letter";
  });

  it("is configured when a secret exists", () => {
    expect(letterQrSigningConfigured()).toBe(true);
  });

  it("produces a 64-hex signature", () => {
    expect(signLetterData(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("validates a correct signature", () => {
    const signature = signLetterData(base);
    expect(verifyLetterSignature({ ...base, signature })).toBe(true);
  });

  it("rejects a tampered token", () => {
    const signature = signLetterData(base);
    expect(verifyLetterSignature({ ...base, qrToken: "c".repeat(64), signature })).toBe(false);
  });

  it("rejects a tampered letter uuid", () => {
    const signature = signLetterData(base);
    expect(
      verifyLetterSignature({
        ...base,
        letterUuid: "cccccccc-3333-4333-8333-cccccccccccc",
        signature,
      })
    ).toBe(false);
  });

  it("rejects a tampered organization", () => {
    const signature = signLetterData(base);
    expect(verifyLetterSignature({ ...base, orgId: 99, signature })).toBe(false);
  });

  it("rejects a signature over a different issue time — this is what revocation relies on", () => {
    const signature = signLetterData(base);
    expect(
      verifyLetterSignature({
        ...base,
        issuedAtMillis: Date.UTC(2020, 0, 1),
        signature,
      })
    ).toBe(false);
  });

  it("is INSENSITIVE to sub-second precision, because DATETIME has none", () => {
    // Signing Date.now() with its milliseconds would produce a MAC over bytes
    // the database cannot store, so nothing would ever verify. Both sides floor
    // to whole seconds.
    const signature = signLetterData({ ...base, issuedAtMillis: Date.UTC(2026, 0, 1, 12, 0, 0, 0) });
    expect(
      verifyLetterSignature({ ...base, issuedAtMillis: Date.UTC(2026, 0, 1, 12, 0, 0, 999), signature })
    ).toBe(true);
  });

  it("is DOMAIN SEPARATED from the document-verification QR", async () => {
    // Both schemes use the same secret. If the signed string were identical, a
    // letter's signature could validate against a document certificate.
    const { signQrData } = await import("../src/utils/qrCertificate.js");
    const fields = {
      qrToken: base.qrToken,
      requestUuid: base.letterUuid,
      orgId: base.orgId,
      verifiedAtMillis: base.issuedAtMillis,
    };
    expect(signLetterData(base)).not.toBe(signQrData(fields));
  });

  it("rejects an empty or malformed signature without throwing", () => {
    expect(verifyLetterSignature({ ...base, signature: "" })).toBe(false);
    expect(verifyLetterSignature({ ...base, signature: "zz" })).toBe(false);
    expect(verifyLetterSignature({ ...base, signature: "abc" })).toBe(false);
  });

  it("returns null and fails closed when no secret is configured", () => {
    const saved = process.env.QR_SIGNING_SECRET;
    delete process.env.QR_SIGNING_SECRET;
    try {
      expect(letterQrSigningConfigured()).toBe(false);
      expect(signLetterData(base)).toBeNull();
      expect(verifyLetterSignature({ ...base, signature: "x" })).toBe(false);
    } finally {
      process.env.QR_SIGNING_SECRET = saved;
    }
  });

  it("mints a 64-hex token", () => {
    expect(newLetterQrToken()).toMatch(/^[0-9a-f]{64}$/);
    expect(newLetterQrToken()).not.toBe(newLetterQrToken());
  });
});