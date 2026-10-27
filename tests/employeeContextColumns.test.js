import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Every column defaultsFromLetter reads must be SELECTED by every query that
 * feeds it.
 *
 * The bug this exists for: $cnic was added to the employee-context query used by
 * the PREVIEW, so the preview rendered a correct CNIC and the unit tests on
 * letterMerge passed. But /issue goes through a different query,
 * loadLetterForOrg, which was never given the column. Issuing therefore still
 * failed with "these merge tags have no value - $cnic" - a user-facing failure
 * that looked exactly like the fix had not landed.
 *
 * Two independent queries assembling the same context is the root cause, and
 * checking them separately is what let it through: each query looks fine on its
 * own. This asserts they select the SAME columns, so they cannot drift again.
 */
const SRC = readFileSync("src/services/hrLetters.service.js", "utf8");

/** Columns defaultsFromLetter reads off its `letter` argument. */
function defaultsKeys() {
  const body = SRC.match(/function defaultsFromLetter[\s\S]*?\n}/)?.[0] ?? "";
  const block = body.slice(body.indexOf("{"));
  const keys = [...block.matchAll(/^\s{4}([a-z_]+):/gm)].map((m) => m[1]);
  return new Set(keys);
}

/** The alias each shared column is selected AS, i.e. what code reads it by. */
function sharedColumns() {
  const block = SRC.match(/const EMPLOYEE_CONTEXT_COLUMNS = `([\s\S]*?)`;/)?.[1] ?? "";
  const aliased = [...block.matchAll(/e\.[a-z_]+\s+AS\s+([a-z_]+)/g)].map((m) => m[1]);
  // Bare columns (no alias) are read under their own name.
  const bare = [...block.matchAll(/(?:^|,)\s*e\.([a-z_]+)\s*(?:,|$)/gm)].map((m) => m[1]);
  return new Set([...aliased, ...bare]);
}

describe("employee context is selected consistently", () => {
  it("the shared column constant exists", () => {
    expect(SRC).toContain("const EMPLOYEE_CONTEXT_COLUMNS");
  });

  it("every SELECTED context column is actually used by defaultsFromLetter", () => {
    const defaults = defaultsKeys();
    const selected = sharedColumns();

    expect(defaults.size).toBeGreaterThan(5);

    // A column selected but never read is dead weight; more importantly it hints
    // the two lists have drifted.
    const unused = [...selected].filter((c) => !defaults.has(c));
    expect(unused, `selected but never read: ${unused.join(", ")}`).toEqual([]);
  });

  it("each context column resolves to a real value, not a hardcoded blank", () => {
    const defaults = defaultsKeys();
    const selected = sharedColumns();

    // The precise defect: defaultsFromLetter had `cnic: ""` even though cnic was
    // readable. Assert every selected column is read from `letter`, by checking
    // the assignment is a real expression rather than a literal.
    const body = SRC.match(/function defaultsFromLetter[\s\S]*?\n}/)?.[0] ?? "";
    const hardcoded = [...body.matchAll(/^\s{4}([a-z_]+):\s*""\s*,?$/gm)].map((m) => m[1]);

    const selectableButBlank = hardcoded.filter((k) => selected.has(k));
    expect(
      selectableButBlank,
      `these columns are SELECTED but hardcoded empty in defaultsFromLetter: ` +
        selectableButBlank.join(", "),
    ).toEqual([]);

    // Manual tags are the only ones that SHOULD be born empty.
    expect(defaults.size).toBeGreaterThan(0);
  });

  it("cnic is among the selected columns", () => {
    // Named explicitly because it is the one that actually shipped broken.
    expect(sharedColumns()).toContain("cnic");
  });

  it("both queries build their context from the shared constant", () => {
    // Match across the WHOLE source, not inside backticks: the interpolation
    // `${EMPLOYEE_CONTEXT_COLUMNS}` sits in the template literal but a
    // backtick-only regex misses how the query is actually assembled.
    expect(SRC).toContain("SELECT${EMPLOYEE_CONTEXT_COLUMNS}");
    expect(SRC).toContain("SELECT l.*,${EMPLOYEE_CONTEXT_COLUMNS}");

    // Neither query may hand-roll the context columns.
    const previewQuery = SRC.match(/const EMPLOYEE_CONTEXT_SELECT = `([\s\S]*?)`;/)?.[1] ?? "";
    expect(previewQuery).not.toMatch(/\be\.full_name\b/);
    expect(previewQuery).not.toMatch(/\be\.joining_date\b/);
    expect(previewQuery).not.toMatch(/\be\.cnic\b/);

    const letterFn = SRC.match(/async function loadLetterForOrg[\s\S]*?\n\}/)?.[0] ?? "";
    expect(letterFn).not.toMatch(/\be\.full_name\b/);
    expect(letterFn).not.toMatch(/\be\.joining_date\b/);
    expect(letterFn).not.toMatch(/\be\.cnic\b/);
  });

  it("hardcoded blanks are limited to the manual tags", () => {
    const body = SRC.match(/function defaultsFromLetter[\s\S]*?\n}/)?.[0] ?? "";
    const hardcoded = [...body.matchAll(/^\s{4}([a-z_]+):\s*""\s*,?$/gm)].map((m) => m[1]);
    const MANUAL = [
      "current_salary",
      "new_salary",
      "effective_date",
      "increment_percentage",
      "total_experience",
      "last_working_date",
      "warning_reason",
    ];

    expect(hardcoded.filter((k) => !MANUAL.includes(k))).toEqual([]);
  });
});