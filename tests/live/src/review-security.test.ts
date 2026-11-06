// T4.S.01 to T4.S.04 (P4-T8c) through runLive, against the mocks only.
import { afterEach, describe, expect, it } from "vitest";
import { fuzzRequests, MARKUP, S03_ALLOWED, seededRandom } from "./review-security.ts";
import type { ScenarioContext } from "./runner.ts";
import { markerSlackEnv, TEST_SLACK } from "./testing/env.ts";
import type { MockCard } from "./testing/mock-review.ts";
import {
  startReviewHarness,
  type ReviewHarness,
  type ReviewHarnessOptions,
} from "./testing/review-harness.ts";

const harnesses: ReviewHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});
async function harness(options: ReviewHarnessOptions = {}) {
  const h = await startReviewHarness(options);
  harnesses.push(h);
  return h;
}

const RUN_ID = "run-mock-0001";
const INTERACTIVITY = "POST /api/slack/interactivity";
const evidenceOf = (
  report: { scenarios: readonly { evidence: Record<string, unknown> }[] },
  i = 0,
) => report.scenarios[i]!.evidence;

describe("security scenarios against the mocks", () => {
  it("T4.S.01 to T4.S.03 pass, creating 3 tickets, with codes, counts and IDs as evidence", async () => {
    const h = await harness({ delayMs: 5 });
    const { code, report, text } = await h.run(["--only", "T4.S.01,T4.S.02,T4.S.03"]);
    expect(report.scenarios.map((s) => [s.id, s.status])).toEqual([
      ["T4.S.01", "pass"],
      ["T4.S.02", "pass"],
      ["T4.S.03", "pass"],
    ]);
    expect(code).toBe(0);
    expect(h.count("POST", "/api/internal/test-tickets")).toBe(3);
    expect([...h.review.tickets.keys()]).toEqual([
      `${RUN_ID}:S01:1`,
      `${RUN_ID}:S01:2`,
      `${RUN_ID}:S02:1`,
    ]);
    expect(evidenceOf(report, 0)).toMatchObject({
      forgedStatus: 401,
      staleStatus: 401,
      notAllowedStatus: 403,
      bindingStatus: 403,
      replayStatus: 200,
      replayOutcome: "already_decided",
      bDecidedEvents: 1,
      eventKinds: ["bad_signature", "binding_mismatch", "not_allow_listed", "stale_timestamp"],
    });
    // A was approved at the end, so it does not wait for the timeout.
    expect(h.review.tickets.get(`${RUN_ID}:S01:1`)!.status).toBe("approved");
    expect(h.review.tickets.get(`${RUN_ID}:S01:2`)!.review!.decidedBy).toBe(TEST_SLACK.reviewerId);
    const s03 = evidenceOf(report, 2);
    expect(s03).toMatchObject({
      requests: 200,
      serverErrors: 0,
      reviewsChecked: 3,
      reviewsChanged: 0,
      healthStatus: 200,
    });
    for (const status of s03["statuses"] as number[]) expect(S03_ALLOWED).toContain(status);
    expect(h.e2e.peakInFlightOf(INTERACTIVITY)).toBeLessThanOrEqual(10);
    expect(h.e2e.peakInFlightOf(INTERACTIVITY)).toBeGreaterThan(1);
    for (const word of ["harassment", "Complaint", "evil.example", "<!channel>"]) {
      expect(text).not.toContain(word);
    }
  });
});

