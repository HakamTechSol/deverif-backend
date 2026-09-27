import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  normalizePhone,
  assertIdentityAvailable,
  rethrowIdentityDuplicate,
} from "../src/utils/identityUniqueness.js";

// A phone number identifies a person, so one number must mean one account.
//
// The database enforces it (uq_users_phone_normalized, maintained by a trigger).
// These tests cover the two things the schema cannot do on its own:
//
//   1. Canonicalisation. "0318...", "+92 318...", "0092318..." and "318..." are one
//      number. A UNIQUE index on the raw column would let all four through, and
//      would also reject two different people whose formatting differed. So the JS
//      normaliser has to agree exactly with the SQL function, or the pre-check
//      will disagree with the index.
//
//   2. Saying something useful. A raw driver error names an internal index and a
//      mangled number, and does not tell the person doing data entry whose number
//      it is.

describe("normalizePhone", () => {
  it("collapses every way of writing one number to the same value", () => {
    const canonical = "3182484396";
    for (const input of [
      "03182484396",
      "3182484396",
      "+92 318 2484396",
      "+923182484396",
      "00923182484396",
      "0318-2484396",
      "  0318 2484396  ",
      "(0318) 2484396",
    ]) {
      expect(normalizePhone(input), `input: ${JSON.stringify(input)}`).toBe(canonical);
    }
  });

  it("treats absent or blank numbers as no number", () => {
    for (const input of [null, undefined, "", "   ", "-", "()", "abc"]) {
      expect(normalizePhone(input)).toBeNull();
    }
  });

  it("leaves an unexpected length alone rather than guessing", () => {
    // A wrong guess would merge two genuinely different people, which is the
    // exact failure this exists to prevent.
    expect(normalizePhone("12345")).toBe("12345");
    expect(normalizePhone("0092318248436")).toBe("0092318248436");
    // "92" only reads as a country code at 12 digits; shorter must be left alone.
    expect(normalizePhone("9231824")).toBe("9231824");
  });

  it("only strips a leading trunk zero at the 11-digit length", () => {
    // 11 digits starting 0 is the local form of a 10-digit national number.
    expect(normalizePhone("03182484396")).toBe("3182484396");
    // 10 digits is NOT that shape, so the zero stays. Stripping it here would be a
    // guess, and a wrong guess merges two different people.
    expect(normalizePhone("0318248439")).toBe("0318248439");
    expect(normalizePhone("031824843")).toBe("031824843");
  });
});

const makeExecutor = (rows = []) => ({ query: vi.fn().mockResolvedValue([rows]) });

describe("assertIdentityAvailable", () => {
  let executor;
  beforeEach(() => {
    executor = makeExecutor([]);
  });

  it("passes when neither phone nor cnic is taken", async () => {
    await expect(
      assertIdentityAvailable({ phone: "03182484396", cnic: "42501-1", executor })
    ).resolves.toBeUndefined();
  });

  it("rejects a phone already held by someone else, naming them", async () => {
    executor = makeExecutor([{ id: 7, email: "someone@x.com", full_name: "Ayesha Khan" }]);
    await expect(
      assertIdentityAvailable({ phone: "03182484396", executor })
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("Ayesha Khan"),
    });
  });

  it("checks the NORMALISED number, not the raw string", async () => {
    // The lookup must go to phone_normalized, otherwise a differently-formatted
    // duplicate slips through the pre-check and only the index catches it.
    await assertIdentityAvailable({ phone: "+92 318 2484396", executor });
    const [sql, params] = executor.query.mock.calls[0];
    expect(sql).toContain("phone_normalized");
    expect(params[0]).toBe("3182484396");
  });

  it("excludes soft-deleted rows from the phone lookup", async () => {
    // A departed employee's number must be reusable by their replacement, which
    // is why the trigger nulls phone_normalized on delete.
    await assertIdentityAvailable({ phone: "03182484396", executor });
    expect(executor.query.mock.calls[0][0]).toContain("deleted_at IS NULL");
  });

  it("excludes the user being edited, so re-saving is not a self-clash", async () => {
    await assertIdentityAvailable({ phone: "03182484396", excludeUserId: 7, executor });
    const [sql, params] = executor.query.mock.calls[0];
    expect(sql).toContain("id <> ?");
    expect(params).toContain(7);
  });

  it("rejects a cnic already held, and says it cannot be reused", async () => {
    executor = makeExecutor([{ id: 9, email: "b@c.com", full_name: "Bilal" }]);
    await expect(
      assertIdentityAvailable({ cnic: "42501-1", executor })
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("cannot be reused"),
    });
  });

  it("skips the database entirely when nothing was supplied", async () => {
    await assertIdentityAvailable({ phone: null, cnic: "", executor });
    expect(executor.query).not.toHaveBeenCalled();
  });
});

describe("rethrowIdentityDuplicate", () => {
  it("turns a phone index violation into a readable 409", () => {
    const err = new Error("Duplicate entry '3182484396' for key 'uq_users_phone_normalized'");
    try {
      rethrowIdentityDuplicate(err);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e.statusCode).toBe(409);
      expect(e.message).toMatch(/phone number/i);
      // The internal index name must not leak to the caller.
      expect(e.message).not.toContain("uq_users_phone_normalized");
    }
  });

  it("turns a cnic violation into a readable 409", () => {
    const err = new Error("Duplicate entry '42501-2783487-9' for key 'cnic'");
    try {
      rethrowIdentityDuplicate(err);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e.statusCode).toBe(409);
      expect(e.message).toMatch(/CNIC/i);
    }
  });

  it("never leaks a raw index name for any other unique key", () => {
    const err = new Error("Duplicate entry 'a@b.com' for key 'email'");
    try {
      rethrowIdentityDuplicate(err);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e.statusCode).toBe(409);
      expect(e.message).not.toMatch(/key '|Duplicate entry/);
    }
  });

  it("rethrows anything that is not a duplicate untouched", () => {
    const err = new Error("ER_NO_REFERENCED_ROW_2");
    expect(() => rethrowIdentityDuplicate(err)).toThrow(err);
  });
});
