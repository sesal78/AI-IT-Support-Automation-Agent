// P5-T5c shared steps: create a helpdesk ticket on the test path, keep the
// tickets a run created, and wait for the incident. Evidence carries IDs,
// numbers, enums, counts and times only, never ticket text.
import type { InternalTicketView, JsonState, JudgeDefinition } from "@ai-it-support/shared";
import { LiveContractError } from "./client.ts";
import { missingServiceNowEnv } from "./config.ts";
import { type JudgeClient } from "./judge.ts";
import { result } from "./pipeline.ts";
import type { ScenarioContext, ScenarioResult, Evidence } from "./runner.ts";
import { createE2eServiceNow, type E2eServiceNow } from "./servicenow.ts";

/** The two personas the helpdesk scenarios use (plan §4.2). */
export const PERSONAS = {
  carol: { name: "demo.carol", email: "demo.carol@example.com", department: "Operations" },
  erin: { name: "demo.erin", email: "demo.erin@example.com", department: "Operations" },
} as const;
export type Persona = { name: string; email: string; department: string };

/** One ticket this run created through the test path. */
export interface HelpdeskTicket {
  /** The scenario that created it, for example `L01`. */
  readonly scenarioId: string;
  /** `<runId>:<scenarioId>:<n>`; a repeated send is the same ticket. */
  readonly testId: string;
  readonly ticketId: string;
}

export interface HelpdeskTicketOptions {
  readonly persona: Persona;
  readonly text: { readonly title: string; readonly description: string };
  readonly testOverrides?: Record<string, unknown>;
  /** The number in the test ID (default: one more than this scenario's count). */
  readonly n?: number;
}

const tickets = new WeakMap<ScenarioContext, HelpdeskTicket[]>();
const foreign = new WeakMap<ScenarioContext, Set<string>>();
// One counter per scenario: two creations in flight must not take one number.
const counters = new WeakMap<ScenarioContext, Map<string, number>>();

/** The next number for this scenario's test ID, counted before the request. */
function nextNumber(context: ScenarioContext, scenarioId: string): number {
  const map = counters.get(context) ?? new Map<string, number>();
  const n = (map.get(scenarioId) ?? 0) + 1;
  map.set(scenarioId, n);
  counters.set(context, map);
  return n;
}

/** The tickets this run created through `createHelpdeskTicket`, in order. */
export const createdHelpdeskTickets = (context: ScenarioContext): readonly HelpdeskTicket[] =>
  tickets.get(context) ?? [];

/**
 * Records ticket IDs another scenario of this run owns without an app ticket
 * (the T5.C.02 contract incidents). T5.O.01 reports them as foreign, not as
 * orphans: the contract scenario created and closed them itself.
 */
export function noteForeignTickets(context: ScenarioContext, ids: readonly string[]): void {
  const set = foreign.get(context) ?? new Set<string>();
  for (const id of ids) set.add(id);
  foreign.set(context, set);
}

/** The ticket IDs a scenario of this run owns without an app ticket. */
export const foreignTickets = (context: ScenarioContext): ReadonlySet<string> =>
  foreign.get(context) ?? new Set<string>();

/**
 * The runner's start time, before any scenario or helpdesk ticket, in ms.
 */
export function runStartMs(context: ScenarioContext): number {
  return context.startedAt;
}

/**
 * Creates one ticket through `POST /api/internal/test-tickets` with the test
 * ID `<runId>:<scenarioId>:<n>` and records it for cleanup and T5.O.01. A
 * repeated test ID is the same ticket: the app answers `duplicate: true` and
 * the existing record is returned, not a second one.
 */
