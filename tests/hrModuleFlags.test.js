import { describe, it, expect } from "vitest";

import {
  MODULE_FEATURE_KEYS,
  MODULE_GROUPS,
  allModulesEnabledFlags,
  allModulesDeclaredExactlyOnce,
  parseModuleFlags,
  isModuleIncluded,
} from "../src/utils/moduleFlags.js";
import { upgradeRequiredError } from "../src/middleware/requireModuleFeature.js";
import {
  ALL_MODULE_KEYS,
  NEW_MODULE_KEYS,
  ORIGINAL_MODULE_KEYS,
  MODULE_LABELS,
  allEnabledFlags,
  legacyPreBackfillFlags,
} from "./helpers/moduleKeyFixtures.js";

/**
 * Invariants of the module-gating registry.
 *
 * The gate is read on EVERY authenticated org request, and the failure mode is
 * silent: a key that is missing from a plan's `module_flags` JSON evaluates to
 * BLOCKED (isModuleIncluded is `flags[key] === true`), and a module with no
 * human label echoes a raw snake_case key to the user. Neither throws. These
 * tests are therefore the only thing standing between a bad edit here and an
 * organization quietly losing access to a feature nobody notices.
 */

describe("module key registry", () => {
  it("the test fixture still mirrors the source of truth", () => {
    // If this fails, a module was added or renamed and the fixtures in
    // tests/helpers/moduleKeyFixtures.js are stale — which is exactly the drift
    // that let the old five-key arrays go unnoticed.
    expect(ALL_MODULE_KEYS).toEqual(MODULE_FEATURE_KEYS);
  });

  it("keeps the five original modules first, in their original order", () => {
    expect(MODULE_FEATURE_KEYS.slice(0, 5)).toEqual(ORIGINAL_MODULE_KEYS);
  });

  it("adds the thirteen new HR modules", () => {
    expect(MODULE_FEATURE_KEYS.length).toBe(18);
    expect(MODULE_FEATURE_KEYS.length - ORIGINAL_MODULE_KEYS.length).toBe(NEW_MODULE_KEYS.length);
    for (const key of NEW_MODULE_KEYS) expect(MODULE_FEATURE_KEYS).toContain(key);
  });

  it("has no duplicate keys", () => {
    expect(new Set(MODULE_FEATURE_KEYS).size).toBe(MODULE_FEATURE_KEYS.length);
  });
});

describe("MODULE_GROUPS is presentation-only and complete", () => {
  it("partitions MODULE_FEATURE_KEYS exactly — nothing missing, duplicated or invented", () => {
    const result = allModulesDeclaredExactlyOnce();
    expect(result.missing, `modules missing from every group: ${result.missing}`).toEqual([]);
    expect(result.duplicated, `modules listed in >1 group: ${result.duplicated}`).toEqual([]);
    expect(result.unknown, `grouped modules that are not real keys: ${result.unknown}`).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("gives every group a stable key and a label", () => {
    const keys = MODULE_GROUPS.map((g) => g.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const group of MODULE_GROUPS) {
      expect(group.label, group.key).toBeTruthy();
      expect(group.moduleKeys.length, group.key).toBeGreaterThan(0);
    }
  });
});

describe("human labels — a module must never surface a raw snake_case key", () => {
  it.each(MODULE_FEATURE_KEYS)("%s has a label", (key) => {
    const label = MODULE_LABELS[key];
    expect(label, `${key} has no entry in MODULE_LABELS`).toBeTruthy();
    expect(label).toMatch(/^[A-Z]/);
    expect(label).not.toContain("_");
  });

  it.each(MODULE_FEATURE_KEYS)("%s names itself in the 403 it raises", (key) => {
    const err = upgradeRequiredError(key);
    expect(err.statusCode).toBe(403);
    expect(err.message).toBe(`Upgrade your plan to access ${MODULE_LABELS[key]}.`);
    expect(err.extra).toMatchObject({
      module: key,
      module_label: MODULE_LABELS[key],
      can_retry: false,
    });
  });
});

describe("isModuleIncluded — the absence case is what made the backfill mandatory", () => {
  it("allows everything on a fully provisioned plan", () => {
    const flags = parseModuleFlags(JSON.stringify(allEnabledFlags()));
    for (const key of ALL_MODULE_KEYS) expect(isModuleIncluded(flags, key), key).toBe(true);
  });

  it("LOCKS every new module on a plan stored before the backfill ran", () => {
    // This is the regression the 20261101 migration prevents. It is pinned as a
    // passing assertion on purpose: if someone ever changes isModuleIncluded to
    // treat an absent key as allowed, this test fails and forces a decision
    // about whether the JSON default is still safe.
    const flags = parseModuleFlags(JSON.stringify(legacyPreBackfillFlags()));
    for (const key of ORIGINAL_MODULE_KEYS) expect(isModuleIncluded(flags, key), key).toBe(true);
    for (const key of NEW_MODULE_KEYS) expect(isModuleIncluded(flags, key), key).toBe(false);
  });

  it("blocks everything on an empty flags object, distinct from null", () => {
    const empty = parseModuleFlags("{}");
    expect(empty).not.toBeNull();
    for (const key of ALL_MODULE_KEYS) expect(isModuleIncluded(empty, key), key).toBe(false);
  });

  it("treats a legacy NULL flags column as unrestricted", () => {
    for (const key of ALL_MODULE_KEYS) expect(isModuleIncluded(parseModuleFlags(null), key), key).toBe(true);
  });

  it("accepts mysql2 returning the JSON already decoded as an object", () => {
    const asObject = parseModuleFlags(allEnabledFlags());
    for (const key of ALL_MODULE_KEYS) expect(isModuleIncluded(asObject, key), key).toBe(true);
  });

  it("treats malformed JSON as an empty object, i.e. everything locked", () => {
    // Fail-closed on corruption is deliberate: a plan whose flags cannot be read
    // must not become silently unrestricted.
    const broken = parseModuleFlags("{not json");
    expect(broken).toEqual({});
    expect(isModuleIncluded(broken, "payroll_management")).toBe(false);
  });
});

describe("allModulesEnabledFlags", () => {
  it("grants every module", () => {
    const flags = allModulesEnabledFlags();
    expect(Object.keys(flags).sort()).toEqual([...MODULE_FEATURE_KEYS].sort());
    expect(Object.values(flags).every((v) => v === true)).toBe(true);
  });

  it("returns a fresh object each call so one caller cannot poison the next", () => {
    // A shared frozen module-level constant is the trap here: a single
    // `DEFAULT_MODULE_FLAGS.x = false` in one code path would silently alter
    // every plan created afterwards in the same process.
    const a = allModulesEnabledFlags();
    a.payroll_management = false;
    const b = allModulesEnabledFlags();
    expect(b.payroll_management).toBe(true);
  });
});