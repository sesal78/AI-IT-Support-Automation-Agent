import { errorClassName, type AlertFn } from "@ai-it-support/ai";
import {
  createDbClient,
  createRepositories,
  dbEnvShape,
  type Repositories,
  type Review,
  type ReviewDecision,
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
  buildDecidedCard,
  buildReviewCard,
  buildTimedOutCard,
  buildTimeoutNote,
  createSlackClient,
  type CardMessage,
  type ReviewCardInput,
  type ReviewEnvironment,
  type SlackClient,
} from "@ai-it-support/slack";
import { AbortTaskRunError, logger, schemaTask, wait } from "@trigger.dev/sdk";
import { z } from "zod";
import { createFailureAlert, createPipelineAlert } from "../pipeline-alert.js";

// Payload type is shared with the caller that triggers it (packages/shared).
export const reviewTicketPayload = z.object({
  ticketId: z.uuid(),
  testOverrides: testOverridesSchema.optional(),
}) satisfies z.ZodType<ReviewTicketPayload>;

export type { ReviewTicketPayload };

export type ReviewTicketResult =
  | { ticketId: string; skipped: true }
  | { ticketId: string; skipped: false; decision: ReviewDecision };

type LogFn = (message: string, data?: Record<string, unknown>) => void;

/** The Trigger.dev wait functions the task uses; replaced in tests. */
export interface ReviewWait {
  createToken(options: {
    timeout: string;
    idempotencyKey: string;
    tags: string[];
  }): Promise<{ id: string; url: string; publicAccessToken: string }>;
  /** `ok` is false when the token timed out. The output is never read. */
  forToken(tokenId: string): Promise<{ ok: boolean }>;
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
    | "getReview"
    | "decideReview"
    | "listEventTypes"
    | "addEvent"
  >;
  slack: Pick<SlackClient, "postMessage" | "updateMessage">;
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
 * After the wait the review row decides; the token's output is ignored.
 * `approve` / `reject`: the event review_decided (once), the status
 * `approved` / `rejected`, then the decided card (best effort). A timed-out
 * token on an undecided row stores `timeout` (compare-and-set: a decision
 * stored at the last moment wins and takes the path above). A `timeout`:
 * the thread note, the event review_timed_out (both once), the status
 * `escalated_manual`, then the timed-out card (best effort). The note comes
 * before the status, so a failed note is posted by the next attempt. A token
 * that completed on an undecided row aborts and writes nothing. Nothing is
 * triggered after a decision in phase 4.
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
  const waited = await deps.wait.forToken(review.wait_token_id);

  const stored = await storedDecision(deps, ticketId, review.id, !waited.ok);
  const decision = stored.decision as ReviewDecision;
  if (decision === "timeout") {
    await escalate(deps, ticketId, stored, timeout);
  } else {
    if (!(await hasEvent(deps, ticketId, "review_decided"))) {
      await repos.addEvent(ticketId, "review_decided", { reviewId: stored.id, decision });
    }
    await repos.setTicketStatus(ticketId, decision === "approve" ? "approved" : "rejected");
  }
  await updateCard(deps, ticket, triage, stored, timeout);
  log.info("review-ticket: decided", { ticketId, reviewId: stored.id, attempt, decision });
  return { ticketId, skipped: false, decision };
}

async function hasEvent(deps: ReviewDeps, ticketId: string, type: string): Promise<boolean> {
  return (await deps.repos.listEventTypes(ticketId, [type])).includes(type);
}

/** The row after the wait. An undecided row is decided `timeout` only when the token timed out. */
async function storedDecision(
  deps: ReviewDeps,
  ticketId: string,
  reviewId: string,
  timedOut: boolean,
): Promise<Review> {
  const row = await deps.repos.getReview(reviewId);
  if (!row) throw new Error(`review-ticket: review row of ticket ${ticketId} is missing`);
  if (row.decision !== null) return row;
  if (!timedOut) {
    throw new AbortTaskRunError(
      `review-ticket: ticket ${ticketId}: token completed without a stored decision`,
    );
  }
  return (await deps.repos.decideReview(row.id, "timeout", null)).review;
}

/** The timeout path: thread note and event (once), then `escalated_manual`. */
async function escalate(
  deps: ReviewDeps,
  ticketId: string,
  review: Review,
  timeout: string,
): Promise<void> {
  if (!(await hasEvent(deps, ticketId, "review_timed_out"))) {
    if (review.slack_ts === null) throw new Error(`review-ticket: ticket ${ticketId} has no card`);
    // Fixed wording and the timeout value only: no ticket text.
    const note = buildTimeoutNote({ timeout });
    await deps.slack.postMessage({
      channel: deps.channelId,
      threadTs: review.slack_ts,
      text: note.text,
      blocks: [{ type: "section", text: { type: "plain_text", text: note.text, emoji: false } }],
    });
    await deps.repos.addEvent(ticketId, "review_timed_out", { reviewId: review.id });
  }
  await deps.repos.setTicketStatus(ticketId, "escalated_manual");
}

/**
 * Best effort: the decision is stored, so a stale card is cosmetic (a later
 * click gets "already decided"). A failure logs the class name and raises
 * slack_update_failed once.
 */
