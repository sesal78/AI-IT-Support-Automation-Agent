import {
  createAiRuntime,
  createAlertSink,
  createFixDrafter,
  createGroundingScorer,
  createKbReranker,
  createLangfuseSink,
  createMeter,
  createTriageJudge,
  createTypeSafeClient,
} from "@ai-it-support/ai";
import {
  createDbClient,
  createRepositories,
  dbEnvShape,
  type Repositories,
} from "@ai-it-support/db";
import {
  MAX_KB_ARTICLES,
  TICKET_STATUSES,
  TRIAGE_TICKET_TASK_ID,
  aiBudgetEnvShape,
  buildKbQuery,
  decideRoute,
  e2eEnvShape,
  groundingEnvShape,
  langfuseEnvShape,
  llmEnvShape,
  parseEnv,
  policyEnvShape,
  testOverridesSchema,
  type PolicyReason,
  type PolicyThresholds,
  type Route,
  type TriageResult,
  type TriageTicketPayload,
} from "@ai-it-support/shared";
import { AbortTaskRunError, logger, schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";

// Payload type is shared with the intake task that triggers it (packages/shared).
export const triageTicketPayload = z.object({
  ticketId: z.uuid(),
  testOverrides: testOverridesSchema.optional(),
}) satisfies z.ZodType<TriageTicketPayload>;

export type { TriageTicketPayload };

export type TriageTicketResult =
  | { ticketId: string; skipped: true }
  | { ticketId: string; skipped: false; route: Route; reasons: PolicyReason[] };

type LogFn = (message: string, data?: Record<string, unknown>) => void;

export interface TriageDeps {
  repos: Pick<
    Repositories,
    | "getTicket"
    | "getRedaction"
    | "getTriage"
    | "searchKb"
    | "saveTriageResult"
    | "addEvent"
    | "setTicketStatus"
  >;
  /** Each AI step is metered and traced through the shared runtime. */
  judge: Pick<ReturnType<typeof createTriageJudge>, "judge">;
  reranker: Pick<ReturnType<typeof createKbReranker>, "rerankKb">;
  drafter: Pick<ReturnType<typeof createFixDrafter>, "draft">;
  grounding: Pick<ReturnType<typeof createGroundingScorer>, "scoreGrounding">;
  thresholds: PolicyThresholds;
  logger: { info: LogFn; warn: LogFn; error: LogFn };
}

const triageEnvShape = {
  ...dbEnvShape,
  TYPESAFE_API_KEY: z.string().min(1),
  ...llmEnvShape,
  APP_VERSION: z.string().min(1).optional(),
  ...policyEnvShape,
  ...groundingEnvShape,
  ...aiBudgetEnvShape,
  ...langfuseEnvShape,
  ...e2eEnvShape,
};

/** Validates env and builds the real deps. Invalid variables throw, naming the variable. */
export function createTriageDeps(source: Record<string, string | undefined>): TriageDeps {
  const env = parseEnv(triageEnvShape, source);
  const repos = createRepositories(createDbClient(source));
  const environment = env.E2E_MODE ? "e2e" : "staging";
  const alert = createAlertSink({
    recordSecurityEvent: repos.recordSecurityEvent,
    logger: { error: (message) => logger.error(message) },
  });
  const meter = createMeter({
    repos,
    caps: { llm: env.LLM_MONTHLY_CALL_CAP, typesafe: env.TYPESAFE_MONTHLY_CALL_CAP },
    environment,
    alert,
  });
  const runtime = createAiRuntime({
    meter,
    sink: createLangfuseSink(env),
    addEvent: repos.addEvent,
    environment,
  });
  const client = createTypeSafeClient(env.TYPESAFE_API_KEY);
  return {
    repos,
    judge: createTriageJudge({ client, runtime }),
    reranker: createKbReranker({ client, runtime }),
    drafter: createFixDrafter({
      apiKey: env.LLM_API_KEY,
      baseUrl: env.LLM_BASE_URL,
      model: env.LLM_MODEL,
      runtime,
      appVersion: env.APP_VERSION,
    }),
    grounding: createGroundingScorer({ client, runtime, groundingMin: env.GROUNDING_MIN }),
    thresholds: {
      TRIAGE_CONFIDENCE_MIN: env.TRIAGE_CONFIDENCE_MIN,
      INJECTION_THRESHOLD: env.INJECTION_THRESHOLD,
      NEEDS_INFO_THRESHOLD: env.NEEDS_INFO_THRESHOLD,
      OUTAGE_THRESHOLD: env.OUTAGE_THRESHOLD,
    },
    logger,
  };
}

/** Statuses a ticket only reaches after triage: a run on one of them is a no-op. */
const TRIAGED_OR_LATER: ReadonlySet<string> = new Set(
  TICKET_STATUSES.filter((status) => !["new", "redacted", "failed"].includes(status)),
);

// A known status only: an unknown value is never echoed (it could be anything).
const statusLabel = (status: string) =>
  (TICKET_STATUSES as readonly string[]).includes(status) ? status : "(unknown status)";

/**
 * The task body, exported so tests can call it without the Trigger.dev runtime.
 *
 * Order: load the ticket, its redaction and its triage row; judgments, KB
 * search, rerank, fix draft, grounding, policy; then the writes:
 * saveTriageResult, the events kb_matched, fix_drafted, policy_decided and
 * triaged, and last the status `triaged`. Every AI step runs before the first
 * write, so a failed AI step leaves no triage result, no event and the status
 * `redacted`. A ticket already `triaged` (or later) is skipped with no call.
 *
 * Privacy: every AI input comes from `ticket_redactions` (the department is
 * redacted inside the judge). Logs and event payloads carry IDs, counts and
 * names only, never ticket text.
 */
export async function runTriageTicket(
  payload: TriageTicketPayload,
  deps: TriageDeps,
  attempt = 1,
): Promise<TriageTicketResult> {
  const { ticketId } = payload;
  const { repos, logger: log } = deps;

  const ticket = await repos.getTicket(ticketId);
  if (!ticket) {
    log.error("triage-ticket: ticket not found", { ticketId });
    throw new AbortTaskRunError(`triage-ticket: ticket ${ticketId} not found`);
  }
  if (TRIAGED_OR_LATER.has(ticket.status)) {
    log.info("triage-ticket: already triaged, skipped", { ticketId, status: ticket.status });
    return { ticketId, skipped: true };
  }
  if (ticket.status !== "redacted") {
    const status = statusLabel(ticket.status);
    log.error("triage-ticket: wrong status", { ticketId, status });
    throw new AbortTaskRunError(
      `triage-ticket: ticket ${ticketId} has status ${status}, expected redacted`,
    );
  }
  const redaction = await repos.getRedaction(ticketId);
  if (!redaction) {
    log.error("triage-ticket: no redaction", { ticketId });
    throw new AbortTaskRunError(`triage-ticket: ticket ${ticketId} has no redaction`);
  }
  const triage = await repos.getTriage(ticketId);
  if (!triage) {
    log.error("triage-ticket: no sensitive check", { ticketId });
    throw new AbortTaskRunError(`triage-ticket: ticket ${ticketId} has no triage row`);
  }

  // Redacted text only from here on.
  const text = { title: redaction.redacted_title, description: redaction.redacted_description };

  const judgments = await deps.judge.judge({
    ticketId,
    ...text,
    department: ticket.department,
  });
  const candidates = await repos.searchKb(buildKbQuery(`${text.title} ${text.description}`));
  const ranked = await deps.reranker.rerankKb({ ticketId, ticket: text, candidates });
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const articles = [...new Set(ranked.map((r) => r.id))]
    .map((id) => byId.get(id))
    .filter((article) => article !== undefined)
    .slice(0, MAX_KB_ARTICLES);
  const draft = await deps.drafter.draft({ ticketId, ticket: text, articles });
  const grounding = await deps.grounding.scoreGrounding({
    ticketId,
    steps: draft.steps,
    articles,
  });
  const decision = decideRoute(
    {
      sensitive: triage.sensitive,
      categoryProbability: judgments.category.probability,
      priority: judgments.priority.value,
      injection: judgments.injection,
      needsInfo: judgments.needsInfo,
      outageOrDuplicate: judgments.outageOrDuplicate,
      ungroundedFix: grounding.flagged,
      capReached: false,
      llmUnavailable: false,
    },
    deps.thresholds,
  );

  const articleIds = articles.map((article) => article.id);
  const result: TriageResult = {
    category: judgments.category.value,
    subcategory: null,
    priority: judgments.priority.value,
    urgency: judgments.urgency.value,
    assignmentGroup: judgments.assignmentGroup.value,
    route: decision.route,
    probabilities: {
      category: judgments.category.probability,
      priority: judgments.priority.probability,
      urgency: judgments.urgency.probability,
      assignment_group: judgments.assignmentGroup.probability,
      injection: judgments.injection,
      needs_info: judgments.needsInfo,
      outage_or_duplicate: judgments.outageOrDuplicate,
    },
    flags: decision.flags,
    groundingScore: grounding.score,
    kbArticleIds: articleIds,
    suggestedFix: { steps: [...draft.steps], caveats: [...draft.caveats] },
    modelVersions: { typesafe: judgments.model, llm: draft.model },
  };

  // First write: everything above has succeeded.
  await repos.saveTriageResult(ticketId, result);
  await repos.addEvent(ticketId, "kb_matched", { articleIds, count: articleIds.length });
  await repos.addEvent(ticketId, "fix_drafted", { steps: draft.steps.length });
  await repos.addEvent(ticketId, "policy_decided", {
    route: decision.route,
    reasons: decision.reasons,
  });
  await repos.addEvent(ticketId, "triaged", { route: decision.route });
  await repos.setTicketStatus(ticketId, "triaged");
  log.info("triage-ticket: triaged", {
    ticketId,
    attempt,
    route: decision.route,
    reasons: decision.reasons,
    articles: articleIds.length,
  });

  return { ticketId, skipped: false, route: decision.route, reasons: decision.reasons };
}

/**
 * Triages a redacted ticket: TypeSafe judgments, KB match, LLM fix steps,
 * grounding and the policy route. Triggered by id "triage-ticket" with
 * `{ ticketId }`. Env is validated at the start of each run.
 */
export const triageTicket = schemaTask({
  id: TRIAGE_TICKET_TASK_ID,
  schema: triageTicketPayload,
  run: async (payload, { ctx }) =>
    runTriageTicket(payload, createTriageDeps(process.env), ctx.attempt.number),
});
