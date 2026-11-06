// Phase 4 live scenarios: the review flow (plan T4.L.01 to T4.L.04), and the
// shared steps the security and heavy scenarios reuse. Ticket text is
// synthetic and stays in request bodies: evidence carries IDs, the card ts,
// times in ms, counts and the sum of aiCallCount, never ticket text.
import { readFileSync } from "node:fs";
import {
  canaryTicketText,
  findCanaries,
  judgeDefinitionSchema,
  type InternalTicketView,
  type JudgeDefinition,
} from "@ai-it-support/shared";
import { LiveContractError } from "./client.ts";
import { missingSlackEnv, type SlackEnvName } from "./config.ts";
import { createJudgeClient } from "./judge.ts";
import { canaryRunId } from "./observability.ts";
import { ERIN, HR_COMPLAINT, POLL_MS, result } from "./pipeline.ts";
import type { Scenario, ScenarioContext, ScenarioResult } from "./runner.ts";
import { createE2eSlackChannel, type E2eSlackChannel, type SlackMessage } from "./slack-channel.ts";
import { createSlackSigner, type Decision, type SlackSigner } from "./slack-signer.ts";

/** A review ticket must show `review_pending` with a card ts within this time of its creation. */
export const REVIEW_LIMIT_MS = 60_000;
/**
 * After a decision is recorded, the view must show it within this time
 * (T4.L.02, T4.L.03, T4.S.01 b-approved, T4.F.01:finish). Seun 2026-11-06,
 * option A: the real Trigger.dev waitpoint resume takes about 7 s.
 */
export const DECISION_LIMIT_MS = 15_000;
export const DECISION_POLL_MS = 500;
/** No event may follow `review_decided` within this time (T4.L.03). */
export const QUIET_MS = 30_000;
/** An undecided review must reach `escalated_manual` within this time (e2e timeout 2m, T4.L.04). */
export const ESCALATION_LIMIT_MS = 240_000;
export const ESCALATION_POLL_MS = 5_000;
/** J4 (message clarity) must score the card at this value or more. */
export const J4_MIN_SCORE = 0.7;
export const HEADER_PREFIX = "Review needed: ";
/** Slack's header text limit; the card truncates the title to fit after the prefix. */
export const HEADER_MAX = 150;
export const ACTION_IDS = ["review_approve", "review_reject"] as const;
/** The start of the timeout note and of the timed-out card's line (P4-T2b). */
export const TIMEOUT_NOTE = "No decision within";

const J4_FILE = new URL("../../../evals/judges/J4.v1.json", import.meta.url);

/** Cut text to at most `max` code points, the last one an ellipsis (as `packages/slack`). */
export function truncate(text: string, max: number): string {
  const points = Array.from(text);
  return points.length <= max ? text : `${points.slice(0, max - 1).join("")}…`;
}

export type Review = InternalTicketView["reviews"][number];

export interface ReviewTicket {
  readonly ticketId: string;
  /** The last view read. */
  readonly view: InternalTicketView;
  /** The review with a card ts, once the ticket is `review_pending`; else undefined. */
  readonly review: Review | undefined;
  /** Time from creation to the first view with the review, or null. */
  readonly readyMs: number | null;
}

export interface ReviewTicketOptions {
  /** Number in the test ID, `<runId>:<scenarioId>:<n>` (default 1). */
  readonly n?: number;
  readonly title?: string;
  /** Replaces the HR complaint text (the HR complaint plus `extra` by default). */
  readonly description?: string;
  /** Text added after the HR complaint, on a new line. */
  readonly extra?: string;
  readonly testOverrides?: Record<string, unknown>;
}

// Ticket IDs each run created through createReviewTicket, so T4.S.03 can check
// them afterwards. Keyed by the run's one context object.
const createdTickets = new WeakMap<ScenarioContext, string[]>();

/** The tickets this run created through `createReviewTicket`, in order. */
export const createdReviewTickets = (context: ScenarioContext): readonly string[] =>
  createdTickets.get(context) ?? [];

