// A mock of the e2e review flow (test support only): an `override` for
// startMockE2e that moves test tickets through redacted → triaged →
// review_pending on the mock clock, posts the card to the mock Slack API,
// answers POST /api/slack/interactivity like the app (verify, parse,
// allow-list, review, binding, decide), times reviews out with a thread note,
// and serves the ticket views and `slack` security events.
import { randomUUID } from "node:crypto";
import { redact } from "@ai-it-support/shared";
import { truncate } from "../review-flow.ts";
import type { MockReply, MockRequest } from "./mock-e2e.ts";
import type { MockSlack } from "./mock-slack.ts";

/** Ways the mock can misbehave, so each scenario's negative cases can be shown. */
export interface MockReviewFaults {
  /** The review gets a card ts, but the card is never posted. */
  readonly hideCard?: (testId: string) => boolean;
  /** Changes the review card before it is posted. */
  readonly editCard?: (testId: string, card: MockCard) => MockCard;
  /** policy_decided → review_requested, in ms (default 1 000). */
  readonly reviewAfterMs?: (testId: string) => number;
  /**
   * The review_requested event follows the card ts by this many ms (default 0).
   * The real task stores the card ts first and writes the event afterwards.
   */
  readonly requestedEventLagMs?: number;
  /** review_decided and the status follow a recorded decision after this many ms (default 500). */
  readonly decisionDelayMs?: number;
  /** Stored as the decider instead of the clicking user. */
  readonly decidedBy?: string;
  /** The card is not updated after a decision or a timeout. */
  readonly keepButtons?: boolean;
  /** One more event 1 s after review_decided. */
  readonly eventAfterDecision?: boolean;
  /** Reviews never time out. */
  readonly noTimeout?: boolean;
  /** A timeout posts no thread note. */
  readonly noTimeoutNote?: boolean;
  /** Bad or stale signatures are accepted. */
  readonly acceptForged?: boolean;
  /** A second decision on a decided review is recorded again (a new decidedAt, a second review_decided). */
  readonly replayChanges?: boolean;
  /** Security event kinds that are never recorded. */
  readonly dropKinds?: readonly string[];
  /** Any user may decide (no allow-list). */
  readonly allowAnyUser?: boolean;
  /** The payload's channel and message ts are not checked against the review. */
  readonly skipBinding?: boolean;
  /** The nth (1-based) interactivity request answers 500. */
  readonly fail500?: (n: number) => boolean;
}

export interface MockCard {
  readonly text: string;
  readonly blocks: unknown[];
}

export interface MockReviewOptions {
  readonly now: () => number;
  readonly slack: MockSlack;
  readonly channelId: string;
  readonly botUserId: string;
  readonly reviewerIds: readonly string[];
  /** The e2e review timeout (default 2 minutes) for tickets without `reviewTimeout`. */
  readonly timeoutMs?: number;
  readonly faults?: MockReviewFaults;
}

interface MockReviewRow {
  readonly id: string;
  readonly createdAt: number;
  slackTs: string;
  decision: "approve" | "reject" | "timeout" | null;
  decidedBy: string | null;
  decidedAt: number | null;
}

export interface MockReviewTicket {
  readonly number: string;
  readonly testId: string;
  readonly id: string;
  readonly createdAt: number;
  readonly title: string;
  readonly description: string;
  readonly timeoutLabel: string;
  readonly timeoutMs: number;
  status: string;
  events: Array<{ type: string; at: number }>;
  review: MockReviewRow | null;
  /** The timed-out card update is done (it follows the status by CARD_LAG_MS). */
  timeoutCardDone: boolean;
  /** A recorded decision whose status, event and card update are still to come. */
  pending: { decision: "approve" | "reject"; at: number } | null;
  /** When the review_requested event is still to be written (requestedEventLagMs). */
  requestedEventAt: number | null;
}

export interface MockReview {
  readonly override: (request: MockRequest) => MockReply | undefined;
  /** Tickets by test ID. */
  readonly tickets: Map<string, MockReviewTicket>;
  readonly securityEvents: Array<{
    source: string;
    kind: string;
    windowStart: string;
    count: number;
  }>;
  /** Interactivity requests answered (behind Access). */
  interactivityRequests(): number;
  /** Moves the tickets on to the mock clock's time (the pipeline runs without being asked). */
  tick(): void;
}

