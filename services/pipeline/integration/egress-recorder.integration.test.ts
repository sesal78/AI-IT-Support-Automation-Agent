import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildCanaries } from "../../../packages/shared/src/canaries.js";
import { egress } from "../test-support/egress.js";

// Bound at module scope, as an SDK client does at construction. The recorder
// must already be running when this line executes.
const earlyFetch = globalThis.fetch;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("pipeline integration setup (T3.S.01)", () => {
  it("has the recorder running: a mocked call is recorded, a clean one passes", async () => {
    egress.mock("https://api.typesafe.ai");
    await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      body: "[REDACTED_EMAIL]",
    });
    expect(egress.requests()).toHaveLength(1);
    expect(() => egress.assertClean()).not.toThrow();
  });

  it("makes assertClean throw for a leaking request", async () => {
    egress.mock("https://api.typesafe.ai");
    const email = buildCanaries(egress.runId).find((entry) => entry.type === "email")?.value ?? "";
    await fetch("https://api.typesafe.ai/v1/systemone", { method: "POST", body: email });
    expect(() => egress.assertClean()).toThrow(/api\.typesafe\.ai[\s\S]*email/);
    egress.reset(); // this test leaked on purpose; keep the after-each check green
  });

  it("fails a leaking test through the setup file, and only that test", () => {
    const vitest = join(
      dirname(createRequire(import.meta.url).resolve("vitest/package.json")),
      "vitest.mjs",
    );
    const run = spawnSync(
      process.execPath,
      [vitest, "run", "--config", "test-support/selftest.vitest.config.ts"],
      { cwd: root, encoding: "utf8", timeout: 120_000 },
    );
    const output = `${run.stdout}\n${run.stderr}`;
    expect(run.status).not.toBe(0);
    expect(output).toMatch(/1 failed \| 1 passed/);
    expect(output).toContain("leaks an email canary");
    expect(output).toContain("POST api.typesafe.ai: body: email");
  });

  it("records a request made with a fetch captured at module scope", async () => {
    egress.mock("https://api.typesafe.ai");
    const email = buildCanaries(egress.runId).find((entry) => entry.type === "email")?.value ?? "";
    await earlyFetch("https://api.typesafe.ai/v1/systemone", { method: "POST", body: email });
    expect(egress.requests()).toHaveLength(1);
    expect(() => egress.assertClean()).toThrow(/email/);
    egress.reset();
  });

  it("does not echo a canary placed in the host name of an un-mocked request", async () => {
    const key = buildCanaries(egress.runId).find((entry) => entry.type === "api_key")?.value ?? "";
    const label = key.toLowerCase();
    const host = `${label}.invalid`;
    const res = await earlyFetch(`https://${host}/x`);
    const text = await res.text();
    expect(text).toContain("host:<redacted>");
    expect(text).not.toContain(label);
    let message = "";
    try {
      egress.assertClean();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("host:<redacted>");
    expect(message).not.toContain(label);
    egress.reset();
  });
});
