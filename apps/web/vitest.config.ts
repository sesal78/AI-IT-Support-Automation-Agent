import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";

export default defineProject({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // Tests run against workspace package source, so they do not need a prior build of dist/.
      "@ai-it-support/shared": fileURLToPath(
        new URL("../../packages/shared/src/index.ts", import.meta.url),
      ),
      "@ai-it-support/db": fileURLToPath(
        new URL("../../packages/db/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    name: "web",
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
    // Obvious fakes for the phase 2 and 4 env vars, so a test that stubs only the
    // phase 1 vars still loads the env module. Tests that check these vars
    // stub or unset them explicitly.
    env: {
      INTERNAL_API_TOKEN: "fakeInternalApiToken0123456789ABCDEF",
      TURNSTILE_SECRET_KEY: "fake-turnstile-secret-key",
      TURNSTILE_SITE_KEY: "fake-turnstile-site-key",
      SLACK_SIGNING_SECRET: "f".repeat(32),
      SLACK_REVIEWER_IDS: "U0000000000",
      SLACK_CHANNEL_ID: "C0000000000",
    },
  },
});