async function updateCard(
  deps: ReviewDeps,
  ticket: Ticket,
  triage: Triage,
  review: Review,
  timeout: string,
): Promise<void> {
  try {
    if (review.slack_ts === null) throw new Error("review-ticket: the review has no card");
    const input = await cardInput(deps, ticket, triage, review, timeout);
    const card: CardMessage =
      review.decision === "timeout"
        ? buildTimedOutCard(input)
        : buildDecidedCard(input, {
            decision: review.decision as "approve" | "reject",
            slackUserId: review.slack_user_id ?? "",
            decidedAt: review.decided_at ?? "",
          });
    await deps.slack.updateMessage({
      channel: deps.channelId,
      ts: review.slack_ts,
      text: card.text,
      blocks: card.blocks,
    });
  } catch (error) {
    deps.logger.error("review-ticket: card update failed", {
      ticketId: ticket.id,
      reviewId: review.id,
      error: errorClassName(error),
    });
    await deps.alert("slack_update_failed", { ticketId: ticket.id });
  }
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

/** The card fields: redacted text, the triage row and the KB titles only. */
async function cardInput(
  deps: ReviewDeps,
  ticket: Ticket,
  triage: Triage,
  review: Review,
  timeout: string,
): Promise<ReviewCardInput> {
  const { repos } = deps;
  const ticketId = ticket.id;
  const redaction = await repos.getRedaction(ticketId);
  if (!redaction) throw new AbortTaskRunError(`review-ticket: ticket ${ticketId} has no redaction`);
  const articles = await repos.getKbArticlesByIds(triage.kb_article_ids ?? []);
  const fix = triage.suggested_fix === null ? null : fixStepsSchema.safeParse(triage.suggested_fix);
  if (fix !== null && !fix.success) {
    throw new Error("review-ticket: the saved fix steps have an unexpected shape");
  }
  return {
    reviewId: review.id,
    ticketId,
    ticketNumber: ticket.ticket_number,
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
  };
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
  const card = buildReviewCard(await cardInput(deps, ticket, triage, review, timeout));
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

export interface ReviewFailureDeps {
  repos: Pick<Repositories, "getTicket" | "addEvent" | "setTicketStatus">;
  alert: AlertFn;
  logger: { info: LogFn; warn: LogFn; error: LogFn };
}

/** The database and the alert sink only: the run may have failed on any other variable. */
export function createReviewFailureDeps(
  source: Record<string, string | undefined>,
  repos: ReviewFailureDeps["repos"] &
    Pick<Repositories, "recordSecurityEvent"> = createRepositories(createDbClient(source)),
): ReviewFailureDeps {
  return { repos, alert: createFailureAlert("review-ticket", source, repos), logger };
}

/** Statuses this task owns; any other ticket is left alone by the failure hook. */
const OWNED: ReadonlySet<string> = new Set(["triaged", "review_pending"]);

/**
 * The task's `onFailure` hook, called once after the last attempt failed. For
 * a `triaged` or `review_pending` ticket it records `review_failed { error:
 * <class name> }`, sets `failed` and raises the alert `review_failed`. A
 * decided, escalated or failed ticket is left unchanged. It never throws; a
 * failure here (the database is down) is logged by class name only.
 */
export async function onReviewFailure(
  params: { payload: unknown; error: unknown },
  deps?: ReviewFailureDeps,
): Promise<void> {
  const error = errorClassName(params.error);
  const log = deps?.logger ?? logger;
  const safeLog = (message: string, data: object) => {
    try {
      log.error(message, { ...data });
    } catch {
      // The hook must not throw, even when logging fails.
    }
  };
  try {
    const parsed = reviewTicketPayload.safeParse(params.payload);
    if (!parsed.success) {
      safeLog("review-ticket: failed run without a valid ticket id", { error });
      return;
    }
    const { ticketId } = parsed.data;
    const { repos, alert } = deps ?? createReviewFailureDeps(process.env);
    const ticket = await repos.getTicket(ticketId);
    if (!ticket || !OWNED.has(ticket.status)) {
      safeLog("review-ticket: failed run, ticket unchanged", { ticketId, error });
      return;
    }
    await repos.addEvent(ticketId, "review_failed", { error });
    await repos.setTicketStatus(ticketId, "failed");
    await alert("review_failed", { ticketId });
    safeLog("review-ticket: failed", { ticketId, error });
  } catch (hookError) {
    safeLog("review-ticket: could not record the failure", {
      error,
      cause: errorClassName(hookError),
    });
  }
}

/**
 * Task options, exported so a test can assert the wiring (`onFailure`).
 * Posts a ticket's review card to Slack, waits for a decision and records it.
 * Triggered by triage-ticket for the route `review`. Env is validated at the
 * start of each run.
 */
export const reviewTicketOptions = {
  id: REVIEW_TICKET_TASK_ID,
  schema: reviewTicketPayload,
  run: async (payload: ReviewTicketPayload, { ctx }: { ctx: { attempt: { number: number } } }) =>
    runReviewTicket(payload, createReviewDeps(process.env), ctx.attempt.number),
  onFailure: onReviewFailure,
};

export const reviewTicket = schemaTask(reviewTicketOptions);
