// Phase 4 heavy live scenarios (plan T4.L.05, T4.F.01). Heavy: the default
// run and `--phase 4` leave them out; `--only` selects them (resolved point 15).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { evalTicketSchema, type InternalTicketView } from "@ai-it-support/shared";
import { z } from "zod";
import { p95, POLL_MS, result } from "./pipeline.ts";
import {
  cardReview,
  createReviewTicket,
  decideAndWait,
  findCard,
  READ_SLACK,
  SIGN,
  slackNotRun,
  slackOf,
} from "./review-flow.ts";
import { pool } from "./review-security.ts";
import { UsageError, type Scenario } from "./runner.ts";

const DATASET = new URL("../../../evals/tickets.json", import.meta.url);
export const L05_TICKETS = 20;
export const L05_CONCURRENCY = 5;
/** Each sensitive ticket must have its card within this time of its creation. */
export const L05_CARD_LIMIT_MS = 120_000;
/** DoD 1: policy_decided → review_requested at most 10 s. */
export const L05_LATENCY_MS = 10_000;

const eventAt = (view: InternalTicketView, type: string): number | null => {
  const event = view.events.find((e) => e.type === type);
  return event === undefined ? null : Date.parse(event.at);
};

/** The 20 tickets of the `sensitive` set of evals/tickets.json (each has a sensitiveTopic). */
export function sensitiveEvalTickets(path: URL | string = DATASET) {
  const tickets = evalTicketSchema
    .array()
    .parse(JSON.parse(readFileSync(path, "utf8")))
    .filter((t) => t.set === "sensitive" && t.expected.sensitiveTopic !== null);
  if (tickets.length !== L05_TICKETS) throw new RangeError("expected 20 sensitive eval tickets");
  return tickets;
}

/**
 * T4.L.05: the 20 sensitive eval tickets, created 5 at a time, each reach
 * `review_pending` with a card in #itsupport-e2e history within 120 s; and for
 * each, review_requested − policy_decided is at most 10 s (DoD 1). The tickets
 * are left to time out.
 */
export const sensitiveReplayScenario: Scenario = {
  id: "T4.L.05",
  heavy: true,
  async run(context) {
    const notRun = slackNotRun(context, READ_SLACK);
    if (notRun) return notRun;
    const tickets = sensitiveEvalTickets();
    const startSeconds = Math.floor(context.now() / 1000);
    const created: Array<{ evalId: string; ticketId: string; deadline: number }> = [];
    await pool(tickets, L05_CONCURRENCY, async (t) => {
      const { ticketId } = await context.client.createTestTicket({
        name: t.name,
        email: t.email,
        department: t.department,
        title: t.title,
        description: `${t.description} (live run ${context.runId})`,
        testId: `${context.runId}:L05:${t.id}`,
      });
      created.push({ evalId: t.id, ticketId, deadline: context.now() + L05_CARD_LIMIT_MS });
    });
    // Eval order, not finishing order.
    created.sort((x, y) => x.evalId.localeCompare(y.evalId));

    const views = new Map<string, InternalTicketView>();
    let pending = [...created];
    while (pending.length > 0) {
      const read = await Promise.all(pending.map((t) => context.client.ticket(t.ticketId)));
      read.forEach((view, i) => views.set(pending[i]!.ticketId, view));
      const at = context.now();
      pending = pending.filter(({ ticketId, deadline }) => {
        const view = views.get(ticketId)!;
        const done =
          (view.status === "review_pending" && cardReview(view) !== undefined) ||
          view.status === "failed";
        return !done && at < deadline;
      });
      if (pending.length > 0) await context.sleep(POLL_MS);
    }

    const slack = slackOf(context);
    const { channelId } = await slack.verify();
    const history = new Set(
      (await slack.history(channelId, { oldest: String(startSeconds - 1) })).map((m) => m.ts),
    );
    const missingCards: string[] = [];
    const missingTimes: string[] = [];
    const slowTickets: string[] = [];
    const latenciesMs: number[] = [];
    let aiCallCount = 0;
    for (const { evalId, ticketId } of created) {
      const view = views.get(ticketId)!;
      aiCallCount += view.aiCallCount;
      const ts = cardReview(view)?.slackTs;
      if (view.status !== "review_pending" || ts == null || !history.has(ts)) {
        missingCards.push(evalId);
      }
      const policy = eventAt(view, "policy_decided");
      const requested = eventAt(view, "review_requested");
      if (policy === null || requested === null) {
        missingTimes.push(evalId);
        continue;
      }
      const latency = requested - policy;
      latenciesMs.push(latency);
      if (latency > L05_LATENCY_MS) slowTickets.push(ticketId);
    }
    const failedChecks = [
      ...(missingCards.length === 0 ? [] : ["all-cards"]),
      ...(missingTimes.length === 0 ? [] : ["event-times"]),
      ...(slowTickets.length === 0 ? [] : ["latency-at-most-10s"]),
    ];
    return result(failedChecks, {
      tickets: created.length,
      cards: created.length - missingCards.length,
      missingCards,
      missingTimes,
      slowTickets,
      latenciesMs,
      maxLatencyMs: latenciesMs.length > 0 ? Math.max(...latenciesMs) : null,
      p95LatencyMs: latenciesMs.length > 0 ? p95(latenciesMs) : null,
      ticketIds: created.map((t) => t.ticketId),
      aiCallCount,
    });
  },
};

