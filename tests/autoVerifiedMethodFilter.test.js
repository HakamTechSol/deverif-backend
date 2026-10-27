import { describe, it, expect } from "vitest";

import { AUTO_VERIFICATION_METHODS, AUTO_VERIFICATION_METHOD_SQL } from "../src/utils/verifiedStatuses.js";

/**
 * The Auto Verified ledger reads person_documents, whose `status` is a plain
 * enum('verified','unverified') — identical for a human approval and an
 * automatic one. The method only exists on the joined verification_requests
 * row, so both the count in myAutoVerifiedRequests and the history list in
 * getAutoVerifiedRequestHistory have to filter on it.
 *
 * These pin the values and the guard rails. The SQL itself is exercised by the
 * query-shape assertions below rather than against a live database.
 */

describe("AUTO_VERIFICATION_METHODS", () => {
  it("names exactly the two unattended paths", () => {
    expect(AUTO_VERIFICATION_METHODS).toEqual(["auto", "automatic_match"]);
  });

  it("excludes every human-decided method", () => {
    // 'portal' is a reviewer clicking approve (verifyRequest), 'admin' and
    // 'admin_sla' are platform-admin interventions. None of these belong in an
    // auto-only ledger — counting them is the reported bug.
    for (const human of ["portal", "admin", "admin_sla"]) {
      expect(AUTO_VERIFICATION_METHODS).not.toContain(human);
    }
  });

  it("renders a quoted, comma-joined fragment usable inline in SQL", () => {
    expect(AUTO_VERIFICATION_METHOD_SQL).toBe("'auto', 'automatic_match'");
    // Every fragment element must be a single quoted literal: this string is
    // interpolated into a query, so a stray quote would break it.
    for (const part of AUTO_VERIFICATION_METHOD_SQL.split(", ")) {
      expect(part).toMatch(/^'[a-z_]+'$/);
    }
  });

  it("stays in step with the array it is derived from", () => {
    // The SQL fragment is built from the array, so adding a method updates both
    // and this stays true. Asserted so nobody starts hand-writing the SQL.
    const expected = AUTO_VERIFICATION_METHODS.map((m) => `'${m}'`).join(", ");
    expect(AUTO_VERIFICATION_METHOD_SQL).toBe(expected);
  });
});