/** The review that has a card, when the ticket is still at `review_pending` or later. */
export const cardReview = (view: InternalTicketView): Review | undefined =>
  view.reviews.find((review) => review.kind === "triage" && review.slackTs !== null);

/**
 * Creates one synthetic HR complaint from `demo.erin` on the test path (test
 * ID `<runId>:<scenarioId>:<n>`) and polls its view until it is
 * `review_pending` with a review that has a card ts, or 60 s pass.
 */
export async function createReviewTicket(
  context: ScenarioContext,
  scenarioId: string,
  options: ReviewTicketOptions = {},
): Promise<ReviewTicket> {
  const description =
    options.description ??
    (options.extra === undefined
      ? HR_COMPLAINT.description
      : `${HR_COMPLAINT.description}\n${options.extra}`);
  const start = context.now();
  const { ticketId } = await context.client.createTestTicket({
    ...ERIN,
    title: options.title ?? HR_COMPLAINT.title,
    description: `${description} (live run ${context.runId})`,
    testId: `${context.runId}:${scenarioId}:${options.n ?? 1}`,
    ...(options.testOverrides === undefined ? {} : { testOverrides: options.testOverrides }),
  });
  createdTickets.set(context, [...createdReviewTickets(context), ticketId]);
  for (;;) {
    const view = await context.client.ticket(ticketId);
    const review = cardReview(view);
    if (view.status === "review_pending" && review !== undefined) {
      return { ticketId, view, review, readyMs: context.now() - start };
    }
    if (view.status === "failed" || context.now() - start >= REVIEW_LIMIT_MS) {
      return { ticketId, view, review: undefined, readyMs: null };
    }
    await context.sleep(POLL_MS);
  }
}

/** The `not_run` result when a Slack variable is unset, else undefined. */
export function slackNotRun(
  context: ScenarioContext,
  names: readonly SlackEnvName[],
): ScenarioResult | undefined {
  const missing = missingSlackEnv(context.config, names);
  return missing.length > 0 ? { status: "not_run", evidence: { missing } } : undefined;
}

export const READ_SLACK: readonly SlackEnvName[] = ["E2E_SLACK_BOT_TOKEN", "E2E_SLACK_CHANNEL_ID"];
export const SIGN: readonly SlackEnvName[] = [
  "E2E_SLACK_SIGNING_SECRET",
  "E2E_SLACK_REVIEWER_ID",
  "E2E_SLACK_CHANNEL_ID",
];

export const slackOf = (context: ScenarioContext): E2eSlackChannel =>
  createE2eSlackChannel(context.config, context.fetch);
export const signerOf = (context: ScenarioContext): SlackSigner =>
  createSlackSigner(context.config, { client: context.client, now: context.now });

/** The top-level message with this ts in #itsupport-e2e history, or undefined. */
export async function findCard(
  slack: E2eSlackChannel,
  ts: string,
): Promise<SlackMessage | undefined> {
  const { channelId } = await slack.verify();
  const oldest = String(Math.max(0, Math.floor(Number(ts)) - 1));
  const messages = await slack.history(channelId, { oldest });
  return messages.find((message) => message.ts === ts);
}

/** Every Slack text object (`plain_text` or `mrkdwn`) in the blocks, depth first. */
export function textObjects(value: unknown): Array<{ type: string; text: string }> {
  if (Array.isArray(value)) return value.flatMap(textObjects);
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  const own =
    (record.type === "plain_text" || record.type === "mrkdwn") && typeof record.text === "string"
      ? [{ type: record.type, text: record.text }]
      : [];
  return [
    ...own,
    ...Object.entries(record)
      .filter(([key]) => key !== "type")
      .flatMap(([, child]) => textObjects(child)),
  ];
}

const blocksOf = (message: SlackMessage): Array<Record<string, unknown>> =>
  (message.blocks ?? []).filter(
    (block): block is Record<string, unknown> => typeof block === "object" && block !== null,
  );

