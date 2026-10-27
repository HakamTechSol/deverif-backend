import { describe, it, expect } from "vitest";
import {
  collectableTags,
  tagLabel,
  allTagLabels,
  renderTemplate,
  unknownTags,
  MERGE_TAGS,
} from "../src/utils/letterMerge.js";

/**
 * $cnic and the "empty auto tag" fallback.
 *
 * $cnic was declared as employee.cnic in MERGE_TAGS from the start, but the
 * service hardcoded `cnic: ""` into its defaults and never selected the column,
 * so the tag could never resolve. Every Offer Letter printed the literal "$cnic"
 * and issuance refused with "these merge tags have no value - $cnic".
 *
 * The worse half is the fallback. `missing_manual` used to be
 * `unresolved ∩ MANUAL_TAGS`, which quietly assumed only always-manual tags can
 * be unresolved. A missing CNIC or an unrecorded joining date broke that
 * assumption: the tag was unresolved, so the issue form kept submit disabled,
 * yet it was absent from missing_manual, so NO INPUT WAS RENDERED. The letter was
 * impossible to issue and the screen gave no reason.
 */
describe("collectableTags", () => {
  it("treats an empty AUTO tag as collectable, not just manual ones", () => {
    // The bug in one line: cnic is an employee.* tag, so a MANUAL_TAGS filter
    // dropped it and left the form with a disabled button and no field.
    expect(collectableTags(["cnic"])).toEqual(["cnic"]);
    expect(collectableTags(["joining_date"])).toEqual(["joining_date"]);
    expect(collectableTags(["designation", "department"])).toEqual(["designation", "department"]);
  });

  it("still collects the always-manual tags", () => {
    expect(collectableTags(["new_salary", "effective_date"])).toEqual([
      "new_salary",
      "effective_date",
    ]);
  });

  it("mixes auto and manual in one pass", () => {
    expect(collectableTags(["cnic", "new_salary", "department"])).toEqual([
      "cnic",
      "new_salary",
      "department",
    ]);
  });

  it("never offers a field for an unknown tag", () => {
    // There is no sensible field for "$foo"; that is a template authoring bug
    // and stays a hard failure rather than becoming a text box.
    expect(collectableTags(["not_a_real_tag"])).toEqual([]);
    expect(collectableTags(["cnic", "not_a_real_tag"])).toEqual(["cnic"]);
  });

  it("handles an empty list", () => {
    expect(collectableTags([])).toEqual([]);
  });

  it("covers every tag the catalogue declares", () => {
    // Any tag we know about must be collectable, which is exactly the property
    // the old MANUAL_TAGS filter violated.
    const every = MERGE_TAGS.map((t) => t.tag);
    expect(collectableTags(every)).toEqual(every);
  });
});

describe("tagLabel", () => {
  it("renders an acronym correctly instead of humanising it", () => {
    // "cnic".replace(/_/g," ") -> "Cnic". The label map avoids that.
    expect(tagLabel("cnic")).toBe("CNIC");
  });

  it("humanises multi-word tags the way the UI would", () => {
    expect(tagLabel("joining_date")).toBe("Joining date");
  });

  it("falls back to the raw tag for something unrecognised", () => {
    expect(tagLabel("mystery")).toBe("mystery");
  });

  it("is case-insensitive, like tag resolution itself", () => {
    expect(tagLabel("CNIC")).toBe("CNIC");
  });
});

describe("allTagLabels", () => {
  it("covers the whole catalogue", () => {
    const labels = allTagLabels();
    expect(Object.keys(labels).length).toBe(MERGE_TAGS.length);
    expect(labels.cnic).toBe("CNIC");
  });

  it("returns a plain object, not undefined", () => {
    expect(typeof allTagLabels()).toBe("object");
  });
});

describe("end-to-end: an employee record missing its CNIC", () => {
  const body = "CNIC: $cnic\nName: $employee_name\nSalary: $new_salary";

  it("offers a field instead of deadlocking", () => {
    // The record has no CNIC, so the tag cannot resolve.
    const { text, unresolved } = renderTemplate(body, {}, {
      employee_name: "Kinza",
      cnic: "",
      new_salary: "",
    });

    expect(unresolved).toContain("cnic");
    const fields = collectableTags(unresolved);
    expect(fields).toContain("cnic");
    // So the form has something to render, and submit is not stuck for a reason
    // the user cannot see.
    expect(fields.length).toBeGreaterThan(0);
  });

  it("fills the tag once HR supplies it", () => {
    const { text, unresolved } = renderTemplate(body, { cnic: "42501-2626267-2" }, {
      employee_name: "Kinza",
      cnic: "",
      new_salary: "",
    });

    expect(text).toContain("CNIC: 42501-2626267-2");
    expect(text).not.toContain("$cnic");
    expect(unresolved).not.toContain("cnic");
  });

  it("leaves the raw tag visible while it is still missing, never a blank", () => {
    // A letter printing "CNIC: " is worse than one printing the diagnostic.
    const { text } = renderTemplate(body, {}, { cnic: "", employee_name: "Kinza", new_salary: "1" });
    expect(text).toContain("$cnic");
  });

  it("does not treat a KNOWN tag as unknown", () => {
    expect(unknownTags(body)).toEqual([]);
  });
});