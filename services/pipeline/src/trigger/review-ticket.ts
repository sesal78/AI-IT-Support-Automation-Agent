import { errorClassName, type AlertFn } from "@ai-it-support/ai";
import {
  createDbClient,
  createRepositories,
  dbEnvShape,
  type Repositories,
  type Review,
  type Ticket,
  type Triage,
} from "@ai-it-support/db";
import {
  REVIEW_TICKET_TASK_ID,
  e2eEnvShape,
  effectiveTestOverrides,
  parseEnv,
  reviewEnvShape,
  slackClientEnvShape,
  testOverridesSchema,
  type ReviewTicketPayload,
} from "@ai-it-support/shared";
import {
  buildReviewCard,
  createSlackClient,
  type ReviewEnvironment,
  type SlackClient,
} from "@ai-it-support/slack";
import { AbortTaskRunError, logger, schemaTask, wait } from "@trigger.dev/sdk";
import { z } from "zod";
import { createPipelineAlert } from "../pipeline-alert.js";

// Payload type is shared with the caller that triggers it (packages/shared).
export const reviewTicketPayload = z.object({
  ticketId: z.uuid(),
  testOverrides: testOverridesSchema.optional(),
}) satisfies z.ZodType<ReviewTicketPayload>;

export type { ReviewTicketPayload };

export type ReviewTicketResult = { ticketId: string; skipped: boolean };

type LogFn = (message: string, data?: Record<string, unknown>) => void;

/** The Trigger.dev wait functions the task uses; replaced in tests. */
export interface ReviewWait {
  createToken(options: {
    timeout: string;
    idempotencyKey: string;
    tags: string[];
  }): Promise<{ id: string; url: string; publicAccessToken: string }>;
  forToken(tokenId: string): Promise<unknown>;
}

export interface ReviewDeps {
  repos: Pick<
    Repositories,
    | "getTicket"
    | "getTriage"
    | "setTicketStatus"
    | "createTriageReview"
    | "getRedaction"
    | "getKbArticlesByIds"
    | "setReviewSlackTs"
    | "listEventTypes"
    | "addEvent"
  >;
  slack: Pick<SlackClient, "postMessage">;
  wait: ReviewWait;
  /** SLACK_CHANNEL_ID: the review channel. */
  channelId: string;
  environment: ReviewEnvironment;
  /** SLACK_REVIEW_TIMEOUT. */
  reviewTimeout: string;
  /** E2E_MODE: test switches take effect only with it AND the ticket's is_test. */
  e2eMode: boolean;
  /** Never throws (createAlertSink). */
  alert: AlertFn;
  logger: { info: LogFn; warn: LogFn; error: LogFn };
}

const reviewDepsEnvShape = {
  ...dbEnvShape,
  ...slackClientEnvShape,
  ...reviewEnvShape,
  ...e2eEnvShape,
};

/** Validates env and builds the real deps. Invalid variables throw, naming the variable. */
export function createReviewDeps(source: Record<string, string | undefined>): ReviewDeps {
  const env = parseEnv(reviewDepsEnvShape, source);
  const repos = createRepositories(createDbClient(source));
  return {
    repos,
    slack: createSlackClient({ token: env.SLACK_BOT_TOKEN }),
    wait: {
      createToken: (options) => wait.createToken(options),
      forToken: (tokenId) => wait.forToken(tokenId),
    },
    channelId: env.SLACK_CHANNEL_ID,
    environment: env.E2E_MODE ? "e2e" : "staging",
    reviewTimeout: env.SLACK_REVIEW_TIMEOUT,
    e2eMode: env.E2E_MODE,
    alert: createPipelineAlert(source, repos),
    logger,
  };
}

/** Statuses after the review: a run on one of them is a no-op. */
const DONE: ReadonlySet<string> = new Set(["approved", "rejected", "escalated_manual", "failed"]);

const fixStepsSchema = z.object({ steps: z.array(z.string()), caveats: z.array(z.string()) });

/**
 * The task body, exported so tests can call it without the Trigger.dev runtime.
 *
 * Order: load the ticket and its triage row; `review_pending`; the wait token
 * (key `review:<ticketId>`, so a retried attempt gets the same token); the
 * review row (an existing row is returned unchanged, with its own token).
 * While the row has no `slack_ts`: the card is built from the redaction, the
 * triage row and the KB titles, posted, and its ts stored; the full fix steps
 * go to its thread (best effort). Then the event `review_requested` (once),
 * and the wait on the row's token. A failed card post throws before the event,
 * so the next attempt posts again.
 *
 * Privacy: only redacted text reaches Slack. Events and logs carry IDs and
 * class names only; the token's url and publicAccessToken are never kept.
 *
 * Until P4-T4b the run returns after the wait without changing the status.
 */
