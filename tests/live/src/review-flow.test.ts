// T4.L.01 to T4.L.04 (P4-T8b) through runLive, against the mocks only.
import { buildCanaries } from "@ai-it-support/shared";
import { afterEach, describe, expect, it } from "vitest";
import { canaryRunId } from "./observability.ts";
import { truncate } from "./review-flow.ts";
import { TEST_SLACK } from "./testing/env.ts";
import { CARD_LAG_MS, type MockCard } from "./testing/mock-review.ts";
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
const ALL = ["--only", "T4.L.01,T4.L.02,T4.L.03,T4.L.04"];
const failedChecks = (report: { scenarios: readonly { evidence: Record<string, unknown> }[] }) =>
  report.scenarios[0]!.evidence["failedChecks"];

/** Words of the synthetic ticket text; none may reach a report. */
const TICKET_WORDS = ["harassment", "Complaint", "manager", "demo.erin", "confidentially"];

describe("review flow scenarios against the mocks", () => {
  it("all four pass, with one ticket each, 4 test-ticket requests, 0 form submits and 1 judge call", async () => {
    const h = await harness();
    const { code, report, text } = await h.run(ALL);
    expect(code).toBe(0);
    expect(report.scenarios.map((s) => [s.id, s.status])).toEqual([
      ["T4.L.01", "pass"],
      ["T4.L.02", "pass"],
      ["T4.L.03", "pass"],
      ["T4.L.04", "pass"],
    ]);
    expect(h.count("POST", "/api/internal/test-tickets")).toBe(4);
    expect(h.count("POST", "/api/tickets")).toBe(0);
    expect(h.count("POST", "/api/internal/judgments")).toBe(1);
    expect([...h.review.tickets.keys()]).toEqual([
      `${RUN_ID}:L01:1`,
      `${RUN_ID}:L02:1`,
      `${RUN_ID}:L03:1`,
      `${RUN_ID}:L04:1`,
    ]);
    for (const entry of report.scenarios) {
      expect(entry.evidence).toMatchObject({
        ticketId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        reviewId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        slackTs: expect.stringMatching(/^[0-9]+\.[0-9]{6}$/),
        readyMs: expect.any(Number),
        aiCallCount: 2,
        failedChecks: [],
      });
    }
    // Evidence has IDs, times and counts only: no ticket text, no canary.
    for (const word of TICKET_WORDS) expect(text).not.toContain(word);
    for (const canary of buildCanaries(canaryRunId(RUN_ID)))
      expect(text).not.toContain(canary.value);
    expect(report.scenarios[1]!.evidence).toMatchObject({ responseStatus: 200, decidedMs: 500 });
    expect(report.scenarios[2]!.evidence).toMatchObject({ eventsAfter: 0 });
    expect(report.scenarios[3]!.evidence).toMatchObject({
      threadNotes: 1,
      status: "escalated_manual",
    });
  });

  it("T4.L.01 sends J4 the card text and a reader, never the raw ticket", async () => {
    const h = await harness();
    await h.run(["--only", "T4.L.01"]);
    expect(h.judgeBodies).toHaveLength(1);
    const body = h.judgeBodies[0] as {
      judgeId: string;
      state: { message: string; reader: string };
    };
    expect(body.judgeId).toBe("J4");
    expect(body.state.message).toContain("Review needed: ");
    expect(body.state.reader).toContain("reviewer");
    for (const canary of buildCanaries(canaryRunId(RUN_ID))) {
      expect(JSON.stringify(body)).not.toContain(canary.value);
    }
  });
});

