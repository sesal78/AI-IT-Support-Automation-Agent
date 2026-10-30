import { randomUUID } from "node:crypto";
import { logger } from "@trigger.dev/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runHealthcheck, type HealthcheckResult } from "./healthcheck.js";

// Keeps the real SDK, and captures the run function the task registers so a
// test can call it the way the Trigger.dev runtime does: (payload, run params).
const registered = vi.hoisted(() => ({ run: undefined as unknown }));
vi.mock("@trigger.dev/sdk", async (importOriginal) => {
  const sdk = await importOriginal<typeof import("@trigger.dev/sdk")>();
  const schemaTask: typeof sdk.schemaTask = (params) => {
    registered.run = params.run;
    return sdk.schemaTask(params);
  };
  return { ...sdk, schemaTask };
});

// The spec's feature → env names table (P3-T14b), restated here on purpose:
// a name dropped from or added to the source map fails a test.
const FEATURES = {
  supabase: ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_DB_SCHEMA"],
  typesafe: ["TYPESAFE_API_KEY"],
  llm: ["LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL"],
  langfuse: ["LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_BASE_URL"],
  caps: ["LLM_MONTHLY_CALL_CAP", "TYPESAFE_MONTHLY_CALL_CAP"],
  slack: ["SLACK_BOT_TOKEN", "SLACK_CHANNEL_ID"],
} as const;

const ALL_NAMES = Object.values(FEATURES).flat();
const allTrue = {
  supabase: true,
  typesafe: true,
  llm: true,
  langfuse: true,
  caps: true,
  slack: true,
};
const allFalse = {
  supabase: false,
  typesafe: false,
  llm: false,
  langfuse: false,
  caps: false,
  slack: false,
};

/** Every listed name set to a harmless value. */
function fullEnv(): Record<string, string | undefined> {
  return Object.fromEntries(ALL_NAMES.map((name) => [name, "set"]));
}

const featureOf = (name: string) =>
  Object.entries(FEATURES).find(([, names]) => (names as readonly string[]).includes(name))![0];

const configuredFor = async (env: Record<string, string | undefined>) =>
  (await runHealthcheck({ requestedBy: "ci" }, env)).configured;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// No failure-path test for the env record: every record is valid input. A
// missing or blank name is reported as `false`, which is the point of the
// task. The payload's failure path is covered in healthcheck.test.ts.
describe("healthcheck configured map", () => {
  it("lists 14 env names", () => {
    expect(new Set(ALL_NAMES).size).toBe(14);
  });

  it("reports every feature true when all 14 names are set", async () => {
    expect(await configuredFor(fullEnv())).toEqual({ ...allTrue, e2eMode: false });
  });

  it("reports every feature false for an empty env", async () => {
    expect(await configuredFor({})).toEqual({ ...allFalse, e2eMode: false });
  });

  it("keeps ok, requestedBy and an ISO timestamp next to configured", async () => {
    const result = await runHealthcheck({ requestedBy: "ci" }, fullEnv());
    expect(result).toEqual({
      ok: true,
      requestedBy: "ci",
      at: expect.any(String),
      configured: { ...allTrue, e2eMode: false },
    });
    expect(new Date(result.at).toISOString()).toBe(result.at);
  });

  it("has exactly the seven keys, each a boolean, whatever the env holds", async () => {
    for (const env of [{}, fullEnv(), { ...fullEnv(), E2E_MODE: "true" }]) {
      const configured = await configuredFor(env);
      expect(Object.keys(configured).sort()).toEqual(
        ["caps", "e2eMode", "langfuse", "llm", "slack", "supabase", "typesafe"].sort(),
      );
      for (const value of Object.values(configured)) expect(typeof value).toBe("boolean");
    }
  });

  it("reads process.env, not the run params, when the runtime calls the registered task", async () => {
    for (const name of ALL_NAMES) vi.stubEnv(name, "set");
    vi.stubEnv("E2E_MODE", "true");
    const run = registered.run as (payload: unknown, params: unknown) => Promise<HealthcheckResult>;
    const result = await run({ requestedBy: "api" }, { ctx: {}, E2E_MODE: "false" });
    expect(result.requestedBy).toBe("api");
    expect(result.configured).toEqual({ ...allTrue, e2eMode: true });
  });

  describe.each(ALL_NAMES)("without %s", (name) => {
    const unsetWays: Array<[string, (env: Record<string, string | undefined>) => void]> = [
      ["absent", (env) => delete env[name]],
      ["undefined", (env) => (env[name] = undefined)],
      ["an empty string", (env) => (env[name] = "")],
      ["spaces only", (env) => (env[name] = "   ")],
    ];

    it.each(unsetWays)("turns only its own feature false when it is %s", async (_way, unset) => {
      const env = fullEnv();
      unset(env);
      expect(await configuredFor(env)).toEqual({
        ...allTrue,
        [featureOf(name)]: false,
        e2eMode: false,
      });
    });
  });

  describe("e2eMode", () => {
    it("is true for E2E_MODE=true", async () => {
      expect((await configuredFor({ E2E_MODE: "true" })).e2eMode).toBe(true);
    });

    it.each(["TRUE", "True", "1", "yes", "", " true "])(
      "is false for E2E_MODE=%j",
      async (value) => {
        expect((await configuredFor({ E2E_MODE: value })).e2eMode).toBe(false);
      },
    );

    it("is false when E2E_MODE is unset", async () => {
      expect((await configuredFor(fullEnv())).e2eMode).toBe(false);
    });

    it("does not change any feature", async () => {
      expect(await configuredFor({ E2E_MODE: "true" })).toEqual({ ...allFalse, e2eMode: true });
    });
  });

  it("never puts an env value, its length or a prefix of it in the result or a log line", async () => {
    // One unique marker per name, each with its own unmistakable length (4001, 4002, …).
    const markers = Object.fromEntries(
      [...ALL_NAMES, "E2E_MODE"].map((name, i) => [name, randomUUID().padEnd(4001 + i, "x")]),
    );
    const levels = ["debug", "log", "info", "warn", "error"] as const;
    const spies = [
      ...levels.map((level) => vi.spyOn(logger, level).mockImplementation(() => {})),
      ...levels.map((level) => vi.spyOn(console, level).mockImplementation(() => {})),
    ];

    const result = await runHealthcheck({ requestedBy: "ci" }, markers);

    expect(result.configured).toEqual({ ...allTrue, e2eMode: false });
    const output = JSON.stringify(result);
    const calls = spies.flatMap((spy) => spy.mock.calls);
    expect(calls.length).toBeGreaterThan(0);
    const logged = JSON.stringify(calls);
    for (const marker of Object.values(markers)) {
      for (const leak of [marker, marker.slice(0, 8), String(marker.length)]) {
        expect(output).not.toContain(leak);
        expect(logged).not.toContain(leak);
      }
    }
  });
});
