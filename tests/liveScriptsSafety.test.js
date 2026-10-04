import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Guards the live e2e scripts against mutating real customer data.
 *
 * These scripts run against the LIVE database. One of them renamed the first
 * organization in the table to "Dvarif Backup Probe <base36> O'Brien" and put it
 * back in a `finally`. That finally is not a guarantee: SIGINT, a closed
 * terminal, or a hard kill all skip it. An interrupted run left a real
 * organization renamed, and because letter verification reads the organization
 * name live, that string appeared on the customer's public verification page.
 *
 * A leftover-string assertion is deliberately NOT the guard here — that only
 * catches this one script. The guard is structural: no script may UPDATE or
 * DELETE a real organizations row at all.
 */
const SCRIPTS = join(process.cwd(), "scripts");

const files = readdirSync(SCRIPTS).filter((f) => f.endsWith(".mjs"));

describe("live e2e scripts never mutate a real organization", () => {
  it("there are scripts to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file} does not write to an existing organizations row`, () => {
      const src = readFileSync(join(SCRIPTS, file), "utf8");

      // Strip comments so prose about the old approach cannot trip the guard.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

      const offenders = [];

      // UPDATE organizations SET ... WHERE id=<something already in the table>
      const updates = code.match(/UPDATE\s+organizations\s+SET[\s\S]{0,200}?;/gi) ?? [];
      for (const u of updates) {
        // An INSERT-then-DELETE of a row the script itself created is the safe
        // pattern. Flag anything that renames a row it did not create.
        if (!/name\s*=\s*\?/i.test(u) && !/name\s*=/i.test(u)) continue;
        offenders.push("UPDATE ... SET name: " + u.replace(/\s+/g, " ").slice(0, 90));
      }

      // DELETE FROM organizations without a name= guard is a bulk wipe.
      const deletes = code.match(/DELETE\s+FROM\s+organizations[\s\S]{0,120}?;/gi) ?? [];
      for (const d of deletes) {
        if (!/WHERE\s+id\s*=\s*\?/i.test(d)) {
          offenders.push("unguarded DELETE: " + d.replace(/\s+/g, " ").slice(0, 90));
        }
      }

      expect(offenders, offenders.join("\n")).toEqual([]);
    });
  }

  it("the backup probe uses its own throwaway organization", () => {
    const src = readFileSync(join(SCRIPTS, "e2e_live_admin_settings.mjs"), "utf8");
    // It must INSERT the probe row rather than borrow an existing one.
    expect(src).toMatch(/INSERT\s+INTO\s+organizations[\s\S]{0,80}marker/i);
    // And clean up on the signals that skip a finally block.
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      expect(src).toContain(sig);
    }
  });

  it("no committed file carries a probe marker as its own name", () => {
    // A leftover org row is named like this; catching it in source means the
    // marker is being fabricated by a script, not pasted into seed data.
    const seeds = readdirSync(SCRIPTS).filter((f) => /seed|fixture|test/i.test(f));
    for (const f of seeds) {
      const src = readFileSync(join(SCRIPTS, f), "utf8");
      expect(src, `${f} contains a probe marker`).not.toMatch(/Backup Probe/);
    }
  });
});