export const hasActions = (message: SlackMessage): boolean =>
  blocksOf(message).some((block) => block.type === "actions");

/** The buttons of every actions block: action ID and value. */
export function buttons(message: SlackMessage): Array<{ actionId: unknown; value: unknown }> {
  return blocksOf(message)
    .filter((block) => block.type === "actions" && Array.isArray(block.elements))
    .flatMap((block) => block.elements as Array<Record<string, unknown>>)
    .filter((element) => element?.type === "button")
    .map((element) => ({ actionId: element.action_id, value: element.value }));
}

export function headerText(message: SlackMessage): string | undefined {
  const header = blocksOf(message).find((block) => block.type === "header");
  return textObjects(header?.text)[0]?.text;
}

/** The decided or timed-out card: no buttons, and the given words in its text. */
const isClosedCard = (message: SlackMessage | undefined, words: string): boolean =>
  message !== undefined && !hasActions(message) && JSON.stringify(message).includes(words);

/**
 * Re-reads the card until it is closed (no actions block, `words` in it) or
 * `limitMs` passes. Returns the last read.
 */
export async function waitForClosedCard(
  context: ScenarioContext,
  slack: E2eSlackChannel,
  ts: string,
  words: string,
  limitMs: number,
): Promise<SlackMessage | undefined> {
  const deadline = context.now() + limitMs;
  for (;;) {
    const card = await findCard(slack, ts);
    if (isClosedCard(card, words) || context.now() >= deadline) return card;
    await context.sleep(DECISION_POLL_MS);
  }
}

export interface DecisionOutcome {
  readonly status: number;
  readonly outcome: string | null;
  /** The last view read after the answer. */
  readonly view: InternalTicketView;
  /** Time from the answer to the first view with the expected status, or null. */
  readonly decidedMs: number | null;
}

const DECIDED_STATUS: Record<Decision, string> = { approve: "approved", reject: "rejected" };

/**
 * Signs and sends one decision as E2E_SLACK_REVIEWER_ID, then polls the view
 * every 500 ms until it shows the decision or 15 s pass after the answer.
 */
export async function decideAndWait(
  context: ScenarioContext,
  ticketId: string,
  review: { readonly id: string; readonly slackTs: string },
  decision: Decision,
): Promise<DecisionOutcome> {
  const signer = signerOf(context);
  const sent = await signer.send(
    signer.signedDecision({ reviewId: review.id, slackTs: review.slackTs, decision }),
  );
  const answeredAt = context.now();
  for (;;) {
    const view = await context.client.ticket(ticketId);
    const elapsed = context.now() - answeredAt;
    if (view.status === DECIDED_STATUS[decision] && elapsed <= DECISION_LIMIT_MS) {
      return { status: sent.status, outcome: sent.outcome, view, decidedMs: elapsed };
    }
    if (elapsed >= DECISION_LIMIT_MS) {
      return { status: sent.status, outcome: sent.outcome, view, decidedMs: null };
    }
    await context.sleep(DECISION_POLL_MS);
  }
}

const reviewOf = (view: InternalTicketView, id: string) => view.reviews.find((r) => r.id === id);
const ready = (ticket: ReviewTicket): ticket is ReviewTicket & { review: Review } =>
  ticket.review !== undefined;
const cardTs = (ticket: ReviewTicket & { review: Review }) => ticket.review.slackTs!;

/** Evidence every review scenario carries: IDs, the card ts, times and the AI calls. */
const baseEvidence = (ticket: ReviewTicket, view: InternalTicketView = ticket.view) => ({
  ticketId: ticket.ticketId,
  reviewId: ticket.review?.id ?? null,
  slackTs: ticket.review?.slackTs ?? null,
  status: view.status,
  readyMs: ticket.readyMs,
  aiCallCount: view.aiCallCount,
});

function loadJ4(): JudgeDefinition {
  return judgeDefinitionSchema.parse(JSON.parse(readFileSync(J4_FILE, "utf8")));
}