export async function createHelpdeskTicket(
  context: ScenarioContext,
  scenarioId: string,
  options: HelpdeskTicketOptions,
): Promise<HelpdeskTicket> {
  const n = options.n ?? nextNumber(context, scenarioId);
  const testId = `${context.runId}:${scenarioId}:${n}`;
  const { ticketId } = await context.client.createTestTicket({
    name: options.persona.name,
    email: options.persona.email,
    department: options.persona.department,
    title: options.text.title,
    description: `${options.text.description} (live run ${context.runId})`,
    testId,
    ...(options.testOverrides === undefined ? {} : { testOverrides: options.testOverrides }),
  });
  const existing = createdHelpdeskTickets(context).find((t) => t.ticketId === ticketId);
  const ticket = existing ?? { scenarioId, testId, ticketId };
  if (existing === undefined) tickets.set(context, [...createdHelpdeskTickets(context), ticket]);
  return ticket;
}

/** The guarded helper, built from `E2E_SERVICENOW_*` and this run's fetch. */
export const serviceNowOf = (context: ScenarioContext): E2eServiceNow =>
  createE2eServiceNow(context.config.servicenow, context.fetch);

/** The persona's ServiceNow email when the instance has one, else the fallback. */
export async function personaEmail(
  sn: E2eServiceNow,
  personaName: string,
  fallback: string,
): Promise<string> {
  try {
    return (await sn.userByName(personaName))?.["email"] || fallback;
  } catch {
    return fallback;
  }
}

/** The `not_run` result when a ServiceNow variable is unset, else undefined. */
export function serviceNowNotRun(context: ScenarioContext): ScenarioResult | undefined {
  const missing = missingServiceNowEnv(context.config);
  return missing.length > 0 ? { status: "not_run", evidence: { missing } } : undefined;
}

/** How long a ticket may take to reach `incident_created` (T5.L.01). */
export const INCIDENT_LIMIT_MS = 60_000;
export const POLL_MS = 1_000;
/** DoD table entry 1 and 2: a printer fault reaches its incident this fast. */
export const INCIDENT_DEADLINE_MS = 60_000;
/** A ticket still without an incident after this is also reported as late. */
export const INCIDENT_WAIT_MS = 120_000;

/** The printer fault of the spec, as demo.carol reports it. */
export const PRINTER_FAULT = {
  title: "Printer on level 2 is offline",
  description:
    "The printer by the second floor stairs shows a paper jam and will not print. " +
    "Two people cannot print their boarding passes.",
};

/**
 * Polls one ticket's view until it is `incident_created`, `incident_skipped_shadow`
 * or `failed`, or `limitMs` pass. Returns the last view read.
 */
export async function waitForIncident(
  context: ScenarioContext,
  ticketId: string,
  limitMs = INCIDENT_LIMIT_MS,
): Promise<InternalTicketView> {
  const start = context.now();
  for (;;) {
    const view = await context.client.ticket(ticketId);
    if (
      view.status === "incident_created" ||
      view.status === "incident_skipped_shadow" ||
      view.status === "failed"
    ) {
      return view;
    }
    if (context.now() - start >= limitMs) return view;
    await context.sleep(POLL_MS);
  }
}

/** The `incident_created` event time, or null. */
export function incidentCreatedAt(view: InternalTicketView): number | null {
  const event = view.events.find((e) => e.type === "incident_created");
  return event === undefined ? null : Date.parse(event.at);
}

export interface IncidentCleanup {
  /** Incidents already closed, or closed by this run now. */
  readonly closed: number;
  /** Reads or closes that failed; the incident may still be open. */
  readonly failed: number;
  /** Incidents still open when the rows were read again. */
  readonly open: number;
}

/**
 * Closes every `[E2E]` incident that carries one of `ticketIds`, for a
 * `finally` block, including an unexpected duplicate. One failed read or close
 * is counted and the rest go on; the rows are read again afterwards, so an
 * open incident is reported and never hidden. Incidents of other tickets, and
 * incidents without `[E2E]`, are never touched: `closeIncident` refuses them.
 * It never throws, so a cleanup failure cannot hide the assertion before it.
 */
