// P5-T5c shared steps: create a helpdesk ticket on the test path, keep the
// tickets a run created, and wait for the incident. Evidence carries IDs,
// numbers, enums, counts and times only, never ticket text.
import type { InternalTicketView } from "@ai-it-support/shared";
import { missingServiceNowEnv } from "./config.ts";
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
const runStarted = new WeakMap<ScenarioContext, number>();

/** The tickets this run created through `createHelpdeskTicket`, in order. */
export const createdHelpdeskTickets = (context: ScenarioContext): readonly HelpdeskTicket[] =>
  tickets.get(context) ?? [];

/**
 * When this run first created a helpdesk ticket, in ms. It is read once, at
 * the start, so T5.O.01 reconciles the whole run and not only its own part.
 */
export function runStartMs(context: ScenarioContext): number {
  const started = runStarted.get(context);
  if (started !== undefined) return started;
  const now = context.now();
  runStarted.set(context, now);
  return now;
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
  runStartMs(context);
  const known = createdHelpdeskTickets(context).filter((t) => t.scenarioId === scenarioId);
  const n = options.n ?? known.length + 1;
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

/** The `not_run` result when a ServiceNow variable is unset, else undefined. */
export function serviceNowNotRun(context: ScenarioContext): ScenarioResult | undefined {
  const missing = missingServiceNowEnv(context.config);
  return missing.length > 0 ? { status: "not_run", evidence: { missing } } : undefined;
}

/** How long a ticket may take to reach `incident_created` (T5.L.01). */
export const INCIDENT_LIMIT_MS = 60_000;
export const POLL_MS = 1_000;

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