/** What J4 reads: the card's text objects, in block order, one per line. */
export const cardMessageText = (card: SlackMessage): string =>
  textObjects(card.blocks ?? [])
    .map((object) => object.text)
    .join("\n");

/**
 * T4.L.01: the HR complaint plus the run's 10 canaries gets a card in
 * #itsupport-e2e with the two buttons, the redacted title as header and no
 * canary anywhere in the message JSON; J4 scores the card's text at 0.7 or more.
 */
export const reviewCardScenario: Scenario = {
  id: "T4.L.01",
  async run(context) {
    const notRun = slackNotRun(context, READ_SLACK);
    if (notRun) return notRun;
    const canaryRun = canaryRunId(context.runId);
    const ticket = await createReviewTicket(context, "L01", { extra: canaryTicketText(canaryRun) });
    if (!ready(ticket)) return result(["review-pending"], baseEvidence(ticket));
    const slack = slackOf(context);
    const card = await findCard(slack, cardTs(ticket));
    if (card === undefined) return result(["card-in-history"], baseEvidence(ticket));

    const failedChecks: string[] = [];
    const found = buttons(card);
    const twoButtons =
      found.length === 2 &&
      ACTION_IDS.every((id) => found.some((b) => b.actionId === id)) &&
      found.every((b) => b.value === ticket.review.id);
    if (!twoButtons) failedChecks.push("two-buttons");
    const canaryHits = findCanaries(JSON.stringify(card), canaryRun).reduce(
      (sum, hit) => sum + hit.count,
      0,
    );
    if (canaryHits > 0) failedChecks.push("no-canaries");
    const title = ticket.view.redacted?.title;
    const header = headerText(card);
    if (
      title === undefined ||
      header !== HEADER_PREFIX + truncate(title, HEADER_MAX - HEADER_PREFIX.length)
    ) {
      failedChecks.push("header-redacted-title");
    }
    // Leaked text never goes to TypeSafe: with a canary on the card, J4 is skipped.
    let judgeStatus = "skipped";
    let judgeHttpStatus: number | null = null;
    let judgeScore: number | null = null;
    if (canaryHits === 0) {
      try {
        const judged = await createJudgeClient(context.client, {
          now: context.now,
          sleep: context.sleep,
        }).judge(loadJ4(), {
          message: cardMessageText(card),
          reader: "a reviewer who must approve or reject an IT support ticket",
        });
        judgeStatus = judged.status;
        if (judged.status === "completed") judgeScore = judged.value;
      } catch (error) {
        // The judgments route refuses text redact() would change (422 unredacted_input).
        if (!(error instanceof LiveContractError)) throw error;
        judgeStatus = "refused";
        judgeHttpStatus = error.status;
      }
      if (judgeScore === null || judgeScore < J4_MIN_SCORE) failedChecks.push("j4-score");
    }
    return result(failedChecks, {
      ...baseEvidence(ticket),
      buttons: found.length,
      canaryHits,
      judgeStatus,
      judgeHttpStatus,
      judgeScore,
    });
  },
};

