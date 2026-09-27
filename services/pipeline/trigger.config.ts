import { defineConfig } from "@trigger.dev/sdk";

// PLACEHOLDER project ref. Human step H2 creates the Trigger.dev project
// (dev + staging + prod envs); replace this with its real ref then.
const PROJECT_REF = "proj_placeholder_h2";

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
