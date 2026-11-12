import { randomUUID } from "node:crypto";
import { canaryTicketText, type ReviewTicketPayload } from "@ai-it-support/shared";
import { SlackApiError, createSlackClient } from "@ai-it-support/slack";
import { HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPipelineAlert } from "../src/pipeline-alert.js";
import {
  createReviewDeps,
  onReviewFailure,
  runReviewTicket,
  type ReviewDeps,
  type ReviewWait,
} from "../src/trigger/review-ticket.js";
import { createTriageDeps, runTriageTicket } from "../src/trigger/triage-ticket.js";
import { egress } from "../test-support/egress.js";
import {
  REVIEW_ENV,
  SLACK_CHANNEL as CHANNEL,
  SLACK_ORIGIN,
  SLACK_REVIEWER as REVIEWER,
  mockSensitiveAnswer,
} from "../test-support/provider-mocks.js";
import { createTokenBroker, type TokenBroker } from "../test-support/token-broker.js";
import {
  eventTypes,
  intake,
  quiet,
  requestsTo,
  sql,
  testEnv,
  testRepos,
  ticketStatus,
  useTriageStack,
} from "./triage-harness.js";

// P4-T9a: the review flow on the local REST stack (migrations 0001-0005). The
// real intake, triage and review bodies run with real repositories; TypeSafe
// (the sensitive answer), the LLM and Langfuse are mocked at HTTP, and so is
// the Slack Web API. The wait dep is the in-process token broker, and a
// decision is made as the interactivity handler makes it: decideReview, then
// complete the token. The egress recorder checks every test (setup file); the
// broker's marker and every requester name and email are forbidden strings.

useTriageStack();

const SLACK_HOST = new URL(SLACK_ORIGIN).host;
const reviewEnv = () => ({ ...testEnv(), ...REVIEW_ENV });

// ---- Slack mock ----------------------------------------------------------------

/** Answers used before the default ones, first in first out. */
let slackFaults: Array<() => Response> = [];
let slackAlways500 = false;
let tsCounter = 0;
/** Every fake sleep the Slack clients asked for, in ms. */
let sleeps: number[] = [];
let broker: TokenBroker;

function mockSlack(): void {
  egress.mock(SLACK_ORIGIN, ({ request }) => {
    const fault = slackFaults.shift();
    if (fault) return fault();
    if (slackAlways500) return HttpResponse.json({ ok: false }, { status: 500 });
    const path = new URL(request.url).pathname;
    if (path === "/api/chat.postMessage") {
      tsCounter += 1;
      return HttpResponse.json({
        ok: true,
        channel: CHANNEL,
        ts: `1790000000.${String(tsCounter).padStart(6, "0")}`,
      });
    }
    if (path === "/api/chat.update") return HttpResponse.json({ ok: true });
    return HttpResponse.json({ ok: false, error: "unknown_method" });
  });
}

type SlackCall = { path: string; body: Record<string, unknown> };
const slackCalls = (): SlackCall[] =>
  requestsTo(SLACK_HOST).map((r) => ({
    path: r.path.replace("/api/", ""),
    body: JSON.parse(r.body) as Record<string, unknown>,
  }));
const slackMethods = () => slackCalls().map((call) => call.path);

beforeEach(() => {
  slackFaults = [];
  slackAlways500 = false;
  tsCounter = 0;
  sleeps = [];
  mockSlack();
  mockSensitiveAnswer(egress);
  broker = createTokenBroker();
  egress.forbid(broker.marker);
});

/** DoD 2: no Slack request carries the broker's marker (token url) or a token ID. */
function expectNoTokenInSlack(): void {
  const tokenIds = broker.tokens().map((token) => token.id);
  for (const request of requestsTo(SLACK_HOST)) {
    expect(request.body).not.toContain(broker.marker);
    for (const id of tokenIds) expect(request.body).not.toContain(id);
  }
}

// ---- Pipeline steps ----------------------------------------------------------

