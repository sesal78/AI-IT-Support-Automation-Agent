import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// The internal API route handlers run against the local REST stack (Docker),
// with the egress recorder on. Kept out of the unit run (`pnpm test`).
export default defineConfig({
  resolve: {
    alias: {
      "@": here("./src"),
      "@ai-it-support/shared": here("../../packages/shared/src/index.ts"),
      "@ai-it-support/db": here("../../packages/db/src/index.ts"),
    },
  },
  test: {
    name: "web-integration",
    environment: "node",
    include: ["integration/**/*.integration.test.ts"],
    // Starts the recorder at the top level of the setup file and runs the PII
    // clean check after every test. Shared with the pipeline integration run.
    setupFiles: [here("../../services/pipeline/test-support/egress-setup.ts")],
    testTimeout: 60_000,
    hookTimeout: 240_000,
    fileParallelism: false,
    // Obvious fakes for the phase 1, 2 and 4 env modules, so a test that stubs
    // only the stack values still loads the env module. A test that checks a
    // variable stubs or unsets it explicitly.
    env: {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "fake-service-role-key",
      SUPABASE_DB_SCHEMA: "itsupport",
      SUPABASE_ANON_KEY: "fake-anon-key",
      TRIGGER_SECRET_KEY: "fake-trigger-secret",
      ADMIN_HEALTH_TOKEN: "fake-admin-health-token",
      APP_VERSION: "0.0.0-test",
      INTERNAL_API_TOKEN: "fakeInternalApiToken0123456789ABCDEF",
      TURNSTILE_SECRET_KEY: "fake-turnstile-secret-key",
      TURNSTILE_SITE_KEY: "fake-turnstile-site-key",
      SLACK_SIGNING_SECRET: "f".repeat(32),
      SLACK_REVIEWER_IDS: "U0000000000",
      SLACK_CHANNEL_ID: "C0000000000",
      HELPDESK: "servicenow",
    },
    coverage: { enabled: false },
  },
});
