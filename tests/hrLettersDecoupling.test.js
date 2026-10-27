import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * HR Letters must stay a DIRECT issuance module: Draft -> Issued -> PDF.
 *
 * It deliberately shares nothing with the verification-request queue. A letter
 * is issued by HR and attested by the SAME organization's HMAC signature, so it
 * has no business acquiring a request row, entering a review queue, or
 * consuming daily request quota. If a letter ever did, it would surface on
 * /org/requests and /my-requests as an item awaiting a verification it does not
 * need, and would inflate an employee's request count.
 *
 * The decoupling was already true; these tests exist so it cannot quietly stop
 * being true, because the coupling would be a one-line change that no
 * behavioural test would notice.
 */

/** Tests run with cwd = backend/, so backend paths are direct. */
const BACKEND = ".";
/** The SPA is a sibling checkout, not always present (e.g. a backend-only CI). */
const FRONTEND = "../dvarif-verified";

const LIFECYCLE_FILES = [
  "src/services/hrLetters.service.js",
  "src/controllers/org/hrLetters.controller.js",
  "src/controllers/myLetters.controller.js",
  "src/utils/hrLetterPdf.js",
  "src/utils/letterQr.js",
];

const FRONTEND_FILES = [
  "src/routes/_app.org.hr-letters.tsx",
  "src/routes/_app.org.letter-templates.tsx",
  "src/routes/_app.my-letters.tsx",
  "src/components/hr/IssueLetterDialog.tsx",
  "src/routes/verify.letter.$qrToken.tsx",
];

/** Tables a letter must never acquire a row in. */
const QUEUE_TABLES = [
  "verification_requests",
  "approval_requests",
  "daily_request_usage",
  "attachments",
];

const HAVE_FRONTEND = FRONTEND_FILES.every((f) => existsSync(join(FRONTEND, f)));

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("HR Letters do not touch the verification request flow", () => {
  it("the lifecycle files are where we expect them", () => {
    for (const f of LIFECYCLE_FILES) {
      expect(readFileSync(join(BACKEND, f), "utf8").length).toBeGreaterThan(0);
    }
  });

  for (const file of LIFECYCLE_FILES) {
    it(`${file} writes to no queue table`, () => {
      const code = stripComments(readFileSync(join(BACKEND, file), "utf8"));

      for (const table of QUEUE_TABLES) {
        // Any INSERT/UPDATE/DELETE naming a queue table is a coupling.
        const write = new RegExp(
          `(INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+\`?${table}\`?\\b`,
          "i",
        );
        expect(code, `${file} writes to ${table}`).not.toMatch(write);
      }
    });
  }

  it("the lifecycle files never import the verification request service", () => {
    for (const file of LIFECYCLE_FILES) {
      const code = stripComments(readFileSync(join(BACKEND, file), "utf8"));
      expect(code, `${file} imports a verification service`).not.toMatch(
        /from\s+["'][^"']*(verification|request)[^"']*["']/i,
      );
    }
  });

  it("issuing a letter is not routed through a request endpoint", () => {
    // The route table is the surface an API caller can reach. No letter action
    // may point at a verification-request path.
    const routes = readFileSync(join(BACKEND, "src/routes/org.routes.js"), "utf8");
    const letterRoutes = routes.split("\n").filter((l) => /hr-letters/.test(l));
    expect(letterRoutes.length).toBeGreaterThan(0);
    for (const line of letterRoutes) {
      expect(line, `letter route points at a request path: ${line.trim()}`).not.toMatch(
        /verification-requests|\/requests\b/,
      );
    }
  });

  it("letters keep their own self-service endpoints, separate from /my-requests", () => {
    const routes = readFileSync(join(BACKEND, "src/routes/index.js"), "utf8");
    expect(routes).toContain("/my-letters");
    // Nothing mounts the letter endpoints under a request prefix.
    expect(routes).not.toMatch(/use\(\s*["'][^"']*requests[^"']*["']\s*,\s*\w*[Ll]etter/);
  });

  // The SPA lives in a separate repository. Skipped rather than failed when it
  // is not checked out, so a backend-only CI stays green instead of reporting a
  // coupling that cannot exist.
  describe.skipIf(!HAVE_FRONTEND)("frontend letter pages", () => {
    it("never call a verification-request endpoint", () => {
      for (const file of FRONTEND_FILES.slice(0, 4)) {
        const src = readFileSync(join(FRONTEND, file), "utf8");
        // Endpoints only; the word "request" in prose must not trip this.
        expect(src, `${file} calls a verification-request endpoint`).not.toMatch(
          /["'`]\/[^"'`]*(verification-requests|\/requests)[^"'`]*["'`]/,
        );
        expect(src, `${file} uses a verification-request service`).not.toMatch(
          /verificationRequests?\.|myRequests\./,
        );
      }
    });

    it("the public letter page reads the letter endpoint only", () => {
      const page = readFileSync(join(FRONTEND, FRONTEND_FILES[4]), "utf8");
      expect(page).toContain("verifyLetter");
      // A public letter check must not consult the document verification service.
      expect(page).not.toMatch(/verifyService\.verify\(/);
    });
  });

  it("letters are navigable without passing through a requests page", () => {
    if (!HAVE_FRONTEND) return;
    const nav = readFileSync(join(FRONTEND, "src/lib/navItems.ts"), "utf8");
    // Letters get their own entries rather than being reached via a request.
    expect(nav).toContain('to: "/org/hr-letters"');
    expect(nav).toContain('to: "/my-letters"');
  });
});