const fakeSleep = async (ms: number) => void sleeps.push(ms);

/** The real review deps, with the broker as wait and Slack clients that sleep fake. */
function reviewDeps(wait: ReviewWait = broker): ReviewDeps {
  const env = reviewEnv();
  return {
    ...createReviewDeps(env),
    wait,
    slack: createSlackClient({ token: REVIEW_ENV.SLACK_BOT_TOKEN, sleep: fakeSleep }),
    alert: createPipelineAlert(env, testRepos(), {
      createClient: (options) => createSlackClient({ ...options, sleep: fakeSleep }),
      logger: { error: () => undefined },
    }),
    // P5-T5b: the helpdesk handoff is recorded, not sent.
    triggerHelpdeskSync: async () => undefined,
    // P5-T8b: nor is the reply email trigger.
    triggerNotify: async () => undefined,
    logger: quiet,
  };
}

/** An HR complaint holding every canary; its requester name and email are forbidden. */
async function createHrTicket(): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const name = `Review Requester ${suffix}`;
  const email = `review.${suffix}@example.test`;
  egress.forbid(name);
  egress.forbid(email);
  const { ticket } = await testRepos().createTicket({
    source: "web",
    raw_title: "Complaint about my team lead",
    raw_description: `I want to raise an HR complaint about harassment by my team lead.\n${canaryTicketText(egress.runId)}`,
    requester_email: email,
    requester_name: name,
    department: "Finance",
    idempotency_key: `it-review-${suffix}`,
  });
  return ticket.id;
}

/** Intake and triage with the real deps; the review trigger is recorded, not sent. */
async function triagedForReview() {
  const ticketId = await createHrTicket();
  const triggers: ReviewTicketPayload[] = [];
  const result = await runTriageTicket(await intake(ticketId), {
    ...createTriageDeps(testEnv()),
    triggerReview: async (payload) => void triggers.push(payload),
    triggerHelpdeskSync: async () => undefined,
    logger: quiet,
  });
  expect(result).toMatchObject({ ticketId, skipped: false, route: "review" });
  expect(triggers).toEqual([{ ticketId }]);
  expect(await ticketStatus(ticketId)).toBe("triaged");
  // Slack requests before the review starts: none.
  expect(slackCalls()).toEqual([]);
  return { ticketId, payload: triggers[0]!, triggers };
}

/** Starts the review body; resolves with the token ID once it waits on it. */
async function startReview(payload: ReviewTicketPayload, deps = reviewDeps(), attempt = 1) {
  const run = runReviewTicket(payload, deps, attempt);
  run.catch(() => undefined);
  let tokenId = "";
  await vi.waitFor(
    () => {
      const token = broker.tokens().find((t) => t.idempotencyKey === `review:${payload.ticketId}`);
      expect(token && broker.waiters(token.id)).toBe(1);
      tokenId = token!.id;
    },
    { timeout: 15_000, interval: 20 },
  );
  return { run, tokenId };
}

/** A decision as the interactivity handler makes it: the row first, then the token. */
async function decide(ticketId: string, decision: "approve" | "reject", userId = REVIEWER) {
  const review = await testRepos().getTriageReview(ticketId);
  expect(review).not.toBeNull();
  const result = await testRepos().decideReview(review!.id, decision, userId);
  broker.complete(review!.wait_token_id, { reviewId: review!.id, decision });
  return result;
}

async function reviewRows(ticketId: string) {
  const { rows } = await sql().query<{
    decision: string | null;
    slack_user_id: string | null;
    slack_ts: string | null;
    wait_token_id: string;
  }>(
    "select decision, slack_user_id, slack_ts, wait_token_id from itsupport.reviews where ticket_id = $1",
    [ticketId],
  );
  return rows;
}

async function eventsAfterTriaged(ticketId: string): Promise<string[]> {
  const types = await eventTypes(ticketId);
  return types.slice(types.indexOf("triaged") + 1);
}

// ---- Tests -------------------------------------------------------------------

