// Test support: runs live scenarios through runLive against the mock e2e app,
// the mock review flow, the mock Slack API, the mock judge and a mock staging
// app, on a fake clock. Never reaches a real host.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runLive, type LiveReport, type Scenario } from "../runner.ts";
import { scenarios } from "../scenarios.ts";
import { markerEnv, markerSlackEnv, TEST_SLACK } from "./env.ts";
import { startMockE2e, type MockE2e } from "./mock-e2e.ts";
import { mockJudgments, type MockJudgment } from "./mock-judgments.ts";
import { createMockReview, type MockReview, type MockReviewFaults } from "./mock-review.ts";
import { createMockSlack, type MockSlack } from "./mock-slack.ts";

/** The staging origin the scenarios see; requests to it go to the staging mock. */
export const STAGING = "https://staging-mock.example";

export interface ReviewHarnessOptions {
  readonly faults?: MockReviewFaults;
  /** The nth judgment's outcome (default 0.9). */
  readonly judge?: (n: number) => MockJudgment;
  /** Status the staging mock answers (default 401); null leaves STAGING_BASE_URL unset. */
  readonly stagingStatus?: number | null;
  /** Real delay of every e2e reply, so concurrency shows in the peaks. */
  readonly delayMs?: number;
  /** Replaces the four Slack variables. */
  readonly slackEnv?: Record<string, string>;
}

export interface ReviewHarness {
  readonly e2e: MockE2e;
  readonly staging: MockE2e;
  readonly slack: MockSlack;
  readonly review: MockReview;
  readonly judgeBodies: unknown[];
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
  close(): Promise<void>;
}

export async function startReviewHarness(
  options: ReviewHarnessOptions = {},
): Promise<ReviewHarness> {
  const dir = join(mkdtempSync(join(tmpdir(), "live-review-")), ".loop-evidence");
  let clock = Date.parse("2026-11-05T00:00:00.000Z");
  const now = () => clock;
  const sleep = async (ms: number) => {
    clock += ms;
  };
  const values = markerEnv("http://127.0.0.1:1");
  const slackVars = markerSlackEnv();
  const staging = await startMockE2e({
    token: values.INTERNAL_API_TOKEN,
    accessClientId: values.CF_ACCESS_CLIENT_ID,
    accessClientSecret: values.CF_ACCESS_CLIENT_SECRET,
    override: () => ({ status: options.stagingStatus ?? 401, json: { error: "unauthorized" } }),
  });
  // The pipeline moves on its own: every Slack read first moves the mock review flow on.
  let tick = () => {};
  const slack = createMockSlack({
    override: () => {
      tick();
      return undefined;
    },
    token: slackVars.E2E_SLACK_BOT_TOKEN,
    botUserId: TEST_SLACK.botUserId,
    channel: { id: TEST_SLACK.channelId, name: "itsupport-e2e", is_general: false },
    fallback: (input, init) => {
      const url = new URL(input);
      return url.origin === STAGING
        ? fetch(new URL(`${url.pathname}${url.search}`, staging.origin), init)
        : fetch(input, init);
    },
  });
  const review = createMockReview({
    now,
    slack,
    channelId: TEST_SLACK.channelId,
    botUserId: TEST_SLACK.botUserId,
    reviewerIds: [TEST_SLACK.reviewerId],
    faults: options.faults,
  });
  tick = review.tick;
  const judgments = mockJudgments((n) => options.judge?.(n) ?? 0.9);
  const e2e = await startMockE2e({
    token: values.INTERNAL_API_TOKEN,
    accessClientId: values.CF_ACCESS_CLIENT_ID,
    accessClientSecret: values.CF_ACCESS_CLIENT_SECRET,
    slackSigningSecret: slackVars.E2E_SLACK_SIGNING_SECRET,
    now,
    delayMs: options.delayMs,
    override: (request) => judgments.override(request) ?? review.override(request),
  });
  const env = {
    ...values,
    ...(options.slackEnv ?? slackVars),
    E2E_BASE_URL: e2e.origin,
    STAGING_BASE_URL: options.stagingStatus === null ? undefined : STAGING,
  };
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = (
    argv: string[],
    list: readonly Scenario[] = scenarios,
    runId = "run-mock-0001",
  ) =>
    runLive({
      argv,
      env,
      scenarios: list,
      evidenceDir: dir,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      fetch: slack.fetch,
      now,
      sleep,
      runId,
    });
  return {
    e2e,
    staging,
    slack,
    review,
    judgeBodies: judgments.bodies,
    dir,
    stdout,
    stderr,
    now,
    exitCode,
    async run(argv, list = scenarios, runId = "run-mock-0001") {
      const code = await exitCode(argv, list, runId);
      const text = readFileSync(join(dir, "live", `${runId}.json`), "utf8");
      return { code, report: JSON.parse(text) as LiveReport, text };
    },
    count: (method, path) =>
      e2e.requests.filter((r) => r.method === method && r.path === path).length,
    async close() {
      await e2e.close();
      await staging.close();
      rmSync(dirname(dir), { recursive: true, force: true });
    },
  };
}

/** The live folder's files (for leak checks). */
export const liveFiles = (dir: string): string[] =>
  readdirSync(join(dir, "live")).map((name) => readFileSync(join(dir, "live", name), "utf8"));