describe("T4.L.01 negative cases", () => {
  const withCard = (edit: (card: MockCard) => MockCard) => ({
    faults: { editCard: (_id: string, card: MockCard) => edit(card) },
  });
  const blocks = (card: MockCard) => card.blocks as Array<Record<string, unknown>>;

  it.each<[string, ReviewHarnessOptions, string]>([
    ["the card is missing from history", { faults: { hideCard: () => true } }, "card-in-history"],
    [
      "a canary is in the message",
      withCard((card) => ({
        ...card,
        blocks: [
          ...card.blocks,
          {
            type: "section",
            text: { type: "plain_text", text: buildCanaries(canaryRunId(RUN_ID))[0]!.value },
          },
        ],
      })),
      "no-canaries",
    ],
    [
      "a button is missing",
      withCard((card) => ({
        ...card,
        blocks: blocks(card).map((b) =>
          b.type === "actions" ? { ...b, elements: (b.elements as unknown[]).slice(0, 1) } : b,
        ),
      })),
      "two-buttons",
    ],
    [
      "a button carries another value",
      withCard((card) => ({
        ...card,
        blocks: blocks(card).map((b) =>
          b.type === "actions"
            ? {
                ...b,
                elements: (b.elements as Array<Record<string, unknown>>).map((e) => ({
                  ...e,
                  value: "00000000-0000-4000-8000-000000000000",
                })),
              }
            : b,
        ),
      })),
      "two-buttons",
    ],
    [
      "the header is not the redacted title",
      withCard((card) => ({
        ...card,
        blocks: blocks(card).map((b) =>
          b.type === "header"
            ? { ...b, text: { type: "plain_text", text: "Review needed: other" } }
            : b,
        ),
      })),
      "header-redacted-title",
    ],
    ["the judge score is 0.69", { judge: () => 0.69 }, "j4-score"],
    ["the judgment fails", { judge: () => "failed" }, "j4-score"],
  ])("fails when %s", async (_case, options, check) => {
    const h = await harness(options);
    const { code, report } = await h.run(["--only", "T4.L.01"]);
    expect(code).toBe(1);
    expect(report.scenarios[0]!.status).toBe("fail");
    expect(failedChecks(report)).toEqual([check]);
  });

  it("skips J4 when a canary is on the card, so leaked text never goes to TypeSafe", async () => {
    const h = await harness(
      withCard((card) => ({
        ...card,
        blocks: [
          ...card.blocks,
          {
            type: "section",
            text: { type: "plain_text", text: buildCanaries(canaryRunId(RUN_ID))[0]!.value },
          },
        ],
      })),
    );
    const { report } = await h.run(["--only", "T4.L.01"]);
    expect(h.count("POST", "/api/internal/judgments")).toBe(0);
    expect(report.scenarios[0]!.evidence).toMatchObject({
      judgeStatus: "skipped",
      failedChecks: ["no-canaries"],
    });
  });

  it("records j4-score when the judgments route answers 422 unredacted_input", async () => {
    const h = await harness({ judge: () => "unredacted_input" });
    const { code, report } = await h.run(["--only", "T4.L.01"]);
    expect(code).toBe(1);
    expect(report.scenarios[0]!.error).toBeUndefined();
    expect(report.scenarios[0]!.evidence).toMatchObject({
      judgeStatus: "refused",
      judgeHttpStatus: 422,
      judgeScore: null,
      failedChecks: ["j4-score"],
    });
  });

  it("keeps the earlier check results when the judge refuses", async () => {
    const h = await harness({
      judge: () => "unredacted_input",
      ...withCard((card) => ({
        ...card,
        blocks: blocks(card).map((b) =>
          b.type === "actions" ? { ...b, elements: (b.elements as unknown[]).slice(0, 1) } : b,
        ),
      })),
    });
    const { report } = await h.run(["--only", "T4.L.01"]);
    expect(failedChecks(report)).toEqual(["two-buttons", "j4-score"]);
  });

  it("does not call the judge when the card is missing", async () => {
    const h = await harness({ faults: { hideCard: () => true } });
    await h.run(["--only", "T4.L.01"]);
    expect(h.count("POST", "/api/internal/judgments")).toBe(0);
  });

  it("passes at a score of exactly 0.7, and the header check truncates a long title", async () => {
    const h = await harness({ judge: () => 0.7 });
    expect((await h.run(["--only", "T4.L.01"])).code).toBe(0);
    expect(truncate("x".repeat(200), 135)).toHaveLength(135);
    expect(truncate("x".repeat(200), 135).endsWith("…")).toBe(true);
    expect(truncate("short", 135)).toBe("short");
  });

  it("fails review-pending when no card ts appears within 60 s", async () => {
    const h = await harness({ faults: { reviewAfterMs: () => 70_000 } });
    const { report } = await h.run(["--only", "T4.L.01"]);
    expect(failedChecks(report)).toEqual(["review-pending"]);
    expect(report.scenarios[0]!.evidence["readyMs"]).toBeNull();
  });
});

