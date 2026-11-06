// Phase 4 live security scenarios for the review flow (plan T4.S.01 to
// T4.S.04). Evidence holds status codes, counts and IDs only.
import { createHash, randomUUID } from "node:crypto";
import { signSlackRequest, type InternalTicketView } from "@ai-it-support/shared";
import { LiveTransportError } from "./client.ts";
import { result } from "./pipeline.ts";
import {
  createdReviewTickets,
  createReviewTicket,
  decodeSlackEntities,
  DECISION_LIMIT_MS,
  DECISION_POLL_MS,
  decideAndWait,
  findCard,
  READ_SLACK,
  SIGN,
  signerOf,
  slackNotRun,
  slackOf,
  textObjects,
} from "./review-flow.ts";
import type { Scenario, ScenarioContext } from "./runner.ts";
import { floorMinute } from "./security.ts";
import { INTERACTIVITY_PATH, randomSecret, type SignedRequest } from "./slack-signer.ts";

/** A Slack user ID that is never on the e2e allow-list. */
export const NOT_ALLOW_LISTED = "U0000000099";
/** The kinds T4.S.01 must leave in security-events (source `slack`). */
export const S01_KINDS = [
  "bad_signature",
  "stale_timestamp",
  "not_allow_listed",
  "binding_mismatch",
] as const;

/**
 * T4.S.01: forged, stale, not allow-listed and cross-bound decisions on A are
 * refused (401, 401, 403, 403) and leave A waiting; the exact approve of B sent
 * again is `already_decided` and changes nothing; every refusal is a security
 * event. A is approved at the end, so it does not wait for the timeout.
 */
export const forgedDecisionScenario: Scenario = {
  id: "T4.S.01",
  async run(context) {
    const notRun = slackNotRun(context, SIGN);
    if (notRun) return notRun;
    const since = floorMinute(context.now());
    const a = await createReviewTicket(context, "S01", { n: 1 });
    const b = await createReviewTicket(context, "S01", { n: 2 });
    if (a.review === undefined || b.review === undefined) {
      return result(["review-pending"], {
        ticketIds: [a.ticketId, b.ticketId],
        aiCallCount: a.view.aiCallCount + b.view.aiCallCount,
      });
    }
    const aReview = { id: a.review.id, slackTs: a.review.slackTs! };
    const bReview = { id: b.review.id, slackTs: b.review.slackTs! };
    const signer = signerOf(context);
    const failedChecks: string[] = [];

    // B is approved first; its exact request is kept for the replay.
    const bSigned = signer.signedDecision({ ...ids(bReview), decision: "approve" });
    const statuses: Record<string, number | string | null> = {};
    let bDecidedEvents: number | null = null;
    let kinds: string[] = [];
    let bAiCalls = b.view.aiCallCount;
    let aFinal: Awaited<ReturnType<typeof decideAndWait>>;
    try {
      const bFirst = await signer.send(bSigned);
      if (bFirst.status !== 200 || bFirst.outcome !== "recorded") failedChecks.push("b-recorded");
      // The woken run writes review_decided and the status after the click: wait for approved.
      const bBefore = await waitForStatus(context, b.ticketId, "approved");
      if (bBefore.status !== "approved") failedChecks.push("b-approved");

      const onA = async (check: string, expected: number, signed: SignedRequest) => {
        const sent = await signer.send(signed);
        if (sent.status !== expected) failedChecks.push(check);
        return sent.status;
      };
      statuses.forgedStatus = await onA(
        "a-forged-401",
        401,
        signer.signedDecision({
          ...ids(aReview),
          decision: "approve",
          secretOverride: randomSecret(),
        }),
      );
      statuses.staleStatus = await onA(
        "a-stale-401",
        401,
        signer.signedDecision({
          ...ids(aReview),
          decision: "approve",
          timestampOffsetSeconds: -301,
        }),
      );
      statuses.notAllowedStatus = await onA(
        "a-not-allow-listed-403",
        403,
        signer.signedDecision({ ...ids(aReview), decision: "approve", userId: NOT_ALLOW_LISTED }),
      );
      statuses.bindingStatus = await onA(
        "a-binding-mismatch-403",
        403,
        signer.signedDecision({
          reviewId: aReview.id,
          slackTs: bReview.slackTs,
          decision: "approve",
        }),
      );
      const aAfter = await context.client.ticket(a.ticketId);
      const aStored = aAfter.reviews.find((r) => r.id === aReview.id);
      if (aAfter.status !== "review_pending" || aStored?.decision !== null) {
        failedChecks.push("a-still-waiting");
      }

      const replay = await signer.send(bSigned);
      statuses.replayStatus = replay.status;
      statuses.replayOutcome = replay.outcome;
      if (replay.status !== 200 || replay.outcome !== "already_decided") {
        failedChecks.push("b-replay-already-decided");
      }
      const bAfter = await context.client.ticket(b.ticketId);
      bAiCalls = bAfter.aiCallCount;
      if (
        JSON.stringify(decisionOf(bBefore, bReview.id)) !==
        JSON.stringify(decisionOf(bAfter, bReview.id))
      ) {
        failedChecks.push("b-unchanged");
      }
      bDecidedEvents = bAfter.events.filter((e) => e.type === "review_decided").length;
      if (bDecidedEvents !== 1) failedChecks.push("b-one-review-decided");

      const { events } = await context.client.securityEvents(new Date(since));
      kinds = [...new Set(events.filter((e) => e.source === "slack").map((e) => e.kind))].sort();
      for (const kind of S01_KINDS) if (!kinds.includes(kind)) failedChecks.push(`event-${kind}`);
    } finally {
      // A is approved, so its run ends now instead of at the timeout, even after an error.
      aFinal = await decideAndWait(context, a.ticketId, aReview, "approve");
    }
    if (aFinal.outcome !== "recorded") failedChecks.push("a-final-approve");

    return result(failedChecks, {
      ticketIds: [a.ticketId, b.ticketId],
      reviewIds: [aReview.id, bReview.id],
      ...statuses,
      bDecidedEvents,
      eventKinds: kinds,
      aiCallCount: aFinal.view.aiCallCount + bAiCalls,
    });
  },
};

