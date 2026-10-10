import {
  BudgetExceededError,
  LlmUnavailableError,
  createAiRuntime,
  createAlertSink,
  createFixDrafter,
  createGroundingScorer,
  createKbReranker,
  createLangfuseSink,
  createMeter,
  createTriageJudge,
  createTypeSafeClient,
  errorClassName,
  type AlertFn,
  type TraceSink,
} from "@ai-it-support/ai";
import {
  createDbClient,
  createRepositories,
  dbEnvShape,
  type Redaction,
  type Repositories,
  type Triage,
} from "@ai-it-support/db";
import {
  MAX_KB_ARTICLES,
  TICKET_STATUSES,
  TRIAGE_TICKET_TASK_ID,
  aiBudgetEnvShape,
  buildKbQuery,
  decideRoute,
  e2eEnvShape,
  effectiveTestOverrides,
  groundingEnvShape,
  langfuseEnvShape,
  llmEnvShape,
  parseEnv,
  policyEnvShape,
  testOverridesSchema,
  type PolicyInput,
  type PolicyReason,
  type PolicyThresholds,
  type Priority,
  type Route,
  type TestOverrides,
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
    | "listEventTypes"
    | "addEvent"
    | "setTicketStatus"
  >;
  /** Each AI step is metered and traced through the shared runtime. */
  judge: Pick<ReturnType<typeof createTriageJudge>, "judge">;
  reranker: Pick<ReturnType<typeof createKbReranker>, "rerankKb">;
  drafter: Pick<ReturnType<typeof createFixDrafter>, "draft">;
  grounding: Pick<ReturnType<typeof createGroundingScorer>, "scoreGrounding">;
  thresholds: PolicyThresholds;
  /** E2E_MODE: test switches take effect only with it AND the ticket's is_test. */
  e2eMode: boolean;
  /** Never throws (createAlertSink). */
  alert: AlertFn;
  /** Test switch `langfuseDown`: every later trace export of this run fails. */
  setTraceSinkDown(down: boolean): void;
  logger: { info: LogFn; warn: LogFn; error: LogFn };
}

/**
 * A trace sink that can be switched to its forced-down twin for the rest of
 * the run (test switch `langfuseDown`). Deps are built per run, so the switch
 * never outlives one run.
 */
