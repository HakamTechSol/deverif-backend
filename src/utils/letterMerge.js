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

/** Canonical merge-tag registry, including provenance and compatible template types. */
export const MERGE_TAGS = [
  { tag: "employee_name", label: "Employee name", source: "employee.full_name / candidate.full_name", help: "Taken from the employee or applicant record.", letter_types: ["offer", "increment", "experience", "employment_confirmation", "warning", "appreciation", "custom"] },
  { tag: "designation", label: "Designation", source: "employee.designation / opening.designation", help: "Offer: opening designation or a value supplied in offer terms. Other letters: employee record.", letter_types: ["offer", "increment", "experience", "employment_confirmation", "warning", "appreciation", "custom"] },
  { tag: "department", label: "Department", source: "employee.department / opening.department", help: "Offer: opening department or a value supplied in offer terms. Other letters: employee record.", letter_types: ["offer", "increment", "experience", "employment_confirmation", "warning", "appreciation", "custom"] },
  { tag: "joining_date", label: "Joining date", source: "employee.joining_date / offer_terms.joining_date", help: "Offer: agreed start date collected with offer terms. Other letters: employee record.", letter_types: ["offer", "increment", "experience", "employment_confirmation", "custom"] },
  { tag: "cnic", label: "CNIC", source: "employee.cnic / candidate.cnic", help: "Taken from the candidate when available; otherwise collected in offer terms.", letter_types: ["offer", "increment", "employment_confirmation", "warning", "custom"] },
  { tag: "organization_name", label: "Organization", source: "organizations.name", help: "Current organization name.", letter_types: ["offer", "increment", "experience", "employment_confirmation", "warning", "appreciation", "custom"] },
  { tag: "issue_date", label: "Issue date", source: "system.send_date", help: "Set by the system when the approved letter is sent/issued.", letter_types: ["offer", "increment", "experience", "employment_confirmation", "warning", "appreciation", "custom"] },
  { tag: "reference_no", label: "Reference number", source: "system.letter_reference", help: "Generated deterministically for the offer draft and preserved in its approval snapshot.", letter_types: ["offer", "increment", "experience", "employment_confirmation", "warning", "appreciation", "custom"] },
  { tag: "letter_date", label: "Letter date", source: "system.send_date", help: "Set by the system when the letter is sent/issued.", letter_types: ["offer", "increment", "experience", "employment_confirmation", "warning", "appreciation", "custom"] },
  { tag: "current_salary", label: "Current salary", source: "manual", help: "Entered by HR for a salary increment letter.", letter_types: ["increment", "custom"] },
  { tag: "new_salary", label: "New salary", source: "manual", help: "Increment letter: new salary. Offer letter: offered salary, entered by HR.", letter_types: ["offer", "increment", "custom"] },
  { tag: "effective_date", label: "Effective date", source: "manual", help: "Entered by HR for a salary change.", letter_types: ["increment", "custom"] },
  { tag: "increment_percentage", label: "Increment %", source: "manual", help: "Entered by HR for a salary increment letter.", letter_types: ["increment", "custom"] },
  { tag: "total_experience", label: "Total experience", source: "manual", help: "Entered by HR from verified work history.", letter_types: ["experience", "custom"] },
  { tag: "last_working_date", label: "Last working date", source: "manual", help: "Entered by HR from the separation record.", letter_types: ["experience", "custom"] },
  { tag: "warning_reason", label: "Warning reason", source: "manual", help: "Entered by HR and approved under the organization policy.", letter_types: ["warning", "custom"] },
];

export const OFFER_TAGS = MERGE_TAGS.filter((tag) => tag.letter_types.includes("offer"));
export const MANUAL_TAGS = MERGE_TAGS.filter((t) => t.source === "manual").map((t) => t.tag);
const KNOWN_TAGS = new Set(MERGE_TAGS.map((t) => t.tag));
const LABELS = new Map(MERGE_TAGS.map((t) => [t.tag, t.label]));

export function tagsForLetterType(letterType = "custom") {
  return MERGE_TAGS.filter((tag) => tag.letter_types.includes(letterType));
}
export function tagsForBody(body) {
  return extractTags(body);
}
export function collectableTags(unresolved) {
  return [...new Set(unresolved)].filter((tag) => KNOWN_TAGS.has(tag));
}
export function tagLabel(tag, letterType = "custom") {
  const found = tagsForLetterType(letterType).find((item) => item.tag === String(tag).toLowerCase());
  if (found && letterType === "offer" && tag === "new_salary") return "Offered salary";
  return found?.label ?? LABELS.get(String(tag).toLowerCase()) ?? String(tag);
}
export function allTagLabels(letterType = "custom") {
  return Object.fromEntries(tagsForLetterType(letterType).map((item) => [item.tag, tagLabel(item.tag, letterType)]));
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
  const unresolved = new Set();

  const text = String(body ?? "").replace(TAG_PATTERN, (match, rawTag) => {
    const tag = rawTag.toLowerCase();
    const value = merged[tag];
    if (value === undefined || value === null || value === "") {
      unresolved.add(tag);
      return match; // visible diagnostic, never an empty gap in a letter
    }
    return display(value, tag.endsWith("_date") ? { dateStyle: "medium" } : undefined);
  });

  return { text, unresolved: [...unresolved] };
}

/**
 * Validation for a template body, shared by the create/update endpoints and by
 * issuance so a bad template is caught when it is saved rather than when an
 * employee is waiting for their letter.
 */
export function unsupportedTags(body, letterType = "custom") {
  const supported = new Set(tagsForLetterType(letterType).map((item) => item.tag));
  return extractTags(body).filter((tag) => KNOWN_TAGS.has(tag) && !supported.has(tag));
}

export function validateBody(body, letterType = "custom") {
  const problems = [];
  const text = String(body ?? "").trim();
  if (!text) problems.push("body is required");
  if (text.length > 65000) problems.push("body is too long");

  const used = extractTags(text);
  const unknown = used.filter((tag) => !KNOWN_TAGS.has(tag));
  const unsupported = unsupportedTags(text, letterType);
  if (unknown.length) problems.push(`unknown merge tag(s): ${unknown.map((t) => `$${t}`).join(", ")}`);
  if (unsupported.length) problems.push(`merge tag(s) not supported for ${letterType} letters: ${unsupported.map((t) => `$${t}`).join(", ")}`);
  return { valid: problems.length === 0, problems, tags: used };
}