/** Polls the view every 500 ms until it shows `status` or 15 s pass; returns the last view. */
async function waitForStatus(
  context: ScenarioContext,
  ticketId: string,
  status: string,
): Promise<InternalTicketView> {
  const deadline = context.now() + DECISION_LIMIT_MS;
  for (;;) {
    const view = await context.client.ticket(ticketId);
    if (view.status === status || context.now() >= deadline) return view;
    await context.sleep(DECISION_POLL_MS);
  }
}

const ids = (review: { id: string; slackTs: string }) => ({
  reviewId: review.id,
  slackTs: review.slackTs,
});

/** The decision fields of one review (a change to any of them is a change). */
function decisionOf(view: InternalTicketView, reviewId: string) {
  const review = view.reviews.find((r) => r.id === reviewId);
  return review === undefined
    ? null
    : {
        decision: review.decision,
        decidedBy: review.decidedBy,
        decidedAt: review.decidedAt,
        slackTs: review.slackTs,
      };
}

/** Every object in `value` with a string `text`, whatever its `type`. */
function stringTexts(value: unknown): Array<{ type: unknown; text: string }> {
  if (Array.isArray(value)) return value.flatMap(stringTexts);
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  const own = typeof record.text === "string" ? [{ type: record.type, text: record.text }] : [];
  return [...own, ...Object.values(record).flatMap(stringTexts)];
}

/** The Slack markup T4.S.02 puts in the ticket title and description. */
export const MARKUP = "<!channel> <!here> <@U00000000> <https://evil.example|click> *bold*";

/**
 * T4.S.02: a ticket whose text holds live Slack markup gets a card in which no
 * mrkdwn text holds `<`, the fallback text holds `&lt;!channel&gt;`, and a
 * plain_text object holds the markup unchanged. Slack's history answer
 * entity-encodes plain_text (`&lt;!channel&gt;`), so only that comparison
 * decodes `&lt;`, `&gt;` and `&amp;`; mrkdwn and the fallback are read raw.
 */