describe("T4.L.02 approve", () => {
  it("passes when the mock approves within 1 second", async () => {
    const h = await harness({ faults: { decisionDelayMs: 1_000 } });
    const { code, report } = await h.run(["--only", "T4.L.02"]);
    expect(code).toBe(0);
    expect(report.scenarios[0]!.evidence["decidedMs"]).toBe(1_000);
    expect(h.review.tickets.get(`${RUN_ID}:L02:1`)!.review!.decidedBy).toBe(TEST_SLACK.reviewerId);
  });

  it.each<[string, ReviewHarnessOptions, string[]]>([
    [
      "approved comes after 6 seconds",
      { faults: { decisionDelayMs: 6_000 } },
      ["decided-within-5s"],
    ],
    ["decidedBy is another user", { faults: { decidedBy: "U0OTHERUSER" } }, ["decided-by"]],
    [
      "the card still has buttons",
      { faults: { keepButtons: true } },
      ["card-no-buttons", "card-names-decision"],
    ],
  ])("fails when %s", async (_case, options, checks) => {
    const h = await harness(options);
    const { code, report } = await h.run(["--only", "T4.L.02"]);
    expect(code).toBe(1);
    expect(failedChecks(report)).toEqual(checks);
  });

  it("polls every 500 ms after the answer", async () => {
    const h = await harness({ faults: { decisionDelayMs: 1_200 } });
    const { report } = await h.run(["--only", "T4.L.02"]);
    expect(report.scenarios[0]!.evidence["decidedMs"]).toBe(1_500);
  });
});

describe("T4.L.03 reject", () => {
  it("passes for rejected with an updated card", async () => {
    const h = await harness();
    const { code } = await h.run(["--only", "T4.L.03"]);
    expect(code).toBe(0);
    const ticket = h.review.tickets.get(`${RUN_ID}:L03:1`)!;
    expect(ticket.status).toBe("rejected");
    const card = h.slack.messages.find((m) => m.ts === ticket.review!.slackTs)!;
    expect(JSON.stringify(card)).toContain("Rejected by");
  });

  it("fails when another event follows review_decided", async () => {
    const h = await harness({ faults: { eventAfterDecision: true } });
    const { code, report } = await h.run(["--only", "T4.L.03"]);
    expect(code).toBe(1);
    expect(failedChecks(report)).toEqual(["no-event-after-decision"]);
    expect(report.scenarios[0]!.evidence["eventsAfter"]).toBe(1);
  });
});

describe("T4.L.04 timeout", () => {
  it("waits for the card: the mock closes it CARD_LAG_MS after it sets escalated_manual", async () => {
    // The scenario sees escalated_manual at the exact timeout tick, when the card
    // is still open; a single card read right then would fail card-no-buttons.
    const h = await harness();
    const { code, report } = await h.run(["--only", "T4.L.04"]);
    expect(code).toBe(0);
    const ticket = h.review.tickets.get(`${RUN_ID}:L04:1`)!;
    const at = ticket.events.find((e) => e.type === "review_timed_out")!.at;
    expect(at - ticket.createdAt).toBe(6_000 + 120_000);
    expect(report.scenarios[0]!.evidence["escalatedMs"]).toBe(120_000);
    expect(ticket.timeoutCardDone).toBe(true);
    expect(CARD_LAG_MS).toBeGreaterThan(0);
  });

  it("fails card-no-buttons when the card is never closed after the timeout", async () => {
    const h = await harness({ faults: { keepButtons: true } });
    const { code, report } = await h.run(["--only", "T4.L.04"]);
    expect(code).toBe(1);
    expect(failedChecks(report)).toEqual(["card-no-buttons"]);
  });

  it("passes when the mock escalates and posts the thread reply", async () => {
    const h = await harness();
    const { code, report } = await h.run(["--only", "T4.L.04"]);
    expect(code).toBe(0);
    expect(report.scenarios[0]!.evidence).toMatchObject({ escalatedMs: expect.any(Number) });
  });

  it.each<[string, ReviewHarnessOptions, string[]]>([
    ["the thread reply is missing", { faults: { noTimeoutNote: true } }, ["thread-note"]],
    [
      "the status is still review_pending at the limit",
      { faults: { noTimeout: true } },
      ["escalated-manual", "decision-timeout", "thread-note", "card-no-buttons"],
    ],
  ])("fails when %s", async (_case, options, checks) => {
    const h = await harness(options);
    const { code, report } = await h.run(["--only", "T4.L.04"]);
    expect(code).toBe(1);
    expect(failedChecks(report)).toEqual(checks);
  });
});

describe("Slack variables", () => {
  it.each(["T4.L.01", "T4.L.02", "T4.L.03", "T4.L.04"])(
    "%s is not_run (exit 2) without them and creates no ticket",
    async (id) => {
      const h = await harness({ slackEnv: {} });
      const { code, report } = await h.run(["--only", id]);
      expect(code).toBe(2);
      expect(report.scenarios[0]!.status).toBe("not_run");
      expect(h.count("POST", "/api/internal/test-tickets")).toBe(0);
    },
  );
});
