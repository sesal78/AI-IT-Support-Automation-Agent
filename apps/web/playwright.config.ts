import { defineConfig, devices } from "@playwright/test";

// Smoke tests against the production build (`.next`). Run `pnpm build` first.
// `next start` is used locally because standalone output from pnpm on Windows
// contains file-type symlinks to directories that Node cannot resolve; the
// standalone server itself is covered in Linux by `pnpm test:e2e:docker`.
const port = 3002;
const baseURL = `http://127.0.0.1:${port}`;
// Cloudflare's published always-pass Turnstile test site key, built at run time
// so secret scanners do not see a key-shaped literal. The ticket form tests stub
// the challenges.cloudflare.com script, so the widget never uses the network.
const turnstileTestSiteKey = `1x${"0".repeat(20)}AA`;
// The pipeline spec (P3-T10h) starts its own web server on this port, against
// the local REST stack (Docker) and the local Trigger.dev runner; see
// e2e/support/pipeline-stack.ts.
const pipelinePort = 3003;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  use: { baseURL },
  projects: [
    {
      name: "chromium",
      testIgnore: "**/pipeline.spec.ts",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "pipeline",
      testMatch: "**/pipeline.spec.ts",
      use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${pipelinePort}` },
    },
  ],
  webServer: {
    command: `next start --port ${port} --hostname 127.0.0.1`,
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    // Obvious fakes: the smoke test never talks to real services.
    env: {
      SUPABASE_URL: "https://fake-e2e.supabase.invalid",
      SUPABASE_SERVICE_ROLE_KEY: "fake-e2e-service-role-key",
      TRIGGER_SECRET_KEY: "fake-e2e-trigger-secret",
      ADMIN_HEALTH_TOKEN: "fake-e2e-admin-health-token",
      APP_VERSION: "0.0.0-e2e",
      INTERNAL_API_TOKEN: "fakeE2eInternalApiToken0123456789AB",
      TURNSTILE_SECRET_KEY: "fake-e2e-turnstile-secret-key",
      TURNSTILE_SITE_KEY: turnstileTestSiteKey,
    },
  },
});