export const markupScenario: Scenario = {
  id: "T4.S.02",
  async run(context) {
    const notRun = slackNotRun(context, READ_SLACK);
    if (notRun) return notRun;
    const ticket = await createReviewTicket(context, "S02", {
      title: `Complaint about my manager ${MARKUP}`,
      extra: MARKUP,
    });
    const evidence = {
      ticketId: ticket.ticketId,
      reviewId: ticket.review?.id ?? null,
      slackTs: ticket.review?.slackTs ?? null,
      aiCallCount: ticket.view.aiCallCount,
    };
    if (ticket.review === undefined) return result(["review-pending"], evidence);
    const card = await findCard(slackOf(context), ticket.review.slackTs!);
    if (card === undefined) return result(["card-in-history"], evidence);
    const objects = textObjects(card.blocks ?? []);
    const mrkdwn = objects.filter((o) => o.type === "mrkdwn");
    const plain = objects.filter((o) => o.type === "plain_text");
    // Every object with a string `text` that is not plain_text (mrkdwn, a markdown
    // block, anything else Slack may parse): none may hold the broadcast.
    const parsed = stringTexts(card.blocks ?? []).filter((o) => o.type !== "plain_text");
    const failedChecks = [
      ...(mrkdwn.every((o) => !o.text.includes("<")) ? [] : ["mrkdwn-no-markup"]),
      ...(parsed.every((o) => !o.text.includes("<!channel>")) ? [] : ["markup-only-in-plain-text"]),
      ...(card.text.includes("&lt;!channel&gt;") ? [] : ["fallback-escaped"]),
      ...(plain.some((o) => decodeSlackEntities(o.text).includes(MARKUP))
        ? []
        : ["plain-text-unchanged"]),
    ];
    return result(failedChecks, {
      ...evidence,
      mrkdwnObjects: mrkdwn.length,
      plainTextObjects: plain.length,
      otherTextObjects: parsed.length,
    });
  },
};

export const S03_REQUESTS = 200;
export const S03_CONCURRENCY = 10;
export const S03_ALLOWED = [400, 401, 403, 404, 413] as const;
/** Over the app's 128 KB body limit. */
const OVERSIZE = 130 * 1024;
const CONTENT_TYPES = [
  "application/x-www-form-urlencoded",
  "application/json",
  "text/plain",
  "multipart/form-data; boundary=x",
  "application/octet-stream",
];

