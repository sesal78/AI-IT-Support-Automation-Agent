// Test support: runs live scenarios through runLive against the mock e2e app,
// a mock phase 5 flow and the fetch-level mock ServiceNow Table API, on a fake
// clock. The scenario reads incidents through the P5-T7 helper, which travels
// this fetch, so the rows the mock created are the rows the scenario sees.
// Never reaches a real host.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runLive, type LiveReport, type Scenario } from "../runner.ts";
import { scenarios } from "../scenarios.ts";
import { markerEnv, markerSlackEnv, markerServiceNowEnv, TEST_SLACK } from "./env.ts";
import { startMockE2e, type MockE2e } from "./mock-e2e.ts";
import { createMockHelpdesk, type MockHelpdesk, type MockHelpdeskFaults } from "./mock-helpdesk.ts";
import {
  fullInstance,
  mockServiceNow,
  SN_URL,
  type MockServiceNowOptions,
  type MockSnData,
} from "./mock-servicenow.ts";
import { createMockSlack, type MockSlack } from "./mock-slack.ts";

export interface HelpdeskHarnessOptions {
  readonly faults?: MockHelpdeskFaults;
  /** Failure paths of the Table API mock (a refused read or close). */
  readonly sn?: MockServiceNowOptions;
  /** Real delay of every e2e reply, so concurrency shows in the peak. */
  readonly delayMs?: number;
  /** False leaves the three ServiceNow variables unset (a `not_run` case). */
  readonly withServiceNow?: boolean;
}

export interface HelpdeskHarness {
  readonly e2e: MockE2e;
  readonly slack: MockSlack;
  readonly helpdesk: MockHelpdesk;
  readonly data: MockSnData;
  /** The fake clock at the run's start (before any scenario). */
  readonly startedAt: number;
  readonly dir: string;
  readonly stdout: string[];
  readonly stderr: string[];
  readonly now: () => number;
  run(
    argv: string[],
    list?: readonly Scenario[],
    runId?: string,
  ): Promise<{ code: number; report: LiveReport; text: string }>;
  /** Only the exit code (no report is written when the run cannot start). */
  exitCode(argv: string[], list?: readonly Scenario[], runId?: string): Promise<number>;
  /** e2e requests to one method and path. */
  count(method: string, path: string): number;
  /** Methods of the Table API requests, in order (the helper's writes are PATCH). */
  serviceNowMethods(): string[];
  /** Table API requests whose encoded query starts with `prefix`. */
  serviceNowQueries(prefix: string): number;
  close(): Promise<void>;
}

export async function startHelpdeskHarness(
  options: HelpdeskHarnessOptions = {},
): Promise<HelpdeskHarness> {
  const dir = join(mkdtempSync(join(tmpdir(), "live-helpdesk-")), ".loop-evidence");
  let clock = Date.parse("2026-11-13T00:00:00.000Z");
  const startedAt = clock;
  const now = () => clock;
  const sleep = async (ms: number) => {
    clock += ms;
  };
  const values = markerEnv("http://127.0.0.1:1");
  const slackVars = markerSlackEnv();
  const snVars = markerServiceNowEnv();
  const data = fullInstance();
  const serviceNow = mockServiceNow(data, { now, ...options.sn });
  const slack = createMockSlack({
    token: slackVars.E2E_SLACK_BOT_TOKEN,
    botUserId: TEST_SLACK.botUserId,
    channel: { id: TEST_SLACK.channelId, name: "itsupport-e2e", is_general: false },
    fallback: (input, init) => fetch(input, init),
  });
  const helpdesk = createMockHelpdesk({
    now,
    data,
    ...(options.faults === undefined ? {} : { faults: options.faults }),
  });
  const e2e = await startMockE2e({
    token: values.INTERNAL_API_TOKEN,
    accessClientId: values.CF_ACCESS_CLIENT_ID,
    accessClientSecret: values.CF_ACCESS_CLIENT_SECRET,
    slackSigningSecret: slackVars.E2E_SLACK_SIGNING_SECRET,
    now,
    delayMs: options.delayMs,
    override: helpdesk.override,
  });
  const env = {
    ...values,
    ...slackVars,
    ...(options.withServiceNow === false ? {} : snVars),
    E2E_BASE_URL: e2e.origin,
  };
  const routed = (input: URL, init: RequestInit) =>
    new URL(input).origin === SN_URL ? serviceNow.fetch(input, init) : slack.fetch(input, init);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = (
    argv: string[],
    list: readonly Scenario[] = scenarios,
    runId = "run-mock-helpdesk",
  ) =>
    runLive({
      argv,
      env,
      scenarios: list,
      evidenceDir: dir,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      fetch: routed,
      now,
      sleep,
      runId,
    });
  return {
    e2e,
    slack,
    helpdesk,
    data,
    startedAt,
    dir,
    stdout,
    stderr,
    now,
    exitCode,
    async run(argv, list = scenarios, runId = "run-mock-helpdesk") {
      const code = await exitCode(argv, list, runId);
      const text = readFileSync(join(dir, "live", `${runId}.json`), "utf8");
      return { code, report: JSON.parse(text) as LiveReport, text };
    },
    count: (method, path) =>
      e2e.requests.filter((r) => r.method === method && r.path === path).length,
    serviceNowMethods: () => serviceNow.requests.map((r) => r.method),
    serviceNowQueries: (prefix) =>
      serviceNow.requests.filter((r) =>
        (r.url.searchParams.get("sysparm_query") ?? "").startsWith(prefix),
      ).length,
    async close() {
      await e2e.close();
      rmSync(dirname(dir), { recursive: true, force: true });
    },
  };
}