const INTERACTIVITY = "/api/slack/interactivity";
const MAX_BODY = 128 * 1024;
const NO_STORE = { "Cache-Control": "no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const iso = (ms: number) => new Date(ms).toISOString();
const plain = (text: string) => ({ type: "plain_text", text, emoji: false });
const escape = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

function reviewCard(ticket: MockReviewTicket, reviewId: string): MockCard {
  const title = truncate(ticket.title, 150 - "Review needed: ".length);
  const button = (label: string, actionId: string) => ({
    type: "button",
    text: plain(label),
    action_id: actionId,
    value: reviewId,
  });
  return {
    text: `Review needed: ${escape(title)}`,
    blocks: [
      { type: "header", text: plain(`Review needed: ${title}`) },
      { type: "section", text: plain("Why: sensitive topic (HR)") },
      // Like packages/slack: the open card holds plain_text objects only.
      { type: "section", text: plain("Category: software · Priority: P3") },
      { type: "section", text: plain(`Ticket (redacted)\n${truncate(ticket.description, 600)}`) },
      {
        type: "actions",
        elements: [button("Approve", "review_approve"), button("Reject", "review_reject")],
      },
      {
        type: "context",
        elements: [
          plain(
            `Ticket ${ticket.id.slice(0, 8)} · e2e · decide within ${ticket.timeoutLabel}, then it goes to the manual queue`,
          ),
        ],
      },
    ],
  };
}

/** Like the review-ticket task: the status is written first, the card update follows. */
export const CARD_LAG_MS = 1_000;
/** Default time from a recorded click to review_decided and the status (the woken run). */
export const DECISION_LAG_MS = 500;

const timeoutSentence = (label: string) => `No decision within ${label}: sent to the manual queue`;

export function createMockReview(options: MockReviewOptions): MockReview {
  const { now, slack, faults = {} } = options;
  const tickets = new Map<string, MockReviewTicket>();
  const securityEvents: MockReview["securityEvents"] = [];
  let interactivity = 0;
  let seq = 1;

  const ticketById = (id: string) => [...tickets.values()].find((t) => t.id === id);
  const cardOf = (ticket: MockReviewTicket) =>
    ticket.review === null
      ? undefined
      : slack.messages.find((m) => m.ts === ticket.review!.slackTs);

  function record(kind: string): void {
    if (faults.dropKinds?.includes(kind)) return;
    const windowStart = iso(Math.floor(now() / 60_000) * 60_000);
    const row = securityEvents.find((e) => e.kind === kind && e.windowStart === windowStart);
    if (row) row.count += 1;
    else securityEvents.push({ source: "slack", kind, windowStart, count: 1 });
  }

  function replaceCard(ticket: MockReviewTicket, card: MockCard): void {
    const message = cardOf(ticket);
    if (message === undefined) return;
    message.text = card.text;
    message.blocks = card.blocks;
  }

  function closedCard(ticket: MockReviewTicket, line: Record<string, unknown>, prefix: string) {
    const title = truncate(ticket.title, 150 - prefix.length);
    return {
      text: `${prefix}${escape(title)}`,
      blocks: [
        { type: "header", text: plain(`${prefix}${title}`) },
        { type: "context", elements: [line] },
      ],
    };
  }

  /** Moves every ticket on to time `at`, writing each step at its own scheduled time. */
  function advance(at: number): void {
    for (const t of tickets.values()) {
      const redactedAt = t.createdAt + 1_000;
      const triagedAt = t.createdAt + 5_000;
      const requestedAt = triagedAt + (faults.reviewAfterMs?.(t.testId) ?? 1_000);
      if (t.status === "new" && at >= redactedAt) {
        t.status = "redacted";
        t.events.push({ type: "redacted", at: redactedAt });
      }
      if (t.status === "redacted" && at >= triagedAt) {
        t.status = "triaged";
        t.events.push(
          { type: "policy_decided", at: triagedAt },
          { type: "triaged", at: triagedAt },
        );
      }
      if (t.status === "triaged" && at >= requestedAt) {
        const id = randomUUID();
        const slackTs = `${Math.floor(requestedAt / 1000)}.${String(seq++).padStart(6, "0")}`;
        t.review = {
          id,
          createdAt: requestedAt,
          slackTs,
          decision: null,
          decidedBy: null,
          decidedAt: null,
        };
        if (faults.hideCard?.(t.testId) !== true) {
          const base = reviewCard(t, id);
          const card = faults.editCard ? faults.editCard(t.testId, base) : base;
          slack.messages.push({
            ts: slackTs,
            user: options.botUserId,
            bot_id: "B0000000000",
            text: card.text,
            blocks: card.blocks,
          });
        }
        t.status = "review_pending";
        t.requestedEventAt = requestedAt + (faults.requestedEventLagMs ?? 0);
      }
      if (t.requestedEventAt !== null && at >= t.requestedEventAt) {
        t.events.push({ type: "review_requested", at: t.requestedEventAt });
        t.requestedEventAt = null;
      }
      if (t.status === "review_pending" && t.pending !== null && at >= t.pending.at) {
        const { decision, at: decidedAt } = t.pending;
        t.events.push({ type: "review_decided", at: decidedAt });
        t.status = decision === "approve" ? "approved" : "rejected";
        if (faults.keepButtons !== true) {
          const words = decision === "approve" ? "Approved" : "Rejected";
          const by = t.review!.decidedBy!;
          replaceCard(
            t,
            closedCard(
              t,
              { type: "mrkdwn", text: `${words} by <@${by}> at ${iso(decidedAt)}` },
              "Reviewed: ",
            ),
          );
        }
        t.pending = null;
      }
      const decidedEvent = t.events.find((e) => e.type === "review_decided");
      if (
        faults.eventAfterDecision === true &&
        decidedEvent !== undefined &&
        at >= decidedEvent.at + 1_000 &&
        !t.events.some((e) => e.type === "notification_queued")
      ) {
        t.events.push({ type: "notification_queued", at: decidedEvent.at + 1_000 });
      }
      const timeoutAt = requestedAt + t.timeoutMs;
      if (
        t.status === "review_pending" &&
        t.review !== null &&
        t.review.decision === null &&
        faults.noTimeout !== true &&
        at >= timeoutAt
      ) {
        t.review.decision = "timeout";
        t.review.decidedAt = timeoutAt;
        if (faults.noTimeoutNote !== true) {
          slack.messages.push({
            ts: `${Math.floor(timeoutAt / 1000)}.${String(seq++).padStart(6, "0")}`,
            user: options.botUserId,
            bot_id: "B0000000000",
            text: timeoutSentence(t.timeoutLabel),
            thread_ts: t.review.slackTs,
          });
        }
        t.events.push({ type: "review_timed_out", at: timeoutAt });
        t.status = "escalated_manual";
      }
      if (
        t.status === "escalated_manual" &&
        !t.timeoutCardDone &&
        faults.keepButtons !== true &&
        at >= timeoutAt + CARD_LAG_MS
      ) {
        t.timeoutCardDone = true;
        replaceCard(t, closedCard(t, plain(timeoutSentence(t.timeoutLabel)), "Review timed out: "));
      }
    }
  }

  function create(body: Record<string, unknown>): MockReply {
    const testId = typeof body.testId === "string" ? body.testId : "";
    const existing = tickets.get(testId);
    if (existing)
      return {
        status: 201,
        json: {
          ticketId: existing.id,
          ticketNumber: existing.number,
          queued: true,
          duplicate: true,
        },
      };
    const overrides = body.testOverrides as { reviewTimeout?: unknown } | undefined;
    const label = typeof overrides?.reviewTimeout === "string" ? overrides.reviewTimeout : "2m";
    const ticket: MockReviewTicket = {
      testId,
      number: `ITS-${String(tickets.size + 1).padStart(6, "0")}`,
      id: randomUUID(),
      createdAt: now(),
      title: redact(String(body.title)).text,
      description: redact(String(body.description)).text,
      timeoutLabel: label,
      timeoutMs:
        label === "2m" && options.timeoutMs !== undefined
          ? options.timeoutMs
          : Number.parseInt(label, 10) * 60_000,
      status: "new",
      events: [],
      review: null,
      timeoutCardDone: false,
      pending: null,
      requestedEventAt: null,
    };
    tickets.set(testId, ticket);
    return {
      status: 201,
      json: { ticketId: ticket.id, ticketNumber: ticket.number, queued: true },
    };
  }

  function view(t: MockReviewTicket) {
    const triaged = t.events.some((e) => e.type === "triaged");
    return {
      id: t.id,
      number: t.number,
      status: t.status,
      isTest: true,
      source: "web",
      createdAt: iso(t.createdAt),
      redacted: t.status === "new" ? null : { title: t.title, description: t.description },
      triage: triaged
        ? {
            sensitive: true,
            sensitiveFlags: ["hr"],
            category: "software",
            subcategory: null,
            priority: "P3",
            urgency: "medium",
            assignmentGroup: "Software",
            route: "review",
            flags: [],
            probabilities: null,
            groundingScore: null,
            kbArticleIds: [],
            suggestedFix: null,
            modelVersions: null,
            triagedAt: iso(t.createdAt + 5_000),
          }
        : null,
      aiCallCount: triaged ? 2 : 0,
      events: t.events.map((e) => ({ type: e.type, at: iso(e.at) })),
      reviews:
        t.review === null
          ? []
          : [
              {
                id: t.review.id,
                kind: "triage",
                decision: t.review.decision,
                decidedBy: t.review.decidedBy,
                decidedAt: t.review.decidedAt === null ? null : iso(t.review.decidedAt),
                slackTs: t.review.slackTs,
                createdAt: iso(t.review.createdAt),
              },
            ],
      notifications: [],
      autofix: [],
    };
  }

  const refuse = (status: number, error: string, kind?: string): MockReply => {
    if (kind !== undefined) record(kind);
    return { status, json: { error }, headers: NO_STORE };
  };

  function interact(request: MockRequest, at: number): MockReply {
    interactivity += 1;
    if (faults.fail500?.(interactivity) === true) return refuse(500, "internal_error");
    if (Buffer.byteLength(request.body) > MAX_BODY)
      return refuse(413, "too_large", "body_too_large");
    if (faults.acceptForged !== true && (request.slack === null || !request.slack.ok)) {
      return refuse(
        401,
        "unauthorized",
        request.slack?.ok === false ? request.slack.reason : "missing_signature",
      );
    }
    interface Payload {
      type?: unknown;
      actions?: unknown;
      user?: { id?: unknown };
      channel?: { id?: unknown };
      container?: { message_ts?: unknown };
    }
    let payload: Payload | undefined;
    try {
      payload = JSON.parse(new URLSearchParams(request.body).get("payload") ?? "") as Payload;
    } catch {
      payload = undefined;
    }
    const actions = payload?.actions;
    const action =
      Array.isArray(actions) && actions.length === 1
        ? (actions[0] as { action_id?: unknown; value?: unknown } | undefined)
        : undefined;
    const decision =
      action?.action_id === "review_approve"
        ? "approve"
        : action?.action_id === "review_reject"
          ? "reject"
          : undefined;
    const userId = payload?.user?.id;
    if (
      payload?.type !== "block_actions" ||
      decision === undefined ||
      typeof action?.value !== "string" ||
      !UUID.test(action.value) ||
      typeof userId !== "string"
    ) {
      return refuse(400, "bad_payload", "bad_payload");
    }
    if (faults.allowAnyUser !== true && !options.reviewerIds.includes(userId))
      return refuse(403, "forbidden", "not_allow_listed");
    const reviewId = action.value;
    const ticket = [...tickets.values()].find((t) => t.review?.id === reviewId);
    if (ticket === undefined) return refuse(404, "not_found", "unknown_review");
    const review = ticket.review!;
    if (
      faults.skipBinding !== true &&
      (payload?.channel?.id !== options.channelId ||
        payload?.container?.message_ts !== review.slackTs)
    ) {
      return refuse(403, "forbidden", "binding_mismatch");
    }
    if (review.decision === "timeout")
      return { status: 200, json: { outcome: "late" }, headers: NO_STORE };
    if (review.decision !== null && faults.replayChanges !== true) {
      return { status: 200, json: { outcome: "already_decided" }, headers: NO_STORE };
    }
    if (review.decision !== null) ticket.events.push({ type: "review_decided", at });
    review.decision = decision;
    review.decidedBy = faults.decidedBy ?? userId;
    review.decidedAt = at;
    if (ticket.status === "review_pending") {
      ticket.pending = { decision, at: at + (faults.decisionDelayMs ?? DECISION_LAG_MS) };
    }
    return { status: 200, json: { outcome: "recorded" }, headers: NO_STORE };
  }

  function override(request: MockRequest): MockReply | undefined {
    const at = now();
    advance(at);
    if (request.path === INTERACTIVITY && request.method === "POST" && request.accessOk) {
      return interact(request, at);
    }
    if (!request.accessOk || !request.bearerOk) return undefined;
    if (request.method === "POST" && request.path === "/api/internal/test-tickets") {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(request.body) as Record<string, unknown>;
      } catch {
        return { status: 400, json: { error: "invalid_body" } };
      }
      return create(body);
    }
    const match = /^\/api\/internal\/tickets\/([^/]+)$/.exec(request.path);
    const ticket = match ? ticketById(match[1]!) : undefined;
    if (request.method === "GET" && ticket) return { status: 200, json: view(ticket) };
    if (request.method === "GET" && request.path === "/api/internal/security-events") {
      const since = Date.parse(request.query.get("since") ?? "");
      if (Number.isNaN(since)) return { status: 400, json: { error: "invalid_since" } };
      return {
        status: 200,
        json: {
          events: securityEvents
            .filter((e) => Date.parse(e.windowStart) >= since)
            .map((e) => ({ ...e })),
        },
      };
    }
    return undefined;
  }

  return {
    override,
    tickets,
    securityEvents,
    interactivityRequests: () => interactivity,
    tick: () => advance(now()),
  };
}
