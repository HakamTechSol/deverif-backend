import { describe, it, expect, vi, beforeEach } from "vitest";

// JSON-column normalisation.
//
// MySQL JSON columns arrive from mysql2 as STRINGS. `merge_fields` therefore
// reaches the service as the text '["employee_name","new_salary"]', not as an
// array — and returning it raw shipped a bug where the template page called
// tags.slice(0,4).map(...) and died with "tags.slice(...).map is not a function"
// (slice works on a string; map does not).
//
// The rest of the codebase already normalises these columns before returning
// them — plans.controller.js runs features through normalizePlanFeatures() and
// module_flags through parseModuleFlags(). This file is the equivalent guard for
// HR letters, and it also pins the behaviour to the shape the client is told to
// expect.

vi.mock("../src/config/db.js", () => ({ pool: { query: vi.fn() } }));
vi.mock("../src/utils/auditLog.js", () => ({ logAudit: vi.fn() }));

import { pool } from "../src/config/db.js";
import { parseJsonArray, normalizeTemplate, listTemplates } from "../src/services/hrLetters.service.js";

const TEMPLATE = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  vi.clearAllMocks();
  pool.query.mockReset();
});

describe("parseJsonArray", () => {
  it("parses the string mysql2 actually returns", () => {
    expect(parseJsonArray('["employee_name","new_salary"]')).toEqual(["employee_name", "new_salary"]);
  });

  it("passes a real array straight through", () => {
    expect(parseJsonArray(["a", "b"])).toEqual(["a", "b"]);
  });

  it.each([
    [null, []],
    [undefined, []],
    ["", []],
    ["{}", []],
    ['{"a":1}', []],
    ["not json at all", []],
    [42, []],
  ])("degrades %j to [] instead of throwing", (input, expected) => {
    // A malformed column must not blank the whole page; losing a tag palette is
    // strictly better than losing the list.
    expect(parseJsonArray(input)).toEqual(expected);
  });

  it("never returns something a caller would call .map() on and crash", () => {
    for (const input of [null, "not json", '{"a":1}', 7, true]) {
      expect(Array.isArray(parseJsonArray(input))).toBe(true);
    }
  });
});

describe("normalizeTemplate", () => {
  it("turns merge_fields into a real array", () => {
    const row = normalizeTemplate({ uuid: TEMPLATE, name: "x", merge_fields: '["employee_name"]' });
    expect(row.merge_fields).toEqual(["employee_name"]);
    expect(() => row.merge_fields.map((t) => t)).not.toThrow();
  });

  it("is safe on a row with no tags", () => {
    expect(normalizeTemplate({ uuid: TEMPLATE, name: "x" }).merge_fields).toEqual([]);
  });
});

describe("listTemplates — the endpoint that crashed the page", () => {
  it("returns real arrays, not JSON text", async () => {
    pool.query.mockResolvedValueOnce([
      [{ uuid: TEMPLATE, name: "Increment", merge_fields: '["employee_name","new_salary"]' }],
      [],
    ]);
    const items = await listTemplates({ orgId: 2 });

    expect(Array.isArray(items[0].merge_fields)).toBe(true);
    expect(items[0].merge_fields).toEqual(["employee_name", "new_salary"]);
    // The exact expression the browser threw on.
    expect(() => items[0].merge_fields.slice(0, 4).map((t) => t)).not.toThrow();
  });

  it("keeps every row usable even when one has malformed JSON", async () => {
    pool.query.mockResolvedValueOnce([
      [
        { uuid: TEMPLATE, name: "Good", merge_fields: '["a"]' },
        { uuid: TEMPLATE, name: "Bad", merge_fields: "<<<not json>>>" },
      ],
      [],
    ]);
    const items = await listTemplates({ orgId: 2 });
    expect(items).toHaveLength(2);
    expect(items[1].merge_fields).toEqual([]);
  });
});