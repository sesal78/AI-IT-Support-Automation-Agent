import { defineConfig } from "@playwright/test";

// The browser test of the live harness (T3.L.01 against the local mock), run
// with `pnpm test:live:browser`. Not part of the Vitest gate: the CI `test`
// job has no browser, and the CI `e2e` job runs apps/web's config only. The
// spec starts its own mocks; there is no web server and no network.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  forbidOnly: !!process.env.CI,
  retries: 0,
  // One at a time: the scenario under test launches its own headless Chromium.
  workers: 1,
  reporter: "list",
  outputDir: "../../.loop-evidence/live-browser/test-results",
  projects: [{ name: "chromium" }],
});
