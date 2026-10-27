import { defineConfig } from "vitest/config";

/**
 * WHY THE SUITE IS SPLIT INTO TWO PROJECTS.
 *
 * The 13 `*.db.test.js` files are real-database integration suites. They open their
 * own mysql2 connections and they all share ONE MySQL instance, so running them in
 * parallel makes them contend with each other. The symptom is not a clean assertion
 * failure — it is a suite that dies in `beforeAll` and takes its whole file with it:
 * two consecutive full runs failed DIFFERENT files, and one of them reported 143
 * passing tests and 0 failing while silently not running the file at all. Every one
 * of those suites passes reliably on its own, which is what makes the failure so
 * confusing to chase.
 *
 * So the db suites run with `fileParallelism: false`. That is scoped to them alone
 * rather than applied to the whole suite because it is not free: measured on this
 * machine the full suite takes ~117s sequential against ~49s parallel, and 73 of
 * the 86 files never touch the database. Making everything sequential would buy
 * determinism for the 13 files that need it by slowing the other 73 by 2.4x.
 *
 * Splitting by project (rather than `poolMatchGlobs`, which Vitest 4 removed) also
 * keeps `npm test` honest: a plain `npx vitest run` now runs BOTH projects, so the
 * default command is deterministic without anyone having to remember a flag.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          globals: true,
          environment: "node",
          include: ["tests/**/*.test.js"],
          exclude: ["tests/**/*.db.test.js"],
        },
      },
      {
        test: {
          name: "db",
          globals: true,
          environment: "node",
          include: ["tests/**/*.db.test.js"],
          // The whole point: one db suite at a time, so they cannot interleave
          // their fixtures and tear-downs on a shared MySQL instance.
          fileParallelism: false,
        },
      },
    ],
  },
});