describe("review flow on the local REST stack", () => {
  it("T4.I.01: approve → approved, one approve row with the user ID, two events, one post and one update", async () => {
    const { ticketId, payload } = await triagedForReview();

    const { run, tokenId } = await startReview(payload);
    expect(await ticketStatus(ticketId)).toBe("review_pending");
    expect(slackMethods()).toEqual(["chat.postMessage"]);
    expect(broker.get(tokenId)).toMatchObject({
      timeout: "24h",
      tags: [`ticket:${ticketId}`],
      state: "waiting",
    });

    expect((await decide(ticketId, "approve")).changed).toBe(true);
    await expect(run).resolves.toEqual({ ticketId, skipped: false, decision: "approve" });

    expect(await ticketStatus(ticketId)).toBe("approved");
    const rows = await reviewRows(ticketId);
    expect(rows).toEqual([
      {
        decision: "approve",
        slack_user_id: REVIEWER,
        slack_ts: "1790000000.000001",
        wait_token_id: tokenId,
      },
    ]);
    expect(await eventsAfterTriaged(ticketId)).toEqual(["review_requested", "review_decided"]);
    expect(slackMethods()).toEqual(["chat.postMessage", "chat.update"]);
    const [post, update] = slackCalls();
    expect(post!.body).toMatchObject({ channel: CHANNEL });
    expect(post!.body.thread_ts).toBeUndefined();
    expect(update!.body).toMatchObject({ channel: CHANNEL, ts: "1790000000.000001" });
    // The card shows the redacted text: no canary, and no wait-token data.
    expect(JSON.stringify(post!.body)).toContain("[REDACTED_");
    expectNoTokenInSlack();
  });

  it("T4.I.02: reject → rejected, and no task is triggered after review-ticket started", async () => {
    const { ticketId, payload, triggers } = await triagedForReview();
    const { run } = await startReview(payload);

    await decide(ticketId, "reject");
    await expect(run).resolves.toEqual({ ticketId, skipped: false, decision: "reject" });

    expect(await ticketStatus(ticketId)).toBe("rejected");
    expect((await reviewRows(ticketId)).map((row) => row.decision)).toEqual(["reject"]);
    expect(await eventsAfterTriaged(ticketId)).toEqual(["review_requested", "review_decided"]);
    expect(triggers).toHaveLength(1);
    expect(egress.requests().filter((r) => r.host.includes("trigger.dev"))).toEqual([]);
    expect(slackMethods()).toEqual(["chat.postMessage", "chat.update"]);
    expectNoTokenInSlack();
  });

  it("T4.I.04: a timed-out token → escalated_manual, a thread note on the card and a card update; a late approve changes nothing", async () => {
    const { ticketId, payload } = await triagedForReview();
    const { run, tokenId } = await startReview(payload);

    expect(broker.timeOut(tokenId)).toBe(true);
    await expect(run).resolves.toEqual({ ticketId, skipped: false, decision: "timeout" });

    expect(await ticketStatus(ticketId)).toBe("escalated_manual");
    const [row] = await reviewRows(ticketId);
    expect(row).toMatchObject({ decision: "timeout", slack_user_id: null });
    expect(slackMethods()).toEqual(["chat.postMessage", "chat.postMessage", "chat.update"]);
    const [card, note, update] = slackCalls();
    expect(card!.body.thread_ts).toBeUndefined();
    expect(note!.body).toMatchObject({ channel: CHANNEL, thread_ts: row!.slack_ts });
    expect(update!.body).toMatchObject({ channel: CHANNEL, ts: row!.slack_ts });
    expect(await eventsAfterTriaged(ticketId)).toEqual(["review_requested", "review_timed_out"]);

    const late = await decide(ticketId, "approve");
    expect(late.changed).toBe(false);
    expect(late.review.decision).toBe("timeout");
    expect(await ticketStatus(ticketId)).toBe("escalated_manual");
    expectNoTokenInSlack();
  });

  it("T4.I.05: Slack 429 with Retry-After 1, then 200 → the card is posted after 2 requests", async () => {
    const { ticketId, payload } = await triagedForReview();
    slackFaults.push(() =>
      HttpResponse.json(
        { ok: false, error: "ratelimited" },
        { status: 429, headers: { "Retry-After": "1" } },
      ),
    );

    const { run } = await startReview(payload);
    expect(slackMethods()).toEqual(["chat.postMessage", "chat.postMessage"]);
    expect(sleeps).toEqual([1000]);
    const [first, second] = slackCalls();
    expect(second!.body).toEqual(first!.body);
    expect((await reviewRows(ticketId))[0]!.slack_ts).toBe("1790000000.000001");

    await decide(ticketId, "approve");
    await expect(run).resolves.toMatchObject({ decision: "approve" });
    expect(await ticketStatus(ticketId)).toBe("approved");
    expectNoTokenInSlack();
  });

  it("T4.I.05: Slack always 500 → 3 attempts of 3 requests, then onReviewFailure sets failed and raises one alert", async () => {
    const { ticketId, payload } = await triagedForReview();
    slackAlways500 = true;

    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      lastError = await runReviewTicket(payload, reviewDeps(), attempt).catch((e: unknown) => e);
      expect(lastError).toBeInstanceOf(SlackApiError);
      expect(lastError).toMatchObject({ code: "http_500", method: "chat.postMessage" });
      expect(slackMethods()).toHaveLength(3 * attempt);
      expect(await ticketStatus(ticketId)).toBe("review_pending");
    }
    expect(sleeps).toEqual([1000, 2000, 1000, 2000, 1000, 2000]);
    // A failed post throws before the event: no review_requested yet, one row without a card.
    expect(await eventsAfterTriaged(ticketId)).toEqual([]);
    expect(await reviewRows(ticketId)).toEqual([expect.objectContaining({ slack_ts: null })]);

    const deps = reviewDeps();
    await onReviewFailure(
      { payload, error: lastError },
      { repos: testRepos(), alert: deps.alert, logger: quiet },
    );

    expect(await ticketStatus(ticketId)).toBe("failed");
    expect(await eventsAfterTriaged(ticketId)).toEqual(["review_failed"]);
    const { rows } = await sql().query<{ source: string; kind: string; count: number }>(
      "select source, kind, count from itsupport.security_events where kind = 'alert:review_failed'",
    );
    expect(rows).toEqual([{ source: "pipeline", kind: "alert:review_failed", count: 1 }]);
    expectNoTokenInSlack();
  });

  it("running review-ticket twice leaves one reviews row, one card post and one review_requested event", async () => {
    const { ticketId, payload } = await triagedForReview();
    // Attempt 1 posts the card, writes the event, then dies in the wait.
    const crashing: ReviewWait = {
      createToken: (options) => broker.createToken(options),
      forToken: () => Promise.reject(new Error("worker lost")),
    };
    await expect(runReviewTicket(payload, reviewDeps(crashing), 1)).rejects.toThrow("worker lost");

    // Attempt 2 gets the same token and row, posts nothing and waits.
    const { run, tokenId } = await startReview(payload, reviewDeps(), 2);
    expect(broker.tokens()).toHaveLength(1);
    expect(broker.tokens()[0]!.id).toBe(tokenId);
    expect(slackMethods()).toEqual(["chat.postMessage"]);

    await decide(ticketId, "approve");
    await expect(run).resolves.toMatchObject({ decision: "approve" });
    // A run after the decision is a no-op.
    await expect(runReviewTicket(payload, reviewDeps(), 3)).resolves.toEqual({
      ticketId,
      skipped: true,
    });

    expect(await reviewRows(ticketId)).toHaveLength(1);
    expect(slackMethods()).toEqual(["chat.postMessage", "chat.update"]);
    expect(await eventsAfterTriaged(ticketId)).toEqual(["review_requested", "review_decided"]);
    expectNoTokenInSlack();
  });
});
