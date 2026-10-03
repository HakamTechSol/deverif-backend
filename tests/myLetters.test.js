import { describe, it, expect, vi, beforeEach } from "vitest";

// Employee self-service for HR Letters.
//
// The security property is that an employee can read ONLY their own letters.
// There is deliberately no employee_uuid parameter to tamper with — the employee
// is resolved from the JWT via employees.linked_user_uuid — so the tests assert
// that the scoping comes from the authenticated user and never from input.

vi.mock("../src/config/db.js", () => ({ pool: { query: vi.fn() } }));

import { pool } from "../src/config/db.js";
import {
  listMyLetters,
  getMyLetter,
  downloadMyLetterPdf,
} from "../src/controllers/myLetters.controller.js";

const ORG = 2;
const USER = "11111111-1111-4111-8111-111111111111";
const EMPLOYEE = "22222222-2222-4222-8222-222222222222";
const OTHER_EMPLOYEE = "33333333-3333-4333-8333-333333333333";
const LETTER = "44444444-4444-4444-8444-444444444444";

const employeeRow = [{ uuid: EMPLOYEE, full_name: "Asim Khan", designation: "Engineer" }];

function mockRes() {
  const res = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.setHeader = vi.fn(() => res);
  res.send = vi.fn(() => res);
  return res;
}

function req(over = {}) {
  return { params: {}, query: {}, user: { uuid: USER }, scopeOrgId: ORG, ...over };
}

/** Route the two queries the controller makes. */
function install(opts = {}) {
  const employee = opts.employee === undefined ? employeeRow : opts.employee;
  const letter = opts.letter || [];
  pool.query.mockImplementation(async (sql) => {
    const text = String(sql);
    if (text.includes("linked_user_uuid")) return [employee, []];
    // The COUNT query returns [[{total}], []]; the row query returns [rows, []].
    // Returning rows for the count makes `[[{ total }]]` destructure to undefined.
    if (text.includes("COUNT(*)")) return [[{ total: letter.length }], []];
    if (text.includes("FROM hr_letters")) return [letter, []];
    return [[], []];
  });
}

function callOf(fragment) {
  return pool.query.mock.calls.find(([s]) => String(s).includes(fragment));
}

beforeEach(() => {
  vi.clearAllMocks();
  pool.query.mockReset();
  // Building a verification URL resolves this eagerly and throws when missing,
  // so any test that reaches a qr_token row needs it present.
  process.env.QR_VERIFY_BASE_URL = process.env.QR_VERIFY_BASE_URL || "https://www.dverif.com";
});

describe("listMyLetters", () => {
  it("resolves the employee from the JWT, ignoring any caller-supplied id", async () => {
    install();
    // A caller passing someone else's employee_uuid must change nothing.
    await listMyLetters(req({ query: { employee_uuid: OTHER_EMPLOYEE } }), mockRes());

    const lookup = callOf("linked_user_uuid");
    expect(String(lookup[0])).toContain("organization_id=?");
    expect(lookup[1]).toEqual([ORG, USER]);

    const params = callOf("l.employee_uuid = ?")[1];
    expect(params[0]).toBe(EMPLOYEE);
    expect(params).not.toContain(OTHER_EMPLOYEE);
  });

  it("only ever returns ISSUED letters", async () => {
    install();
    await listMyLetters(req(), mockRes());

    // A draft is unfinished internal work, and a revoked letter has had its
    // attestation withdrawn — showing either to the employee would mislead.
    expect(String(callOf("l.employee_uuid = ?")[0])).toContain("l.status = 'issued'");
  });

  it("returns an empty page for a user with no employee record, not an error", async () => {
    // Sub-admins and org admins have no employee row. That is normal, not a fault.
    install({ employee: [] });
    const res = mockRes();
    await listMyLetters(req(), res);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("attaches the public verification link to each row", async () => {
    install({
      letter: [
        { uuid: LETTER, reference_no: "HR/2026/0001", status: "issued", qr_token: "a".repeat(64) },
      ],
    });
    const res = mockRes();
    await listMyLetters(req(), res);
    const body = res.json.mock.calls[0][0];
    expect(body.data.items[0].verify_url).toContain(`/verify/letter/${"a".repeat(64)}`);
  });
});

describe("getMyLetter / downloadMyLetterPdf — cannot read someone else's", () => {
  it("404s when the letter belongs to a different employee", async () => {
    install();
    await expect(getMyLetter(req({ params: { uuid: LETTER } }), mockRes())).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("scopes the single-letter lookup by employee AND issued status", async () => {
    install();
    await getMyLetter(req({ params: { uuid: LETTER } }), mockRes()).catch(() => {});

    const call = callOf("FROM hr_letters l");
    expect(String(call[0])).toContain("l.employee_uuid=?");
    expect(String(call[0])).toContain("l.status='issued'");
    expect(call[1]).toEqual([LETTER, EMPLOYEE]);
  });

  it("404s rather than serving a revoked letter's PDF", async () => {
    install();
    await expect(
      downloadMyLetterPdf(req({ params: { uuid: LETTER } }), mockRes()),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("404s for a user outside the organization", async () => {
    install({ employee: [] });
    await expect(getMyLetter(req({ params: { uuid: LETTER } }), mockRes())).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});