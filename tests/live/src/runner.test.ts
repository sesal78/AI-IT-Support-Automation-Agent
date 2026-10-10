import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRegistry,
  runLive,
  type LiveReport,
  type RunLiveOptions,
  type Scenario,
} from "./runner.ts";
import { markerEnv } from "./testing/env.ts";
import { startMockE2e } from "./testing/mock-e2e.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0)) await step();
  vi.restoreAllMocks();
});

async function harness() {
  const dir = join(mkdtempSync(join(tmpdir(), "live-runner-")), ".loop-evidence");
  cleanup.push(() => rmSync(dirname(dir), { recursive: true, force: true }));
  const values = markerEnv("http://127.0.0.1:1");
  const mock = await startMockE2e({
    token: values.INTERNAL_API_TOKEN,
    accessClientId: values.CF_ACCESS_CLIENT_ID,
    accessClientSecret: values.CF_ACCESS_CLIENT_SECRET,
  });
  cleanup.push(() => mock.close());
  const env = { ...values, E2E_BASE_URL: mock.origin };
  const stdout: string[] = [];
  const stderr: string[] = [];
  const run = (scenarios: Scenario[], extra: Partial<RunLiveOptions> = {}) =>
    runLive({
      argv: [],
      env,
      scenarios,
      evidenceDir: dir,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      ...extra,
    });
  const reports = (): LiveReport[] => {
    const live = join(dir, "live");
    if (!existsSync(live)) return [];
    return readdirSync(live)
      .filter((name) => name.endsWith(".json") && name !== "form-pacer.json")
      .map((name) => JSON.parse(readFileSync(join(live, name), "utf8")) as LiveReport);
  };
  return { dir, env, mock, stdout, stderr, run, reports };
}

const pass = (id: string, evidence = {}): Scenario => ({
  id,
  run: async () => ({ status: "pass", evidence }),
});
const failing = (id: string): Scenario => ({ id, run: async () => ({ status: "fail" }) });
const notRun = (id: string): Scenario => ({ id, run: async () => ({ status: "not_run" }) });

describe("runLive", () => {
  it("exits 0 when every selected scenario passes and writes the report", async () => {
    const h = await harness();
    const code = await h.run([pass("T3.S.03", { status: 200, paths: ["/api/health"] })], {
      runId: "run-1",
    });
    expect(code).toBe(0);
    const report = JSON.parse(
      readFileSync(join(h.dir, "live", "run-1.json"), "utf8"),
    ) as LiveReport;
    expect(report.runId).toBe("run-1");
    expect(new Date(report.startedAt).toISOString()).toBe(report.startedAt);
    expect(report.host).toBe(new URL(h.mock.origin).host);
    expect(report.scenarios).toEqual([
      {
        id: "T3.S.03",
        status: "pass",
        ms: expect.any(Number),
        evidence: { status: 200, paths: ["/api/health"] },
      },
    ]);
    expect(h.stdout.at(-1)).toBe(`report: ${join(".loop-evidence", "live", "run-1.json")}`);
  });

  it("exits 1 when one fails and 2 when one could not run; a fail outranks not run", async () => {
    const h = await harness();
    expect(await h.run([pass("A"), failing("B")])).toBe(1);
    expect(await h.run([pass("A"), notRun("C")])).toBe(2);
    expect(await h.run([notRun("C"), failing("B")])).toBe(1);
    expect(await h.run([])).toBe(0);
  });

  it("reports a scenario that throws as fail with the error class name only", async () => {
    const h = await harness();
    class SchemaDrift extends Error {}
    const code = await h.run([
      {
        id: "T1",
        run: async () => {
          throw new SchemaDrift(`leak ${h.env.INTERNAL_API_TOKEN}`);
        },
      },
      {
        id: "T2",
        run: async () => {
          throw "a string";
        },
      },
    ]);
    expect(code).toBe(1);
    const [report] = h.reports();
    expect(report!.scenarios.map((s) => [s.id, s.status, s.error])).toEqual([
      ["T1", "fail", "SchemaDrift"],
      ["T2", "fail", "String"],
    ]);
    expect(h.stdout[0]).toMatch(/^T1 fail \d+ms SchemaDrift$/);
  });

  it("runs only the --only IDs, in the given order", async () => {
    const h = await harness();
    const ran: string[] = [];
    const track = (id: string): Scenario => ({
      id,
      run: async () => (ran.push(id), { status: "pass" }),
    });
    const all = [track("A"), track("B"), track("C")];
    expect(await h.run(all, { argv: ["--only", "C,A"] })).toBe(0);
    expect(await h.run(all, { argv: ["--only=B"] })).toBe(0);
    expect(await h.run(all, { argv: ["--", "--only", "A", "--only", "B"] })).toBe(0);
    expect(ran).toEqual(["C", "A", "B", "A", "B"]);
  });

  it("fails on unknown --only IDs and lists the known IDs", async () => {
    const h = await harness();
    const code = await h.run([pass("T3.S.02"), pass("T3.S.03")], {
      argv: ["--only", "T3.S.02,T9.X"],
    });
    expect(code).toBe(2);
    expect(h.stderr).toEqual(["live: unknown test IDs: T9.X. Known: T3.S.02, T3.S.03"]);
    expect(h.reports()).toEqual([]);
  });

  it("never echoes a malformed --only ID, and refuses bad arguments", async () => {
    const h = await harness();
    expect(await h.run([pass("A")], { argv: ["--only", `${h.env.CF_ACCESS_CLIENT_SECRET}`] })).toBe(
      2,
    );
    expect(h.stderr.at(-1)).toBe("live: unknown test IDs: (malformed). Known: A");
    expect(await h.run([pass("A")], { argv: ["--only"] })).toBe(2);
    expect(await h.run([pass("A")], { argv: ["--bogus"] })).toBe(2);
  });

  it("refuses duplicate and malformed scenario IDs", () => {
    expect(() => createRegistry([pass("A"), pass("A")])).toThrow("duplicate scenario ID A");
    expect(() => createRegistry([pass("a b")])).toThrow("malformed");
  });

  it("exits 2 with the variable name when the env is incomplete", async () => {
    const h = await harness();
    const code = await h.run([pass("A")], { env: { ...h.env, CF_ACCESS_CLIENT_ID: undefined } });
    expect(code).toBe(2);
    expect(h.stderr.join("\n")).toContain("CF_ACCESS_CLIENT_ID");
  });

  it.each(["../escape", "..", "a/b", "a\\b", "", "x".repeat(65)])(
    "refuses run ID %j so the report cannot leave .loop-evidence/live",
    async (runId) => {
      const h = await harness();
      expect(await h.run([pass("A")], { runId })).toBe(2);
      expect(h.stderr).toEqual(["live: run ID is malformed"]);
      expect(existsSync(join(h.dir, "escape.json"))).toBe(false);
    },
  );

  it("refuses evidence that is prose, nested or quotes a secret", async () => {
    const h = await harness();
    const bad = [
      { note: "a sentence with spaces" },
      { nested: { a: 1 } },
      { id: h.env.INTERNAL_API_TOKEN },
      { "bad key": 1 },
      { n: Number.NaN },
      { list: ["ok", "not ok"] },
    ];
    const code = await h.run(bad.map((evidence, i) => pass(`E${i}`, evidence)));
    expect(code).toBe(1);
    const [report] = h.reports();
    for (const entry of report!.scenarios) {
      expect(entry).toMatchObject({ status: "fail", evidence: {}, error: "EvidenceRefused" });
    }
  });
});
