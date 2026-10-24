// Loads the SDK up front: a cold import inside the first test can outlast its timeout.
import "@trigger.dev/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

const MAIN_REF = "proj_sefqgwbhymcyikibqjmo";
const E2E_REF = "proj_vfnbcjuxsprwbkuzjrlc";

// Everything except `project` must stay as it was before TRIGGER_PROJECT_REF.
const unchanged = {
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
};

async function loadConfig() {
  return (await import("../trigger.config.js")).default;
}

describe("trigger.config.ts", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("targets the project named by TRIGGER_PROJECT_REF", async () => {
    vi.stubEnv("TRIGGER_PROJECT_REF", E2E_REF);
    expect(await loadConfig()).toEqual({ project: E2E_REF, ...unchanged });
  });

  it("targets the main project when TRIGGER_PROJECT_REF is unset", async () => {
    vi.stubEnv("TRIGGER_PROJECT_REF", undefined);
    expect(await loadConfig()).toEqual({ project: MAIN_REF, ...unchanged });
  });

  it("fails to load on an invalid TRIGGER_PROJECT_REF, naming the variable", async () => {
    vi.stubEnv("TRIGGER_PROJECT_REF", "my project");
    await expect(loadConfig()).rejects.toThrow(/TRIGGER_PROJECT_REF/);
  });
});
