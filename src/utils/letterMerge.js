/**
 * Merge-tag resolution for HR letters.
 *
 * WHY THE BODY IS NEVER EVALUATED. The obvious way to implement `Dear $name` is
 * to interpolate with eval/new Function, which turns a letter template into
 * remote code execution for anyone who can edit a template. This module only
 * ever does a literal, single-pass substitution of a KNOWN tag against a KNOWN
 * map. A tag with no value is left visible as a diagnostic rather than silently
 * becoming an empty string, because a salary letter printing "Dear ," or a blank
 * effective date is a document an employee will notice and an employer will be
 * asked to correct.
 */

/** Tags every template may use, with the employee column or derived value. */
export const MERGE_TAGS = [
  { tag: "employee_name", label: "Employee name", source: "employee.full_name" },
  { tag: "designation", label: "Designation", source: "employee.designation" },
  { tag: "department", label: "Department", source: "employee.department" },
  { tag: "joining_date", label: "Joining date", source: "employee.joining_date" },
  { tag: "cnic", label: "CNIC", source: "employee.cnic" },
  { tag: "organization_name", label: "Organization", source: "organization" },
  { tag: "issue_date", label: "Issue date", source: "system" },
  { tag: "reference_no", label: "Reference number", source: "system" },
  { tag: "letter_date", label: "Letter date", source: "system" },
  { tag: "current_salary", label: "Current salary", source: "manual" },
  { tag: "new_salary", label: "New salary", source: "manual" },
  { tag: "effective_date", label: "Effective date", source: "manual" },
  { tag: "increment_percentage", label: "Increment %", source: "manual" },
  { tag: "total_experience", label: "Total experience", source: "manual" },
  { tag: "last_working_date", label: "Last working date", source: "manual" },
  { tag: "warning_reason", label: "Warning reason", source: "manual" },
];

export const MANUAL_TAGS = MERGE_TAGS.filter((t) => t.source === "manual").map((t) => t.tag);

const KNOWN_TAGS = new Set(MERGE_TAGS.map((t) => t.tag));

const LABELS = new Map(MERGE_TAGS.map((t) => [t.tag, t.label]));

/**
 * Tags the issue form must collect from a human.
 *
 * DELIBERATELY NOT THE SAME AS MANUAL_TAGS, and this distinction was a real
 * dead end. A manual tag is one nobody can ever derive, so it always needs a
 * person. An AUTO tag that merely happens to be EMPTY for this employee - no CNIC
 * on file, joining date never recorded - equally needs a person.
 *
 * Filtering by MANUAL_TAGS only meant such a tag landed in `unresolved` while
 * being absent from `missing_manual`, so the issue form rendered no input for it
 * and kept submit disabled (gated on `unresolved`). The letter could not be
 * issued at all, with nothing on screen explaining why. $cnic hit this whenever
 * the employee record had no CNIC.
 *
 * So: anything unresolved that we at least RECOGNISE is collectable. Only a
 * genuinely unknown tag stays uncollectable, because there is no sensible field
 * to show for it - that remains a template authoring bug.
 */
export function collectableTags(unresolved) {
  return unresolved.filter((tag) => KNOWN_TAGS.has(tag));
}

/** Friendly label for a tag, e.g. "cnic" -> "CNIC". Falls back to the tag. */
export function tagLabel(tag) {
  return LABELS.get(String(tag).toLowerCase()) ?? String(tag);
}

/** Every tag's label, for a client that renders the whole palette at once. */
export function allTagLabels() {
  return Object.fromEntries(LABELS);
}

// Case-insensitive, and one character is enough: a template author may write
// $x. It cannot misfire on money, because a currency amount never starts with a
// letter or underscore.
const TAG_PATTERN = /\$([a-z_][a-z0-9_]{0,40})/gi;

/** Every distinct tag a body references, in first-appearance order. */
export function extractTags(body) {
  const found = [];
  const seen = new Set();
  for (const match of String(body ?? "").matchAll(TAG_PATTERN)) {
    // Lowercased here so extractTags, unknownTags and validateBody agree with
    // renderTemplate, which has always resolved tags case-insensitively. Without
    // this, a template written as $Employee_Name renders fine but fails
    // validation as an "unknown tag".
    const tag = match[1].toLowerCase();
    if (!seen.has(tag)) {
      seen.add(tag);
      found.push(tag);
    }
  }
  return found;
}

/**
 * Tags a body references that this module does not know how to fill.
 *
 * A template with an unknown tag would print it literally onto a letter given to
 * an employee, so issuance refuses rather than producing a broken document.
 */
export function unknownTags(body) {
  return extractTags(body).filter((tag) => !KNOWN_TAGS.has(tag));
}

/** Human-readable value: dates in en-PK, nulls as an empty string. */
function display(value, dateStyle) {
  if (value === null || value === undefined || value === "") return "";
  if (dateStyle && (value instanceof Date || /^\d{4}-\d{2}-\d{2}/.test(String(value)))) {
    const d = value instanceof Date ? value : new Date(String(value).slice(0, 10) + "T00:00:00Z");
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleDateString("en-PK", { timeZone: "Asia/Karachi", ...dateStyle });
    }
  }
  return String(value);
}

/**
 * Substitute $tags in a body.
 *
 * `values` wins over `defaults` so a caller can override anything; anything
 * still unresolved is LEFT AS-IS in the output (see module docstring) and
 * reported in `unresolved` for the caller to surface or reject on.
 *
 * @returns {{ text: string, unresolved: string[] }}
 */
export function renderTemplate(body, values = {}, defaults = {}) {
  const merged = { ...defaults, ...values };
  const unresolved = [];

  const text = String(body ?? "").replace(TAG_PATTERN, (match, rawTag) => {
    const tag = rawTag.toLowerCase();
    const value = merged[tag];
    if (value === undefined || value === null || value === "") {
      unresolved.push(tag);
      return match; // visible diagnostic, never an empty gap in a letter
    }
    return display(value, tag.endsWith("_date") ? { dateStyle: "medium" } : undefined);
  });

  return { text, unresolved };
}

/**
 * Validation for a template body, shared by the create/update endpoints and by
 * issuance so a bad template is caught when it is saved rather than when an
 * employee is waiting for their letter.
 */
export function validateBody(body) {
  const problems = [];
  const text = String(body ?? "").trim();
  if (!text) problems.push("body is required");
  if (text.length > 65000) problems.push("body is too long");

  const unknown = unknownTags(text);
  if (unknown.length) {
    problems.push(`unknown merge tag(s): ${unknown.map((t) => `$${t}`).join(", ")}`);
  }
  return { valid: problems.length === 0, problems, tags: extractTags(text) };
}