export function createSwitchableSink(up: TraceSink, down: TraceSink) {
  let isDown = false;
  return {
    sink: { record: (span) => (isDown ? down : up).record(span) } satisfies TraceSink,
    setDown(value: boolean) {
      isDown = value;
    },
  };
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
  const traceSink = createSwitchableSink(
    createLangfuseSink(env),
    createLangfuseSink(env, { forceDown: true }),
  );
  const runtime = createAiRuntime({
    meter,
    sink: traceSink.sink,
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
    e2eMode: env.E2E_MODE,
    alert,
    setTraceSinkDown: traceSink.setDown,
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
 * Order: load the ticket, its redaction, its triage row and the triage events
 * already written; judgments, KB search, rerank, fix draft, grounding, policy;
 * then the writes: a degraded-path event (and its alert) when one applies,
 * saveTriageResult, the events kb_matched, fix_drafted, policy_decided and
 * triaged, and last the status `triaged`. Every AI step runs before the first
 * write, so a failed AI step leaves no triage result, no event and the status
 * `redacted`. A ticket already `triaged` (or later) is skipped with no call.
 *
 * Degraded paths, each still ending `triaged` with the route `review`:
 * - LLM cap (`BudgetExceededError` from the drafter): event llm_cap_reached,
 *   no fix steps, no grounding, reason cap_reached.
 * - LLM 429 (`LlmUnavailableError`): one drafter call, never retried; event
 *   and alert llm_unavailable, no fix steps, no grounding.
 * - TypeSafe cap at the judgments: event and alert typesafe_cap_reached; no
 *   KB search, no LLM call, the judged fields stay null, reason cap_reached.
 * A degraded event an earlier attempt wrote is not written again, its alert
 * is not raised again, and the step that hit it is not called again.
 *
 * Test switches (plan C5) take effect only with E2E_MODE and the ticket's
 * is_test: `llmCallCap` becomes the drafter's cap, `langfuseDown` forces the
 * trace sink down.
 *
 * Resumable: when a write after saveTriageResult fails, the retry finds the
 * saved result (triaged_at set, status still `redacted`), runs no AI step,
 * writes only the events still missing, then the status.
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

  const overrides = testOverrides(payload, ticket.is_test, deps.e2eMode);
  if (overrides.langfuseDown === true) deps.setTraceSinkDown(true);
  // Events an earlier attempt already wrote: none of them is written twice.
  const written = new Set(await repos.listEventTypes(ticketId, KNOWN_EVENTS));
  const prior = degradedFrom(written);

  let outcome: TriageOutcome;
  if (triage.triaged_at !== null) {
    // Resume: an earlier attempt saved the result but failed before the status
    // write. No AI step runs again; only the missing events and the status are
    // written. onTriageFailure leaves such a row alone (its columns are set).
    outcome = savedOutcome(triage, deps.thresholds, prior);
    log.info("triage-ticket: resuming a saved result", { ticketId, attempt });
  } else {
    const fresh = await triageWithAi(
      { ticketId, department: ticket.department, redaction, triage, prior, overrides },
      deps,
    );
    const { degraded } = fresh.outcome;
    if (degraded !== null && !written.has(degraded)) {
      await repos.addEvent(ticketId, degraded, {});
      written.add(degraded);
      // Raised once per ticket: only together with the first write of its event.
      if (degraded !== "llm_cap_reached") await deps.alert(degraded, { ticketId });
      log.warn("triage-ticket: degraded path", { ticketId, attempt, event: degraded });
    }
    // The triage write: every AI step above has succeeded.
    await repos.saveTriageResult(ticketId, fresh.result);
    outcome = fresh.outcome;
  }

  const { route, reasons, articleIds, steps } = outcome;
  const events: Array<[TriageEvent, Record<string, unknown>]> = [];
  if (articleIds !== null) events.push(["kb_matched", { articleIds, count: articleIds.length }]);
  if (steps !== null) events.push(["fix_drafted", { steps }]);
  events.push(["policy_decided", { route, reasons }], ["triaged", { route }]);
  for (const [type, data] of events) {
    if (!written.has(type)) await repos.addEvent(ticketId, type, data);
  }
  await repos.setTicketStatus(ticketId, "triaged");
  log.info("triage-ticket: triaged", {
    ticketId,
    attempt,
    route,
    reasons,
    articles: articleIds?.length ?? 0,
  });

  return { ticketId, skipped: false, route, reasons };
}

const TRIAGE_EVENTS = ["kb_matched", "fix_drafted", "policy_decided", "triaged"] as const;
type TriageEvent = (typeof TRIAGE_EVENTS)[number];
const DEGRADED_EVENTS = ["typesafe_cap_reached", "llm_unavailable", "llm_cap_reached"] as const;
type DegradedEvent = (typeof DEGRADED_EVENTS)[number];
const KNOWN_EVENTS = [...TRIAGE_EVENTS, ...DEGRADED_EVENTS];

/** The degraded path an earlier attempt recorded, the most severe first. */
function degradedFrom(written: ReadonlySet<string>): DegradedEvent | null {
  return DEGRADED_EVENTS.find((type) => written.has(type)) ?? null;
}

/**
 * The switches that apply to this run. A malformed request (only possible
 * when the payload schema was bypassed) aborts: a retry cannot fix it.
 */
function testOverrides(
  payload: TriageTicketPayload,
  isTest: boolean,
  e2eMode: boolean,
): TestOverrides {
  try {
    return effectiveTestOverrides({ e2eMode, isTest, requested: payload.testOverrides });
  } catch {
    throw new AbortTaskRunError(
      `triage-ticket: ticket ${payload.ticketId} has invalid test overrides`,
    );
  }
}

/** What the event payloads need: IDs, counts and names only. */
interface TriageOutcome {
  route: Route;
  reasons: PolicyReason[];
  /** null: the KB search did not run (TypeSafe cap), so no kb_matched event. */
  articleIds: string[] | null;
  /** null: no fix was drafted, so no fix_drafted event. */
  steps: number | null;
  degraded: DegradedEvent | null;
}

interface TriageInput {
  ticketId: string;
  department: string | null;
  redaction: Redaction;
  triage: Triage;
  prior: DegradedEvent | null;
  overrides: TestOverrides;
}

type Judgments = Awaited<ReturnType<TriageDeps["judge"]["judge"]>>;
type Draft = Awaited<ReturnType<TriageDeps["drafter"]["draft"]>>;

const isCap = (error: unknown, provider: "llm" | "typesafe") =>
  error instanceof BudgetExceededError && error.provider === provider;

/** Runs every AI step and the policy. Writes nothing itself. */
async function triageWithAi(
  input: TriageInput,
  deps: TriageDeps,
): Promise<{ result: TriageResult; outcome: TriageOutcome }> {
  const { ticketId, department, redaction, triage, prior, overrides } = input;
  // Redacted text only; the judge redacts the department itself.
  const text = { title: redaction.redacted_title, description: redaction.redacted_description };

  if (prior === "typesafe_cap_reached") return typesafeCapped(triage.sensitive);
  let judgments: Judgments;
  try {
    judgments = await deps.judge.judge({ ticketId, ...text, department });
  } catch (error) {
    if (isCap(error, "typesafe")) return typesafeCapped(triage.sensitive);
    throw error;
  }

  const candidates = await deps.repos.searchKb(buildKbQuery(`${text.title} ${text.description}`));
  const ranked = await deps.reranker.rerankKb({ ticketId, ticket: text, candidates });
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const articles = [...new Set(ranked.map((r) => r.id))]
    .map((id) => byId.get(id))
    .filter((article) => article !== undefined)
    .slice(0, MAX_KB_ARTICLES);

  // An earlier attempt hit the LLM cap or a 429: the LLM is not asked again.
  let degraded: DegradedEvent | null = prior;
  let draft: Draft | null = null;
  if (degraded === null) {
    const cap = overrides.llmCallCap;
    try {
      // Exactly one call: a 429 is never retried.
      draft = await deps.drafter.draft({
        ticketId,
        ticket: text,
        articles,
        ...(cap === undefined ? {} : { capOverride: cap }),
      });
    } catch (error) {
      if (isCap(error, "llm")) degraded = "llm_cap_reached";
      else if (error instanceof LlmUnavailableError) degraded = "llm_unavailable";
      else throw error;
    }
  }
  const grounding =
    draft === null
      ? null
      : await deps.grounding.scoreGrounding({ ticketId, steps: draft.steps, articles });

  const probabilities = {
    category: judgments.category.probability,
    priority: judgments.priority.probability,
    urgency: judgments.urgency.probability,
    assignment_group: judgments.assignmentGroup.probability,
    injection: judgments.injection,
    needs_info: judgments.needsInfo,
    outage_or_duplicate: judgments.outageOrDuplicate,
  };
  const decision = decideRoute(
    policyInput(triage.sensitive, judgments.priority.value, probabilities, {
      ungroundedFix: grounding?.flagged ?? false,
      capReached: degraded === "llm_cap_reached",
      llmUnavailable: degraded === "llm_unavailable",
    }),
    deps.thresholds,
  );

  const articleIds = articles.map((article) => article.id);
  return {
    result: {
      category: judgments.category.value,
      subcategory: null,
      priority: judgments.priority.value,
      urgency: judgments.urgency.value,
      assignmentGroup: judgments.assignmentGroup.value,
      route: decision.route,
      probabilities,
      flags: decision.flags,
      groundingScore: grounding?.score ?? null,
      kbArticleIds: articleIds,
      suggestedFix:
        draft === null ? null : { steps: [...draft.steps], caveats: [...draft.caveats] },
      modelVersions:
        draft === null
          ? { typesafe: judgments.model }
          : { typesafe: judgments.model, llm: draft.model },
    },
    outcome: {
      route: decision.route,
      reasons: decision.reasons,
      articleIds,
      steps: draft === null ? null : draft.steps.length,
      degraded,
    },
  };
}

/**
 * The TypeSafe cap stopped the judgments: no probabilities exist, so the
 * policy cannot run. The route is `review` (fail closed) with the reasons
 * sensitive (when it applies) and cap_reached, in the policy's order.
 */
function typesafeCapped(sensitive: boolean): { result: TriageResult; outcome: TriageOutcome } {
  const reasons: PolicyReason[] = sensitive ? ["sensitive", "cap_reached"] : ["cap_reached"];
  return {
    result: {
      category: null,
      subcategory: null,
      priority: null,
      urgency: null,
      assignmentGroup: null,
      route: "review",
      probabilities: {},
      flags: [],
      groundingScore: null,
      kbArticleIds: [],
      suggestedFix: null,
      modelVersions: {},
    },
    outcome: {
      route: "review",
      reasons,
      articleIds: null,
      steps: null,
      degraded: "typesafe_cap_reached",
    },
  };
}

function policyInput(
  sensitive: boolean,
  priority: Priority,
  probabilities: Record<string, number | undefined>,
  rules: { ungroundedFix: boolean; capReached: boolean; llmUnavailable: boolean },
): PolicyInput {
  // A missing probability stays undefined, so decideRoute throws rather than guess.
  return {
    sensitive,
    categoryProbability: probabilities.category as number,
    priority,
    injection: probabilities.injection as number,
    needsInfo: probabilities.needs_info as number,
    outageOrDuplicate: probabilities.outage_or_duplicate as number,
    ungroundedFix: rules.ungroundedFix,
    capReached: rules.capReached,
    llmUnavailable: rules.llmUnavailable,
  };
}

/**
 * Rebuilds the event payloads from a saved triage row. The route is the saved
 * one; the reasons are not stored, so they come from the degraded event an
 * earlier attempt wrote plus the pure policy run again on the saved columns.
 * A row that does not hold a full result throws.
 */
function savedOutcome(
  triage: Triage,
  thresholds: PolicyThresholds,
  prior: DegradedEvent | null,
): TriageOutcome {
  const route = triage.route;
  if (route !== "auto" && route !== "review") {
    throw new Error("triage-ticket: the saved triage result has no valid route");
  }
  if (prior === "typesafe_cap_reached") {
    if (route !== "review") throw new Error("triage-ticket: a capped result must route review");
    return typesafeCapped(triage.sensitive).outcome;
  }
  const decision = decideRoute(
    policyInput(triage.sensitive, triage.priority as Priority, triage.probabilities ?? {}, {
      ungroundedFix: (triage.flags ?? []).includes("ungrounded_fix"),
      capReached: prior === "llm_cap_reached",
      llmUnavailable: prior === "llm_unavailable",
    }),
    thresholds,
  );
  if (decision.route !== route) {
    throw new Error("triage-ticket: the saved route does not match the policy");
  }
  const fix = triage.suggested_fix;
  return {
    route,
    reasons: decision.reasons,
    articleIds: triage.kb_article_ids ?? [],
    steps: fix === null ? null : Array.isArray(fix.steps) ? fix.steps.length : 0,
    degraded: prior,
  };
}

export interface TriageFailureDeps {
  repos: Pick<Repositories, "getTicket" | "getTriage" | "addEvent" | "setTicketStatus">;
  alert: AlertFn;
  logger: { info: LogFn; warn: LogFn; error: LogFn };
}

/** The database and the alert sink only: the run may have failed on any other variable. */
export function createTriageFailureDeps(
  source: Record<string, string | undefined>,
): TriageFailureDeps {
  const repos = createRepositories(createDbClient(source));
  const alert = createAlertSink({
    recordSecurityEvent: repos.recordSecurityEvent,
    logger: { error: (message) => logger.error(message) },
  });
  return { repos, alert, logger };
}

/**
 * The task's `onFailure` hook. Trigger.dev 4.6.4 calls it once, after the
 * last attempt failed; it does not run for crashed or cancelled runs. For a
 * `redacted` ticket with no saved triage result it records `triage_failed
 * { error: <class name> }`, sets the status `failed` and raises the alert
 * `triage_failed`, so the triage columns stay null. Any other ticket is left
 * alone: `failed`, `triaged` or later, `new` (intake still owns it), and a
 * ticket whose result is saved (left for the resumable retry). It never
 * throws; a failure here (the database is down) is logged by class name only.
 */
export async function onTriageFailure(
  params: { payload: unknown; error: unknown },
  deps?: TriageFailureDeps,
): Promise<void> {
  const error = errorClassName(params.error);
  const log = deps?.logger ?? logger;
  const safeLog = (level: "info" | "warn" | "error", message: string, data: object) => {
    try {
      log[level](message, { ...data });
    } catch {
      // The hook must not throw, even when logging fails.
    }
  };
  try {
    const parsed = triageTicketPayload.safeParse(params.payload);
    if (!parsed.success) {
      safeLog("error", "triage-ticket: failed run without a valid ticket id", { error });
      return;
    }
    const { ticketId } = parsed.data;
    const { repos, alert } = deps ?? createTriageFailureDeps(process.env);
    const ticket = await repos.getTicket(ticketId);
    if (!ticket || ticket.status !== "redacted") {
      const status = ticket ? statusLabel(ticket.status) : "(no ticket)";
      safeLog("info", "triage-ticket: failed run, ticket unchanged", { ticketId, status, error });
      return;
    }
    const triage = await repos.getTriage(ticketId);
    if (triage !== null && triage.triaged_at !== null) {
      safeLog("warn", "triage-ticket: failed run with a saved result, left for retry", {
        ticketId,
        error,
      });
      return;
    }
    await repos.addEvent(ticketId, "triage_failed", { error });
    await repos.setTicketStatus(ticketId, "failed");
    await alert("triage_failed", { ticketId });
    safeLog("error", "triage-ticket: failed", { ticketId, error });
  } catch (hookError) {
    safeLog("error", "triage-ticket: could not record the failure", {
      error,
      cause: errorClassName(hookError),
    });
  }
}

/**
 * Task options, exported so a test can assert the wiring (`onFailure`).
 * Triages a redacted ticket: TypeSafe judgments, KB match, LLM fix steps,
 * grounding and the policy route. Triggered by id "triage-ticket" with
 * `{ ticketId }`. Env is validated at the start of each run.
 */
export const triageTicketOptions = {
  id: TRIAGE_TICKET_TASK_ID,
  schema: triageTicketPayload,
  run: async (payload: TriageTicketPayload, { ctx }: { ctx: { attempt: { number: number } } }) =>
    runTriageTicket(payload, createTriageDeps(process.env), ctx.attempt.number),
  onFailure: onTriageFailure,
};

export const triageTicket = schemaTask(triageTicketOptions);
