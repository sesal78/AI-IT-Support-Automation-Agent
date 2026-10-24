import { defineConfig } from "vitest/config";
import { setupFiles } from "../vitest.integration.config.js";

// Runs the leak fixture with the same setup file as the integration config, so
// the sample test can prove that a leaking test fails the check.
export default defineConfig({
  test: {
    name: "pipeline-egress-selftest",
    include: ["test-support/fixtures/*.fixture.test.ts"],
    setupFiles,
    coverage: { enabled: false },
  },
});
