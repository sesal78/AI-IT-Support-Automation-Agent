import { defineConfig } from "@trigger.dev/sdk";

// Trigger.dev cloud project "AI IT Support Agent" (org Topues), created in
// human step H2 on 2026-09-27. The ref is not a secret.
const PROJECT_REF = "proj_sefqgwbhymcyikibqjmo";

export default defineConfig({
  project: PROJECT_REF,
  dirs: ["./src/trigger"],
  maxDuration: 300,
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      factor: 2,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 10000,
      randomize: true,
    },
  },
});