/** The hand-off file between T4.F.01:start and T4.F.01:finish: the three IDs, nothing else. */
export const f01FileSchema = z.strictObject({
  ticketId: z.uuid(),
  reviewId: z.uuid(),
  slackTs: z.string().regex(/^[0-9]{1,12}\.[0-9]{1,6}$/),
});

/** `live/f01-<runId>.json` under the evidence folder. */
export const f01File = (evidenceDir: string, runId: string) =>
  join(evidenceDir, "live", `f01-${runId}.json`);

/**
 * T4.F.01:start: one review ticket with a 30-minute review timeout; once its
 * card is in history, writes { ticketId, reviewId, slackTs } to
 * `.loop-evidence/live/f01-<runId>.json`. The orchestrator then deploys and
 * rolls back the E2E Trigger.dev project (DoD 8) before T4.F.01:finish.
 */
export const waitingRunStartScenario: Scenario = {
  id: "T4.F.01:start",
  heavy: true,
  async run(context) {
    const notRun = slackNotRun(context, READ_SLACK);
    if (notRun) return notRun;
    const ticket = await createReviewTicket(context, "F01", {
      testOverrides: { reviewTimeout: "30m" },
    });
    const evidence = {
      ticketId: ticket.ticketId,
      reviewId: ticket.review?.id ?? null,
      slackTs: ticket.review?.slackTs ?? null,
      aiCallCount: ticket.view.aiCallCount,
    };
    if (ticket.review === undefined) return result(["review-pending"], evidence);
    const slackTs = ticket.review.slackTs!;
    if ((await findCard(slackOf(context), slackTs)) === undefined) {
      return result(["card-in-history"], evidence);
    }
    const file = f01File(context.evidenceDir, context.runId);
    mkdirSync(join(context.evidenceDir, "live"), { recursive: true });
    const handOff = f01FileSchema.parse({
      ticketId: ticket.ticketId,
      reviewId: ticket.review.id,
      slackTs,
    });
    writeFileSync(file, `${JSON.stringify(handOff)}\n`);
    return result([], { ...evidence, file: `live/f01-${context.runId}.json` });
  },
};

/**
 * T4.F.01:finish --from <file>: signs an approve for the review in the file and
 * expects `approved` within 5 s.
 */
export const waitingRunFinishScenario: Scenario = {
  id: "T4.F.01:finish",
  heavy: true,
  needsFrom: true,
  async run(context) {
    let handOff: z.infer<typeof f01FileSchema>;
    try {
      handOff = f01FileSchema.parse(JSON.parse(readFileSync(resolve(context.from!), "utf8")));
    } catch {
      throw new UsageError("--from: the file is not a T4.F.01:start file");
    }
    const notRun = slackNotRun(context, SIGN);
    if (notRun) return notRun;
    const decided = await decideAndWait(
      context,
      handOff.ticketId,
      { id: handOff.reviewId, slackTs: handOff.slackTs },
      "approve",
    );
    const stored = decided.view.reviews.find((r) => r.id === handOff.reviewId);
    const failedChecks = [
      ...(decided.status === 200 && decided.outcome === "recorded" ? [] : ["recorded"]),
      ...(decided.decidedMs === null ? ["approved-within-5s"] : []),
      ...(stored?.decision === "approve" ? [] : ["review-decision"]),
    ];
    return result(failedChecks, {
      ticketId: handOff.ticketId,
      reviewId: handOff.reviewId,
      slackTs: handOff.slackTs,
      responseStatus: decided.status,
      decidedMs: decided.decidedMs,
      status: decided.view.status,
      aiCallCount: decided.view.aiCallCount,
    });
  },
};

export const reviewHeavyScenarios: readonly Scenario[] = [
  sensitiveReplayScenario,
  waitingRunStartScenario,
  waitingRunFinishScenario,
];
