// Runner selection (heavy, --phase) and T4.S.06 through runLive, against the mocks only.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRegistry,
  runLive,
  selectScenarios,
  type LiveReport,
  type Scenario,
} from "./runner.ts";
import { scenarios } from "./scenarios.ts";
import { PROBE_CHANNEL } from "./slack-scenarios.ts";
import { createSlackSigner } from "./slack-signer.ts";
import { markerEnv, markerSlackEnv, TEST_SLACK } from "./testing/env.ts";
import { startMockE2e } from "./testing/mock-e2e.ts";
import { createMockSlack, type MockSlackOptions } from "./testing/mock-slack.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0)) await step();
  vi.restoreAllMocks();
});

const scenario = (id: string, heavy?: boolean): Scenario => ({
  id,
  ...(heavy === undefined ? {} : { heavy }),
  run: async () => ({ status: "pass" }),
});

// A fixture registry: T4.L.05 is not built yet (P4-T8d), so a heavy stand-in is used here.
const fixture = createRegistry([
  scenario("T3.S.02"),
  scenario("T3.L.02"),
  scenario("T4.S.06"),
  scenario("T4.S.01"),
  scenario("T4.L.05", true),
  scenario("T4.F.01", true),
  scenario("T40.X.01"),
]);
const ids = (argv: string[]) => selectScenarios(fixture, argv).map((s) => s.id);

describe("selectScenarios", () => {
  it("the default run leaves heavy scenarios out", () => {
    expect(ids([])).toEqual(["T3.S.02", "T3.L.02", "T4.S.06", "T4.S.01", "T40.X.01"]);
  });

  it("--phase 4 gives only the non-heavy T4.* scenarios", () => {
    expect(ids(["--phase", "4"])).toEqual(["T4.S.06", "T4.S.01"]);
    expect(ids(["--phase=3"])).toEqual(["T3.S.02", "T3.L.02"]);
  });

  it("--only selects heavy scenarios, in the given order", () => {
    expect(ids(["--only", "T4.L.05"])).toEqual(["T4.L.05"]);
    expect(ids(["--only", "T4.F.01,T3.S.02"])).toEqual(["T4.F.01", "T3.S.02"]);
  });

  it.each([
    [["--phase"]],
    [["--phase", "x"]],
    [["--phase", "0"]],
    [["--phase", "4.1"]],
    [["--phase", "4", "--phase", "3"]],
    [["--phase", "4", "--only", "T4.S.06"]],
    [["--phase", "9"]],
  ])("refuses %j", (argv) => {
    expect(() => selectScenarios(fixture, argv)).toThrow();
  });

  it("the real registry has T4.S.06, not heavy, and nothing heavy by default", () => {
    const real = createRegistry(scenarios);
    expect(real.get("T4.S.06")?.heavy).toBeUndefined();
    expect(selectScenarios(real, ["--phase", "4"]).map((s) => s.id)).toEqual(["T4.S.06"]);
    // Existing selection is unchanged: no scenario was heavy before phase 4.
    expect(selectScenarios(real, []).map((s) => s.id)).toEqual(scenarios.map((s) => s.id));
  });
});

async function harness(slack: Partial<MockSlackOptions> = {}, slackVars = markerSlackEnv()) {
  const dir = join(mkdtempSync(join(tmpdir(), "live-slack-")), ".loop-evidence");
  cleanup.push(() => rmSync(dirname(dir), { recursive: true, force: true }));
  const values = markerEnv("http://127.0.0.1:1");
  const full = markerSlackEnv();
  const e2e = await startMockE2e({
    token: values.INTERNAL_API_TOKEN,
    accessClientId: values.CF_ACCESS_CLIENT_ID,
    accessClientSecret: values.CF_ACCESS_CLIENT_SECRET,
    slackSigningSecret: full.E2E_SLACK_SIGNING_SECRET,
  });
  cleanup.push(() => e2e.close());
  const mock = createMockSlack({
    token: full.E2E_SLACK_BOT_TOKEN,
    botUserId: TEST_SLACK.botUserId,
    channel: { id: TEST_SLACK.channelId, name: "itsupport-e2e", is_general: false },
    fallback: (input, init) => fetch(input, init),
    ...slack,
  });
  const env = { ...values, ...slackVars, E2E_BASE_URL: e2e.origin, STAGING_BASE_URL: undefined };
  const stdout: string[] = [];
  const stderr: string[] = [];
  const run = async (argv: string[], list: readonly Scenario[] = scenarios) => {
    const code = await runLive({
      argv,
      env,
      scenarios: list,
      evidenceDir: dir,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      fetch: mock.fetch,
    });
    const live = join(dir, "live");
    const texts = readdirSync(live)
      .filter((name) => name !== "form-pacer.json")
      .map((name) => readFileSync(join(live, name), "utf8"));
    const report = JSON.parse(texts.at(-1)!) as LiveReport;
    return { code, report, texts };
  };
  return { e2e, mock, env, stdout, stderr, run, full };
}