/** T4.L.02 and T4.L.03: a signed decision is recorded, shown in the view and on the card. */
function decisionScenario(id: string, decision: Decision): Scenario {
  const words = decision === "approve" ? "Approved" : "Rejected";
  return {
    id,
    async run(context) {
      const notRun = slackNotRun(context, [...READ_SLACK, ...SIGN]);
      if (notRun) return notRun;
      const ticket = await createReviewTicket(context, id === "T4.L.02" ? "L02" : "L03");
      if (!ready(ticket)) return result(["review-pending"], baseEvidence(ticket));
      const decided = await decideAndWait(
        context,
        ticket.ticketId,
        { id: ticket.review.id, slackTs: cardTs(ticket) },
        decision,
      );
      const failedChecks: string[] = [];
      if (decided.status !== 200 || decided.outcome !== "recorded") failedChecks.push("recorded");
      if (decided.decidedMs === null) failedChecks.push("decided-within-limit");
      const stored = reviewOf(decided.view, ticket.review.id);
      if (stored?.decision !== decision) failedChecks.push("review-decision");
      if (stored?.decidedBy !== context.config.slack.reviewerId) failedChecks.push("decided-by");
      const card = await waitForClosedCard(
        context,
        slackOf(context),
        cardTs(ticket),
        words,
        DECISION_LIMIT_MS,
      );
      if (card === undefined || hasActions(card)) failedChecks.push("card-no-buttons");
      if (card === undefined || !JSON.stringify(card).includes(words)) {
        failedChecks.push("card-names-decision");
      }

      let eventsAfter: number | null = null;
      if (decision === "reject") {
        // T4.L.03: nothing follows review_decided for 30 s.
        const decidedEvent = decided.view.events.find((e) => e.type === "review_decided");
        if (decidedEvent === undefined) {
          failedChecks.push("review-decided-event");
        } else {
          const wait = Date.parse(decidedEvent.at) + QUIET_MS - context.now();
          if (wait > 0) await context.sleep(wait);
          const later = await context.client.ticket(ticket.ticketId);
          const index = later.events.findIndex((e) => e.type === "review_decided");
          eventsAfter = later.events.length - index - 1;
          if (eventsAfter !== 0) failedChecks.push("no-event-after-decision");
          if (later.status !== "rejected") failedChecks.push("still-rejected");
        }
      }
      return result(failedChecks, {
        ...baseEvidence(ticket, decided.view),
        responseStatus: decided.status,
        decidedMs: decided.decidedMs,
        ...(eventsAfter === null ? {} : { eventsAfter }),
      });
    },
  };
}

export const approveScenario = decisionScenario("T4.L.02", "approve");
export const rejectScenario = decisionScenario("T4.L.03", "reject");

/**
 * T4.L.04: with no decision the ticket reaches `escalated_manual` within
 * 4 minutes, the review's decision is `timeout`, a thread reply under the card
 * holds the note, and the card has no buttons.
 */
export const timeoutScenario: Scenario = {
  id: "T4.L.04",
  async run(context) {
    const notRun = slackNotRun(context, READ_SLACK);
    if (notRun) return notRun;
    const ticket = await createReviewTicket(context, "L04");
    if (!ready(ticket)) return result(["review-pending"], baseEvidence(ticket));
    const start = context.now();
    let view = ticket.view;
    while (view.status !== "escalated_manual" && context.now() - start < ESCALATION_LIMIT_MS) {
      await context.sleep(ESCALATION_POLL_MS);
      view = await context.client.ticket(ticket.ticketId);
    }
    const failedChecks: string[] = [];
    const escalated = view.status === "escalated_manual";
    const escalatedMs = escalated ? context.now() - start : null;
    if (!escalated) failedChecks.push("escalated-manual");
    if (reviewOf(view, ticket.review.id)?.decision !== "timeout") {
      failedChecks.push("decision-timeout");
    }
    const slack = slackOf(context);
    const { channelId } = await slack.verify();
    const ts = cardTs(ticket);
    const thread = await slack.replies(channelId, ts);
    const notes = thread.filter((m) => m.ts !== ts && m.text.includes(TIMEOUT_NOTE)).length;
    if (notes === 0) failedChecks.push("thread-note");
    // The task sets escalated_manual before it updates the card, so wait for the update.
    const card = await waitForClosedCard(context, slack, ts, TIMEOUT_NOTE, DECISION_LIMIT_MS);
    if (card === undefined || hasActions(card)) failedChecks.push("card-no-buttons");
    return result(failedChecks, {
      ...baseEvidence(ticket, view),
      escalatedMs,
      threadNotes: notes,
    });
  },
};

export const reviewFlowScenarios: readonly Scenario[] = [
  reviewCardScenario,
  approveScenario,
  rejectScenario,
  timeoutScenario,
];
