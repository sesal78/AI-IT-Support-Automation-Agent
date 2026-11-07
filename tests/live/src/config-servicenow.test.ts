import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadLiveConfig, missingServiceNowEnv } from "./config.ts";
import { runLive, type Scenario } from "./runner.ts";
import { markerEnv } from "./testing/env.ts";
import { startMockE2e } from "./testing/mock-e2e.ts";
import { SN_PASSWORD, SN_URL, SN_USER } from "./testing/mock-servicenow.ts";

const snEnv = {
  E2E_SERVICENOW_INSTANCE_URL: SN_URL,
  E2E_SERVICENOW_USERNAME: SN_USER,
  E2E_SERVICENOW_PASSWORD: SN_PASSWORD,
};
const base = markerEnv("https://e2e.example.com");

describe("loadLiveConfig ServiceNow variables", () => {
  it("reads the three variables and lists the secrets for leak checks", () => {
    const config = loadLiveConfig({ ...base, ...snEnv });
    expect(config.servicenow).toEqual({
      instanceUrl: SN_URL,
      username: SN_USER,
      password: SN_PASSWORD,
    });
    expect(config.secrets).toContain(SN_PASSWORD);
    expect(missingServiceNowEnv(config)).toEqual([]);
  });

  it("with the names unset the config loads and every name is missing", () => {
    const config = loadLiveConfig(base);
    expect(config.servicenow.password).toBeUndefined();
    expect(missingServiceNowEnv(config)).toEqual([
      "E2E_SERVICENOW_INSTANCE_URL",
      "E2E_SERVICENOW_USERNAME",
      "E2E_SERVICENOW_PASSWORD",
    ]);
  });

  it("a bad URL fails, naming the variable and not quoting the value", () => {
    const bad = "https://other.service-now.com";
    expect(() => loadLiveConfig({ ...base, ...snEnv, E2E_SERVICENOW_INSTANCE_URL: bad })).toThrow(
      /E2E_SERVICENOW_INSTANCE_URL/,
    );
    try {
      loadLiveConfig({ ...base, ...snEnv, E2E_SERVICENOW_INSTANCE_URL: bad });
    } catch (error) {
      expect((error as Error).message).not.toContain("other.service-now");
    }
  });
});

describe("a scenario that needs the ServiceNow variables", () => {
  const needsServiceNow: Scenario = {
    id: "T5.X.00",
    async run(ctx) {
      const missing = missingServiceNowEnv(ctx.config);
      return missing.length > 0 ? { status: "not_run", evidence: { missing } } : { status: "pass" };
    },
  };

  async function exitCode(env: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), "live-sn-"));
    const values = markerEnv("http://127.0.0.1:1");
    const mock = await startMockE2e({
      token: values.INTERNAL_API_TOKEN,
      accessClientId: values.CF_ACCESS_CLIENT_ID,
      accessClientSecret: values.CF_ACCESS_CLIENT_SECRET,
    });
    const out: string[] = [];
    const err: string[] = [];
    try {
      const code = await runLive({
        argv: [],
        env: { ...values, E2E_BASE_URL: mock.origin, ...env },
        scenarios: [needsServiceNow],
        evidenceDir: join(dir, ".loop-evidence"),
        stdout: (l) => out.push(l),
        stderr: (l) => err.push(l),
      });
      return { code, text: [...out, ...err].join("\n") };
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("is not_run (exit code 2) with the names unset", async () => {
    const { code, text } = await exitCode({});
    expect(code).toBe(2);
    expect(text).toContain("T5.X.00 not_run");
  });

  it("passes (exit code 0) with the names set, and no output holds the password marker", async () => {
    const { code, text } = await exitCode(snEnv);
    expect(code).toBe(0);
    expect(text).not.toContain(SN_PASSWORD);
  });
});