describe("T4.S.01 negative cases", () => {
  it.each<[string, ReviewHarnessOptions, string[]]>([
    [
      "the mock accepts forged and stale requests",
      { faults: { acceptForged: true } },
      [
        "a-forged-401",
        "a-stale-401",
        "a-still-waiting",
        "event-bad_signature",
        "event-stale_timestamp",
        "a-final-approve",
      ],
    ],
    [
      "the replay changes B",
      { faults: { replayChanges: true } },
      ["b-replay-already-decided", "b-unchanged", "b-one-review-decided"],
    ],
    [
      "a security event kind is missing",
      { faults: { dropKinds: ["binding_mismatch"] } },
      ["event-binding_mismatch"],
    ],
  ])("fails, naming the check, when %s", async (_case, options, checks) => {
    const h = await harness(options);
    const { code, report } = await h.run(["--only", "T4.S.01"]);
    expect(code).toBe(1);
    expect(evidenceOf(report)["failedChecks"]).toEqual(checks);
  });

  it.each<[string, ReviewHarnessOptions, string]>([
    [
      "the mock accepts a user not on the allow-list",
      { faults: { allowAnyUser: true } },
      "a-not-allow-listed-403",
    ],
    [
      "the mock does not check the binding",
      { faults: { skipBinding: true } },
      "a-binding-mismatch-403",
    ],
  ])("fails, naming the check, when %s", async (_case, options, check) => {
    const h = await harness(options);
    const { code, report } = await h.run(["--only", "T4.S.01"]);
    expect(code).toBe(1);
    expect(evidenceOf(report)["failedChecks"]).toContain(check);
  });

  it("waits for B to be approved before counting its events", async () => {
    const h = await harness({ faults: { decisionDelayMs: 2_000 } });
    const { code, report } = await h.run(["--only", "T4.S.01"]);
    expect(code).toBe(0);
    expect(evidenceOf(report)["bDecidedEvents"]).toBe(1);
  });

  it("passes when B is approved after 7 s (the real waitpoint resume)", async () => {
    const h = await harness({ faults: { decisionDelayMs: 7_000 } });
    const { code, report } = await h.run(["--only", "T4.S.01"]);
    expect(code).toBe(0);
    expect(evidenceOf(report)["failedChecks"]).toEqual([]);
  });

  it("fails b-approved when B is not approved within 15 s, and still approves A", async () => {
    const h = await harness({ faults: { decisionDelayMs: 16_000 } });
    const { report } = await h.run(["--only", "T4.S.01"]);
    expect(evidenceOf(report)["failedChecks"]).toContain("b-approved");
    expect(h.review.tickets.get(`${RUN_ID}:S01:1`)!.review!.decision).toBe("approve");
  });

  it("is not_run without the signing variables and creates no ticket", async () => {
    const { E2E_SLACK_BOT_TOKEN } = markerSlackEnv();
    const h = await harness({ slackEnv: { E2E_SLACK_BOT_TOKEN } });
    const { code, report } = await h.run(["--only", "T4.S.01"]);
    expect(code).toBe(2);
    expect(evidenceOf(report)["missing"]).toEqual([
      "E2E_SLACK_SIGNING_SECRET",
      "E2E_SLACK_REVIEWER_ID",
      "E2E_SLACK_CHANNEL_ID",
    ]);
    expect(h.count("POST", "/api/internal/test-tickets")).toBe(0);
  });
});

describe("T4.S.02 markup", () => {
  it("passes when the card keeps the markup in plain_text only", async () => {
    const h = await harness();
    const { code } = await h.run(["--only", "T4.S.02"]);
    expect(code).toBe(0);
    const ticket = h.review.tickets.get(`${RUN_ID}:S02:1`)!;
    const card = h.slack.messages.find((m) => m.ts === ticket.review!.slackTs)!;
    expect(card.text).toContain("&lt;!channel&gt;");
    expect(JSON.stringify(card.blocks)).toContain(JSON.stringify(MARKUP).slice(1, -1));
  });

  const addMrkdwn = (text: string) => ({
    faults: {
      editCard: (_id: string, card: MockCard) => ({
        ...card,
        blocks: [...card.blocks, { type: "context", elements: [{ type: "mrkdwn", text }] }],
      }),
    },
  });
  it.each<[string, ReviewHarnessOptions, string[]]>([
    [
      "a mrkdwn field holds <!channel>",
      addMrkdwn("<!channel>"),
      ["mrkdwn-no-markup", "markup-only-in-plain-text"],
    ],
    [
      "a non-plain object (a markdown block) holds <!channel>",
      {
        faults: {
          editCard: (_id: string, card: MockCard) => ({
            ...card,
            blocks: [...card.blocks, { type: "markdown", text: "<!channel>" }],
          }),
        },
      },
      ["markup-only-in-plain-text"],
    ],
    [
      "the fallback text is not escaped",
      {
        faults: {
          editCard: (_id: string, card: MockCard) => ({
            ...card,
            text: `Review needed: ${MARKUP}`,
          }),
        },
      },
      ["fallback-escaped"],
    ],
  ])("fails when %s", async (_case, options, checks) => {
    const h = await harness(options);
    const { code, report } = await h.run(["--only", "T4.S.02"]);
    expect(code).toBe(1);
    expect(evidenceOf(report)["failedChecks"]).toEqual(checks);
  });
});