export async function closeIncidents(
  sn: E2eServiceNow,
  ticketIds: readonly string[],
): Promise<IncidentCleanup> {
  let closed = 0;
  let failed = 0;
  for (const ticketId of ticketIds) {
    try {
      for (const incident of await sn.incidentsByCorrelationId(ticketId)) {
        if (incident.state === "7") {
          closed += 1;
          continue;
        }
        try {
          await sn.closeIncident(incident.sys_id);
          closed += 1;
        } catch {
          failed += 1;
        }
      }
    } catch {
      failed += 1;
    }
  }
  let open = 0;
  for (const ticketId of ticketIds) {
    try {
      open += (await sn.incidentsByCorrelationId(ticketId)).filter((i) => i.state !== "7").length;
    } catch {
      // A read that fails here is already counted; do not count it twice.
    }
  }
  return { closed, failed, open };
}

/** Adds the cleanup counts to the evidence and, on any gap, one named check. */
export function cleanupChecks(
  cleanup: IncidentCleanup | undefined,
  checks: string[],
  evidence: Evidence,
): Evidence {
  if (cleanup === undefined) return evidence;
  if (cleanup.failed > 0 || cleanup.open > 0) checks.push("cleanup-closed");
  return {
    ...evidence,
    cleanupClosed: cleanup.closed,
    cleanupFailed: cleanup.failed,
    cleanupOpen: cleanup.open,
  };
}

/**
 * Runs `body`, closes every incident the tickets it names created, and merges
 * the cleanup counts. The cleanup runs in `finally`, so a failed check or a
 * thrown error cannot leave an `[E2E]` incident open.
 */
export async function withCleanup(
  context: ScenarioContext,
  sn: E2eServiceNow,
  body: (ticketIds: string[]) => Promise<{ checks: string[]; evidence: Evidence }>,
): Promise<ScenarioResult> {
  const ticketIds: string[] = [];
  let outcome: { checks: string[]; evidence: Evidence } = { checks: [], evidence: {} };
  let cleanup: IncidentCleanup | undefined;
  try {
    outcome = await body(ticketIds);
  } finally {
    cleanup = await closeIncidents(sn, ticketIds);
  }
  return result(outcome.checks, cleanupChecks(cleanup, outcome.checks, outcome.evidence));
}

/**
 * Polls until the ticket is `review_pending` with a card, or has reached an end
 * state of the sync (`incident_created`, skipped in shadow mode, failed). The
 * canary scenarios use it, because their ticket text may route to review.
 */
export async function waitForReviewOrIncident(
  context: ScenarioContext,
  ticketId: string,
  limitMs: number,
): Promise<InternalTicketView> {
  const start = context.now();
  for (;;) {
    const view = await context.client.ticket(ticketId);
    const cardReview = view.reviews.some((r) => r.kind === "triage" && r.slackTs !== null);
    if (view.status === "review_pending" && cardReview) return view;
    if (
      view.status === "incident_created" ||
      view.status === "incident_skipped_shadow" ||
      view.status === "failed" ||
      context.now() - start >= limitMs
    ) {
      return view;
    }
    await context.sleep(POLL_MS);
  }
}

/** Polls the view until it holds a notification of `kind`, or the limit passes. */
export async function waitForNotification(
  context: ScenarioContext,
  ticketId: string,
  kind: InternalTicketView["notifications"][number]["kind"],
  limitMs: number,
): Promise<{
  view: InternalTicketView;
  notification: InternalTicketView["notifications"][number] | undefined;
}> {
  const start = context.now();
  for (;;) {
    const view = await context.client.ticket(ticketId);
    const notification = view.notifications.find((row) => row.kind === kind);
    if (notification !== undefined || context.now() - start >= limitMs) {
      return { view, notification };
    }
    await context.sleep(POLL_MS);
  }
}

export interface JudgeOutcome {
  readonly status: string;
  readonly score: number | null;
}

/** One judgment; the endpoint's refusal (422) is a status, never a throw. */
export async function judged(
  judge: JudgeClient,
  definition: JudgeDefinition,
  state: JsonState,
): Promise<JudgeOutcome> {
  try {
    const result = await judge.judge(definition, state);
    return { status: result.status, score: result.status === "completed" ? result.value : null };
  } catch (error) {
    // The judgments route refuses text redact() would change (422 unredacted_input).
    if (error instanceof LiveContractError) return { status: "refused", score: null };
    throw error;
  }
}