export async function runReviewTicket(
  payload: ReviewTicketPayload,
  deps: ReviewDeps,
  attempt = 1,
): Promise<ReviewTicketResult> {
  const { ticketId } = payload;
  const { repos, logger: log } = deps;

  const ticket = await repos.getTicket(ticketId);
  if (!ticket) throw new AbortTaskRunError(`review-ticket: ticket ${ticketId} not found`);
  if (DONE.has(ticket.status)) {
    log.info("review-ticket: skipped", { ticketId, status: ticket.status });
    return { ticketId, skipped: true };
  }
  if (ticket.status !== "triaged" && ticket.status !== "review_pending") {
    throw new AbortTaskRunError(`review-ticket: ticket ${ticketId} is not triaged`);
  }
  const triage = await repos.getTriage(ticketId);
  if (triage?.route !== "review") {
    throw new AbortTaskRunError(`review-ticket: ticket ${ticketId} is not routed to review`);
  }

  await repos.setTicketStatus(ticketId, "review_pending");
  const timeout = reviewTimeout(payload, ticket, deps);
  const token = await deps.wait.createToken({
    timeout,
    idempotencyKey: `review:${ticketId}`,
    tags: [`ticket:${ticketId}`],
  });
  const review = await repos.createTriageReview({ ticketId, waitTokenId: token.id });

  if (review.slack_ts === null) await postCard(deps, ticket, triage, review, timeout);

  const written = await repos.listEventTypes(ticketId, ["review_requested"]);
  if (!written.includes("review_requested")) {
    await repos.addEvent(ticketId, "review_requested", { reviewId: review.id });
  }
  log.info("review-ticket: waiting", { ticketId, reviewId: review.id, attempt, timeout });
  await deps.wait.forToken(review.wait_token_id);
  return { ticketId, skipped: false };
}

/** The `reviewTimeout` switch when it applies (E2E mode and a test ticket), else the env value. */
function reviewTimeout(payload: ReviewTicketPayload, ticket: Ticket, deps: ReviewDeps): string {
  const overrides = effectiveTestOverrides({
    e2eMode: deps.e2eMode,
    isTest: ticket.is_test,
    requested: payload.testOverrides,
  });
  return overrides.reviewTimeout ?? deps.reviewTimeout;
}

async function postCard(
  deps: ReviewDeps,
  ticket: Ticket,
  triage: Triage,
  review: Review,
  timeout: string,
): Promise<void> {
  const { repos } = deps;
  const ticketId = ticket.id;
  const redaction = await repos.getRedaction(ticketId);
  if (!redaction) throw new AbortTaskRunError(`review-ticket: ticket ${ticketId} has no redaction`);
  const articles = await repos.getKbArticlesByIds(triage.kb_article_ids ?? []);
  const fix = triage.suggested_fix === null ? null : fixStepsSchema.safeParse(triage.suggested_fix);
  if (fix !== null && !fix.success) {
    throw new Error("review-ticket: the saved fix steps have an unexpected shape");
  }
  const card = buildReviewCard({
    reviewId: review.id,
    ticketId,
    environment: deps.environment,
    timeout,
    redactedTitle: redaction.redacted_title,
    redactedDescription: redaction.redacted_description,
    category: triage.category,
    priority: triage.priority,
    urgency: triage.urgency,
    assignmentGroup: triage.assignment_group,
    // Policy reasons are not stored; the card names the stored flags instead.
    reasons: triage.sensitive ? ["sensitive"] : [],
    flags: [...(triage.flags ?? []), ...triage.sensitive_flags],
    kbArticles: articles.map((a) => ({ title: a.title, slug: a.slug })),
    fixSteps: fix === null ? null : fix.data,
  });
  const { ts } = await deps.slack.postMessage({
    channel: deps.channelId,
    text: card.text,
    blocks: card.blocks,
  });
  await repos.setReviewSlackTs(review.id, ts);
  if (card.threadSteps === null) return;
  try {
    await deps.slack.postMessage({ channel: deps.channelId, threadTs: ts, ...card.threadSteps });
  } catch (error) {
    deps.logger.error("review-ticket: thread reply failed", {
      ticketId,
      reviewId: review.id,
      error: errorClassName(error),
    });
    await deps.alert("slack_update_failed", { ticketId });
  }
}

/**
 * Posts a ticket's review card to Slack and waits for a decision. Nothing
 * triggers it until P4-T4c. Env is validated at the start of each run.
 */
export const reviewTicket = schemaTask({
  id: REVIEW_TICKET_TASK_ID,
  schema: reviewTicketPayload,
  run: async (payload, { ctx }) =>
    runReviewTicket(payload, createReviewDeps(process.env), ctx.attempt.number),
});
