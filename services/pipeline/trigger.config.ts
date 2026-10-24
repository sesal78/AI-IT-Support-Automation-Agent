import { defineConfig } from "@trigger.dev/sdk";
import { resolveProjectRef } from "./src/project-ref.js";

export default defineConfig({
  // TRIGGER_PROJECT_REF when set (the e2e project), else the main project.
  project: resolveProjectRef(process.env),
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
