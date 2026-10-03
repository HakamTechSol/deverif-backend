import { describe, it, expect } from "vitest";
import {
  cnicSchema,
  phoneSchema,
  emailSchema,
  moneySchema,
  quantitySchema,
  latitudeSchema,
  longitudeSchema,
  haversineMeters,
  parseOrThrow,
  nameSchema,
  codeSchema,
  notesSchema,
} from "../src/utils/validators.js";

const ok = (schema, value) => expect(schema.safeParse(value).success).toBe(true);
const bad = (schema, value) => expect(schema.safeParse(value).success).toBe(false);

describe("cnicSchema", () => {
  it("accepts 13 digits and strips formatting", () => {
    const result = cnicSchema.safeParse("42101-1234567-1");
    expect(result.success).toBe(true);
    expect(result.data).toBe("4210112345671");
    expect(cnicSchema.parse(" 4210112345671 ")).toBe("4210112345671");
  });

  it.each(["421011234567", "42101123456712", "421011234567a", "", "42101 1234567 1 2"])(
    "rejects %j",
    (value) => {
      bad(cnicSchema, value);
    }
  );

  it("explains the rule in the message", () => {
    expect(cnicSchema.safeParse("123").error.issues[0].message).toMatch(/13 digits/);
  });
});

describe("phoneSchema / emailSchema", () => {
  it.each(["+92 300 1234567", "0300-1234567", "03001234567"])("accepts phone %j", (v) => {
    ok(phoneSchema, v);
  });
  it.each(["abc", "12", "+92-".repeat(20)])("rejects phone %j", (v) => {
    bad(phoneSchema, v);
  });

  it("lowercases an email", () => {
    expect(emailSchema.parse("Ali@Example.COM")).toBe("ali@example.com");
  });
  it.each(["not-an-email", "a@b", "a b@c.com"])("rejects email %j", (v) => {
    bad(emailSchema, v);
  });
});

describe("moneySchema", () => {
  it("accepts numbers and numeric strings, rounding to 2dp", () => {
    expect(moneySchema.parse(500)).toBe(500);
    expect(moneySchema.parse("500.555")).toBe(500.56);
    expect(moneySchema.parse("15625.00")).toBe(15625);
  });

  it("treats blank as zero", () => {
    expect(moneySchema.parse("")).toBe(0);
    expect(moneySchema.parse(null)).toBe(0);
  });

  it("rejects negatives and non-numbers", () => {
    bad(moneySchema, -1);
    bad(moneySchema, "abc");
    bad(moneySchema, Infinity);
  });
});

describe("quantitySchema", () => {
  it("allows three decimals, unlike money", () => {
    // Piece work counts 12.5 metres, not 12.50 rupees.
    expect(quantitySchema.parse("12.5")).toBe(12.5);
    expect(quantitySchema.parse("0.125")).toBe(0.125);
  });

  it("rejects negatives", () => {
    bad(quantitySchema, "-1");
  });
});

describe("geo schemas", () => {
  it("accepts the full latitude and longitude ranges", () => {
    ok(latitudeSchema, 31.5204);
    ok(latitudeSchema, -90);
    ok(latitudeSchema, 90);
    ok(longitudeSchema, 74.3587);
    ok(longitudeSchema, -180);
    ok(longitudeSchema, 180);
  });

  it("rejects out-of-range coordinates", () => {
    bad(latitudeSchema, 91);
    bad(latitudeSchema, -91);
    bad(longitudeSchema, 181);
    bad(longitudeSchema, -181);
  });

  it("coerces numeric strings", () => {
    expect(latitudeSchema.parse("31.5204")).toBe(31.5204);
  });

  it("rejects non-numeric input", () => {
    bad(latitudeSchema, "not-a-latitude");
  });
});

describe("haversineMeters", () => {
  it("is 0 for the same point", () => {
    expect(haversineMeters(31.5204, 74.3587, 31.5204, 74.3587)).toBe(0);
  });

  it("matches a known Lahore distance within tolerance", () => {
    // Lahore (31.5204,74.3587) to Islamabad (33.6844,73.0479) is ~270 km.
    const metres = haversineMeters(31.5204, 74.3587, 33.6844, 73.0479);
    expect(metres).toBeGreaterThan(265_000);
    expect(metres).toBeLessThan(275_000);
  });

  it("is symmetric", () => {
    const a = haversineMeters(31.5204, 74.3587, 33.6844, 73.0479);
    const b = haversineMeters(33.6844, 73.0479, 31.5204, 74.3587);
    expect(a).toBe(b);
  });

  it("supports a 100 m office geofence test", () => {
    // ~50 m north of the first point is inside a 100 m radius; ~500 m is not.
    expect(haversineMeters(31.5204, 74.3587, 31.52085, 74.3587)).toBeLessThan(100);
    expect(haversineMeters(31.5204, 74.3587, 31.525, 74.3587)).toBeGreaterThan(100);
  });
});

describe("parseOrThrow", () => {
  it("returns parsed data on success", () => {
    expect(parseOrThrow(cnicSchema, "4210112345671")).toBe("4210112345671");
  });

  it("throws the project's ApiError shape, not a raw ZodError", () => {
    try {
      parseOrThrow(cnicSchema, "123", "employee_cnic");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err.statusCode).toBe(400);
      expect(err.message).toMatch(/13 digits/);
    }
  });
});

describe("name / code / notes", () => {
  it("nameSchema requires a non-empty trimmed value", () => {
    expect(nameSchema.parse("  Ali  ")).toBe("Ali");
    bad(nameSchema, "   ");
    bad(nameSchema, "");
  });

  it("codeSchema restricts to safe characters", () => {
    expect(codeSchema.parse("JOB-01")).toBe("JOB-01");
    bad(codeSchema, "job 01");
    bad(codeSchema, "job/01");
    bad(codeSchema, "job;01");
  });

  it("notesSchema normalises blank to null", () => {
    expect(notesSchema.parse("")).toBeNull();
    expect(notesSchema.parse("  hi ")).toBe("hi");
    expect(notesSchema.parse(undefined)).toBeUndefined();
  });
});