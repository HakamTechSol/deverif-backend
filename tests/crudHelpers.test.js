import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildUpdate,
  buildUpdateStrict,
  buildInsert,
  buildOrgScope,
  boolField,
  trimOrUndefined,
} from "../src/utils/crudHelpers.js";

/**
 * The property that matters here is that a request body can never widen the set
 * of writable columns. Everything else is convenience.
 */
describe("buildUpdate — allow-list, never the body", () => {
  const ALLOWED = ["title", "amount", "notes"];

  it("builds assignments for whitelisted columns present in the body", () => {
    const { clause, params, columns } = buildUpdate({ title: "Taxi", amount: 500 }, ALLOWED);
    expect(clause).toBe("SET `title`=?, `amount`=?");
    expect(params).toEqual(["Taxi", 500]);
    expect(columns).toEqual(["title", "amount"]);
  });

  it("IGNORES a column that is not on the allow-list", () => {
    // The mass-assignment guard: organization_id is the dangerous one, since
    // writing it would move the row into another tenant.
    const { clause, params } = buildUpdate(
      { title: "Taxi", organization_id: 99, id: 5, uuid: "x", created_by_uuid: "y" },
      ALLOWED
    );
    expect(clause).toBe("SET `title`=?");
    expect(params).toEqual(["Taxi"]);
    expect(params).not.toContain(99);
  });

  it("refuses to build if the allow-list itself names a protected column", () => {
    // Defence in depth: even a careless allow-list cannot expose these.
    expect(() => buildUpdate({ organization_id: 1 }, ["organization_id"])).toThrow();
    expect(() => buildUpdate({ id: 1 }, ["id"])).toThrow();
    expect(() => buildUpdate({ created_at: "now" }, ["created_at"])).toThrow();
  });

  it("distinguishes an absent field (skip) from an explicit null (write NULL)", () => {
    const absent = buildUpdate({ title: "A" }, ALLOWED);
    expect(absent.params).toEqual(["A"]);

    const explicitNull = buildUpdate({ title: "A", notes: null }, ALLOWED);
    expect(explicitNull.params).toEqual(["A", null]);
  });

  it("returns an empty clause when nothing is writable", () => {
    const { clause, params } = buildUpdate({ organization_id: 99 }, ALLOWED);
    expect(clause).toBe("");
    expect(params).toEqual([]);
  });

  it("supports an ignore list", () => {
    const { clause } = buildUpdate({ title: "A", notes: "B" }, ALLOWED, { ignore: ["notes"] });
    expect(clause).toBe("SET `title`=?");
  });

  it("rejects an unsafe identifier", () => {
    expect(() => buildUpdate({ "title` = 1, `x": "v" }, ["title` = 1, `x"])).toThrow();
    expect(() => buildUpdate({ x: 1 }, ["x; DROP TABLE users"])).toThrow();
  });
});

describe("buildUpdateStrict", () => {
  it("throws on an unknown field, for endpoints where a typo should be loud", () => {
    expect(() => buildUpdateStrict({ titel: "typo" }, ["title", "amount"])).toThrow(/Unknown field/);
  });

  it("allows the documented fields", () => {
    expect(() => buildUpdateStrict({ title: "ok" }, ["title"])).not.toThrow();
  });
});

describe("buildInsert", () => {
  it("emits an explicit column list in the allow-list order", () => {
    const { columns, placeholders, params } = buildInsert(
      { name: "Basic", monthly_price: 10, is_public: 1 },
      ["name", "monthly_price", "is_public"]
    );
    expect(columns).toEqual(["`name`", "`monthly_price`", "`is_public`"]);
    expect(placeholders).toEqual(["?", "?", "?"]);
    expect(params).toEqual(["Basic", 10, 1]);
  });

  it("skips absent keys so the list stays aligned with the params", () => {
    const { columns, params } = buildInsert({ name: "Basic" }, ["name", "monthly_price"]);
    expect(columns).toEqual(["`name`"]);
    expect(params).toEqual(["Basic"]);
  });

  it("throws when nothing is writable", () => {
    expect(() => buildInsert({}, ["name"])).toThrow(/No writable fields/);
  });

  it("refuses a protected column", () => {
    expect(() => buildInsert({ organization_id: 2 }, ["organization_id"])).toThrow();
  });
});

describe("buildOrgScope — the tenant filter is never optional", () => {
  it("always includes organization_id", () => {
    const { clause, params } = buildOrgScope(7);
    expect(clause).toBe("organization_id = ?");
    expect(params).toEqual([7]);
  });

  it("appends extra equality filters", () => {
    const { clause, params } = buildOrgScope(7, { uuid: "abc", status: "open" });
    expect(clause).toBe("organization_id = ? AND `uuid` = ? AND `status` = ?");
    expect(params).toEqual([7, "abc", "open"]);
  });

  it("skips undefined extras rather than binding NULL", () => {
    const { params } = buildOrgScope(7, { uuid: "abc", status: undefined });
    expect(params).toEqual([7, "abc"]);
  });

  it("refuses to build without an organization", () => {
    expect(() => buildOrgScope(undefined)).toThrow();
    expect(() => buildOrgScope(null)).toThrow();
  });
});

describe("small field helpers", () => {
  it.each([
    [true, true],
    [false, false],
    ["true", true],
    ["1", true],
    ["yes", true],
    ["on", true],
    ["false", false],
    ["0", false],
    ["no", false],
    ["", false],
    [null, false],
    [undefined, false],
  ])("boolField(%s) -> %s", (input, expected) => {
    expect(boolField(input)).toBe(expected);
  });

  it("boolField honours its fallback", () => {
    expect(boolField(undefined, true)).toBe(true);
    expect(boolField("", true)).toBe(true);
  });

  it("trimOrUndefined treats blank as absent", () => {
    expect(trimOrUndefined("  Taxi  ")).toBe("Taxi");
    expect(trimOrUndefined("")).toBeUndefined();
    expect(trimOrUndefined("   ")).toBeUndefined();
    expect(trimOrUndefined(42)).toBeUndefined();
  });
});