describe("T4.S.06", () => {
  it("passes against the mock: every probe refused, no request for the probe channel", async () => {
    const h = await harness();
    const { code, report } = await h.run(["--phase", "4"]);
    expect(code).toBe(0);
    expect(report.scenarios).toEqual([
      {
        id: "T4.S.06",
        status: "pass",
        ms: expect.any(Number),
        evidence: { attempts: 16, refused: 16, probeRequests: 0, aiCallCount: 0 },
      },
    ]);
    expect(h.mock.methods()).toEqual(["auth.test", "conversations.info"]);
    expect(h.mock.requests.filter((r) => r.params.channel === PROBE_CHANNEL)).toEqual([]);
    expect(h.e2e.requests).toEqual([]);
  });

  it.each([
    ["general", { name: "general", is_general: true }],
    ["the staging channel name", { name: "ai-it-support-automation-agent", is_general: false }],
  ])("fails when conversations.info returns %s, calling no other method", async (_c, channel) => {
    const h = await harness({ channel: { id: TEST_SLACK.channelId, ...channel } });
    const { code, report } = await h.run(["--only", "T4.S.06"]);
    expect(code).toBe(1);
    expect(report.scenarios[0]).toMatchObject({ status: "fail", error: "SlackChannelGuardError" });
    expect(h.mock.methods()).toEqual(["auth.test", "conversations.info"]);
  });

  it("is not_run (exit 2) with all four names unset, naming the missing ones", async () => {
    const h = await harness({}, {} as ReturnType<typeof markerSlackEnv>);
    const { code, report } = await h.run(["--only", "T4.S.06"]);
    expect(code).toBe(2);
    expect(report.scenarios[0]).toMatchObject({
      status: "not_run",
      evidence: { missing: ["E2E_SLACK_BOT_TOKEN", "E2E_SLACK_CHANNEL_ID"] },
    });
    expect(h.mock.requests).toEqual([]);
  });

  it("is not_run with a partial set, naming only the missing name", async () => {
    const { E2E_SLACK_CHANNEL_ID } = markerSlackEnv();
    const h = await harness({}, { E2E_SLACK_CHANNEL_ID } as ReturnType<typeof markerSlackEnv>);
    const { code, report } = await h.run(["--only", "T4.S.06"]);
    expect(code).toBe(2);
    expect(report.scenarios[0]!.evidence).toEqual({ missing: ["E2E_SLACK_BOT_TOKEN"] });
    expect(h.mock.requests).toEqual([]);
  });

  it("exits 2 naming the variable when a Slack value is malformed", async () => {
    const h = await harness({}, {
      ...markerSlackEnv(),
      E2E_SLACK_REVIEWER_ID: "bad",
    } as unknown as ReturnType<typeof markerSlackEnv>);
    const { stderr } = h;
    const code = await runLive({
      argv: ["--only", "T4.S.06"],
      env: h.env,
      scenarios,
      evidenceDir: join(tmpdir(), "unused-live-slack"),
      stdout: () => {},
      stderr: (line) => stderr.push(line),
      fetch: h.mock.fetch,
    });
    expect(code).toBe(2);
    expect(stderr.join("\n")).toContain("E2E_SLACK_REVIEWER_ID");
  });
});

describe("Slack marker run", () => {
  it("leaves the token and signing secret out of stdout, stderr and the report", async () => {
    const h = await harness({
      // Every Slack answer after the guard echoes the token back.
      override: (r) =>
        r.method === "auth.test" || r.method === "conversations.info"
          ? undefined
          : { ok: false, error: h.full.E2E_SLACK_BOT_TOKEN },
    });
    const stray: string[] = [];
    for (const stream of [process.stdout, process.stderr]) {
      vi.spyOn(stream, "write").mockImplementation((chunk: string | Uint8Array) => {
        stray.push(String(chunk));
        return true;
      });
    }
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        stray.push(args.map(String).join(" "));
      });
    }
    const leaky: Scenario[] = [
      {
        id: "T4.X.leak-slack",
        run: async (ctx) => {
          // Uses the signer and then throws with the secrets in the message.
          const signer = createSlackSigner(ctx.config, { client: ctx.client });
          const signed = signer.signedDecision({
            reviewId: "00000000-0000-4000-8000-000000000000",
            slackTs: "1700000001.000001",
            decision: "approve",
          });
          await signer.send(signed);
          throw new Error(`${ctx.config.slack.botToken} ${ctx.config.slack.signingSecret}`);
        },
      },
      {
        id: "T4.X.evidence",
        run: async (ctx) => ({ status: "pass", evidence: { t: ctx.config.slack.signingSecret! } }),
      },
    ];
    const { texts } = await h.run(["--only", "T4.S.06"], scenarios);
    const second = await h.run([], leaky);
    expect(second.code).toBe(1);
    const all = [...texts, ...second.texts, ...h.stdout, ...h.stderr, ...stray].join("\n");
    for (const marker of [
      h.full.E2E_SLACK_BOT_TOKEN,
      h.full.E2E_SLACK_SIGNING_SECRET,
      "MarkerSlackToken",
      "MarkerSigningSecret",
    ]) {
      expect(all).not.toContain(marker);
    }
    expect(second.report.scenarios.map((s) => s.error)).toEqual(["Error", "EvidenceRefused"]);
    expect(h.e2e.interactions).toHaveLength(1);
  });
});