/** A small seeded generator (mulberry32 over the SHA-256 of the seed). */
export function seededRandom(seed: string): () => number {
  let state = createHash("sha256").update(seed).digest().readUInt32LE(0);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

interface FuzzRequest {
  readonly body: string;
  readonly contentType: string;
  readonly headers: Record<string, string>;
}

/**
 * The 200 T4.S.03 requests, seeded by the run ID. Bodies are random text,
 * oversize, or a block_actions payload for one of the run's reviews (or a
 * random review ID). None carries a valid signature: the headers are missing,
 * random, or a test-secret signature with a stale timestamp.
 */
export function fuzzRequests(
  context: ScenarioContext,
  targets: ReadonlyArray<{ reviewId: string; slackTs: string }>,
): FuzzRequest[] {
  const random = seededRandom(context.runId);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
  const hex = (bytes: number) =>
    Array.from({ length: bytes }, () =>
      Math.floor(random() * 256)
        .toString(16)
        .padStart(2, "0"),
    ).join("");
  const nowSeconds = Math.floor(context.now() / 1000);
  const channelId = context.config.slack.channelId ?? "C0000000001";
  const requests: FuzzRequest[] = [];
  for (let i = 0; i < S03_REQUESTS; i++) {
    const shape = random();
    let body: string;
    if (shape < 0.05) body = "a".repeat(OVERSIZE);
    else if (shape < 0.5) {
      const target = targets.length > 0 && random() < 0.7 ? pick(targets) : undefined;
      const payload = {
        type: "block_actions",
        user: { id: context.config.slack.reviewerId ?? "U0000000001" },
        channel: { id: channelId },
        container: { type: "message", message_ts: target?.slackTs ?? `${nowSeconds}.000001` },
        actions: [
          {
            type: "button",
            action_id: pick(["review_approve", "review_reject", "x"]),
            value: target?.reviewId ?? randomUUIDFrom(hex),
          },
        ],
      };
      body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
    } else body = hex(Math.floor(random() * 512));

    const signature = random();
    let headers: Record<string, string>;
    if (signature < 0.34) headers = {};
    else if (signature < 0.67) {
      headers = {
        "X-Slack-Request-Timestamp": String(nowSeconds),
        "X-Slack-Signature": `v0=${hex(32)}`,
      };
    } else {
      const timestamp = String(nowSeconds - 301 - Math.floor(random() * 86_400));
      headers = {
        "X-Slack-Request-Timestamp": timestamp,
        "X-Slack-Signature": signSlackRequest({
          secret: context.config.slack.signingSecret!,
          timestamp,
          body,
        }),
      };
    }
    requests.push({ body, contentType: pick(CONTENT_TYPES), headers });
  }
  return requests;
}

/** A version-4-shaped UUID from the seeded hex source. */
function randomUUIDFrom(hex: (bytes: number) => string): string {
  const h = hex(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Runs `tasks` with at most `limit` in flight. */
export async function pool<T>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      await task(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * T4.S.03: 200 random, unsigned or badly signed bodies, 10 at a time. No answer
 * is 5xx, each is 400, 401, 403, 404 or 413; afterwards every review this run
 * created is unchanged (a timeout of a waiting review is not a change) and
 * /api/health answers 200.
 */
export const fuzzScenario: Scenario = {
  id: "T4.S.03",
  async run(context) {
    const notRun = slackNotRun(context, ["E2E_SLACK_SIGNING_SECRET"]);
    if (notRun) return notRun;
    const ticketIds = createdReviewTickets(context);
    const before = await Promise.all(ticketIds.map((id) => context.client.ticket(id)));
    const targets = before.flatMap((view) =>
      view.reviews
        .filter((r) => r.slackTs !== null)
        .map((r) => ({ reviewId: r.id, slackTs: r.slackTs! })),
    );
    const requests = fuzzRequests(context, targets);
    const counts = new Map<number, number>();
    let transportErrors = 0;
    await pool(requests, S03_CONCURRENCY, async (request) => {
      try {
        const answer = await context.client.send(`POST ${INTERACTIVITY_PATH}`, INTERACTIVITY_PATH, {
          method: "POST",
          token: null,
          rawBody: { text: request.body, contentType: request.contentType },
          headers: request.headers,
        });
        counts.set(answer.status, (counts.get(answer.status) ?? 0) + 1);
      } catch (error) {
        if (!(error instanceof LiveTransportError)) throw error;
        transportErrors += 1;
      }
    });
    const statuses = [...counts.keys()].sort((x, y) => x - y);
    const serverErrors = statuses.filter((s) => s >= 500).reduce((n, s) => n + counts.get(s)!, 0);
    const failedChecks: string[] = [];
    if (serverErrors > 0) failedChecks.push("no-5xx");
    if (!statuses.every((s) => (S03_ALLOWED as readonly number[]).includes(s))) {
      failedChecks.push("allowed-statuses");
    }
    if (transportErrors > 0) failedChecks.push("no-transport-error");

    const after = await Promise.all(ticketIds.map((id) => context.client.ticket(id)));
    let changed = 0;
    before.forEach((view, i) => {
      for (const review of view.reviews) {
        const was = decisionOf(view, review.id);
        const now = decisionOf(after[i]!, review.id);
        const timedOut = was?.decision === null && now?.decision === "timeout";
        if (!timedOut && JSON.stringify(was) !== JSON.stringify(now)) changed += 1;
      }
    });
    if (changed > 0) failedChecks.push("reviews-unchanged");
    let healthStatus = 200;
    try {
      await context.client.health();
    } catch {
      healthStatus = 0;
      failedChecks.push("health-200");
    }
    return result(failedChecks, {
      requests: requests.length,
      statuses,
      statusCounts: statuses.map((s) => counts.get(s)!),
      serverErrors,
      transportErrors,
      reviewsChecked: targets.length,
      reviewsChanged: changed,
      // Run alone, the run has no reviews to compare: the check is reported as skipped.
      skippedChecks: targets.length === 0 ? ["reviews-unchanged"] : [],
      healthStatus,
      aiCallCount: 0,
    });
  },
};

/**
 * T4.S.04: staging refuses the e2e test secret. One decision for a fresh
 * random review ID, signed with the test secret, is POSTed with plain fetch
 * (no Access headers, no bearer token) to <STAGING_BASE_URL>/api/slack/interactivity
 * and must get 401. not_run without STAGING_BASE_URL.
 */
export const stagingRefusesScenario: Scenario = {
  id: "T4.S.04",
  async run(context) {
    if (context.config.stagingOrigin === undefined) {
      return { status: "not_run", evidence: { missing: ["STAGING_BASE_URL"] } };
    }
    const notRun = slackNotRun(context, SIGN);
    if (notRun) return notRun;
    const reviewId = randomUUID();
    const signed = signerOf(context).signedDecision({
      reviewId,
      slackTs: `${Math.floor(context.now() / 1000)}.000001`,
      decision: "approve",
    });
    const response = await context.fetch(
      new URL(INTERACTIVITY_PATH, context.config.stagingOrigin),
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", ...signed.headers },
        body: signed.body,
        redirect: "manual",
      },
    );
    await response.body?.cancel();
    return result(response.status === 401 ? [] : ["staging-401"], {
      status: response.status,
      reviewId,
      aiCallCount: 0,
    });
  },
};

export const reviewSecurityScenarios: readonly Scenario[] = [
  forgedDecisionScenario,
  markupScenario,
  fuzzScenario,
  stagingRefusesScenario,
];