describe("T4.S.03 fuzz", () => {
  it("reports reviews-unchanged as skipped when the run created no review", async () => {
    const h = await harness();
    const { code, report } = await h.run(["--only", "T4.S.03"]);
    expect(code).toBe(0);
    expect(evidenceOf(report)).toMatchObject({
      reviewsChecked: 0,
      skippedChecks: ["reviews-unchanged"],
      failedChecks: [],
    });
  });

  it("fails when one request gets 500, and never has more than 10 in flight", async () => {
    const h = await harness({ delayMs: 5, faults: { fail500: (n) => n === 7 } });
    const { code, report } = await h.run(["--only", "T4.S.03"]);
    expect(code).toBe(1);
    expect(evidenceOf(report)).toMatchObject({
      serverErrors: 1,
      failedChecks: ["no-5xx", "allowed-statuses"],
    });
    expect(h.review.interactivityRequests()).toBe(200);
    expect(h.e2e.peakInFlightOf(INTERACTIVITY)).toBeLessThanOrEqual(10);
  });

  it("fails when a review changes", async () => {
    const h = await harness({ faults: { acceptForged: true } });
    const { report } = await h.run(["--only", "T4.S.02,T4.S.03"]);
    expect(evidenceOf(report, 1)["failedChecks"]).toContain("reviews-unchanged");
  });

  it("builds the same 200 requests for the same run ID, none validly signed", () => {
    const context = {
      runId: RUN_ID,
      now: () => Date.parse("2026-11-05T00:00:00.000Z"),
      config: {
        slack: { ...TEST_SLACK, signingSecret: markerSlackEnv().E2E_SLACK_SIGNING_SECRET },
      },
    } as unknown as ScenarioContext;
    const targets = [
      { reviewId: "00000000-0000-4000-8000-000000000001", slackTs: "1793836800.000001" },
    ];
    const first = fuzzRequests(context, targets);
    expect(fuzzRequests(context, targets)).toEqual(first);
    expect(first).toHaveLength(200);
    expect(new Set(first.map((r) => r.contentType)).size).toBeGreaterThan(2);
    expect(first.some((r) => r.headers["X-Slack-Signature"] === undefined)).toBe(true);
    expect(first.some((r) => r.body.length > 128 * 1024)).toBe(true);
    expect(first.some((r) => r.body.includes(targets[0]!.reviewId))).toBe(true);
    expect(seededRandom("a")()).toBe(seededRandom("a")());
    expect(seededRandom("a")()).not.toBe(seededRandom("b")());
  });
});

describe("T4.S.04 staging", () => {
  it("passes when staging answers 401, sending no Access header, no bearer and a random review ID", async () => {
    const h = await harness();
    const { code, report } = await h.run(["--only", "T4.S.04"]);
    expect(code).toBe(0);
    expect(h.e2e.requests).toEqual([]);
    expect(h.staging.requests).toHaveLength(1);
    const [request] = h.staging.requests;
    expect(request).toMatchObject({
      method: "POST",
      path: "/api/slack/interactivity",
      hasAccessHeaders: false,
      hasAuthorization: false,
    });
    const payload = JSON.parse(new URLSearchParams(request!.body).get("payload")!) as {
      actions: Array<{ value: string }>;
    };
    const sent = payload.actions[0]!.value;
    expect(sent).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(evidenceOf(report)).toMatchObject({ status: 401, reviewId: sent });
    // A second run sends a different random ID.
    await h.run(["--only", "T4.S.04"], undefined, "run-mock-0002");
    const again = JSON.parse(
      new URLSearchParams(h.staging.requests[1]!.body).get("payload")!,
    ) as typeof payload;
    expect(again.actions[0]!.value).not.toBe(sent);
  });

  it.each([200, 403, 404])("fails when staging answers %i", async (status) => {
    const h = await harness({ stagingStatus: status });
    const { code, report } = await h.run(["--only", "T4.S.04"]);
    expect(code).toBe(1);
    expect(evidenceOf(report)).toMatchObject({ status, failedChecks: ["staging-401"] });
  });

  it("is not_run (exit code 2) without STAGING_BASE_URL, sending nothing", async () => {
    const h = await harness({ stagingStatus: null });
    const { code, report } = await h.run(["--only", "T4.S.04"]);
    expect(code).toBe(2);
    expect(report.scenarios[0]).toMatchObject({
      status: "not_run",
      evidence: { missing: ["STAGING_BASE_URL"] },
    });
    expect(h.staging.requests).toEqual([]);
  });
});
