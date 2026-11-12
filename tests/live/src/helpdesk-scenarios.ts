// Phase 5 live scenarios, part one (P5-T5c): T5.L.01 the printer fault, and
// T5.L.03 the duplicate submit. Ticket text is synthetic and stays in the
// request bodies: evidence carries IDs, numbers, enums, counts and times in ms,
// plus the sum of aiCallCount, never ticket text.
import type { Evidence, Scenario, ScenarioContext, ScenarioResult } from "./runner.ts";
import {
  cleanupChecks,
  closeIncidents,
  createHelpdeskTicket,
  incidentCreatedAt,
  type IncidentCleanup,
  PERSONAS,
  personaEmail,
  serviceNowNotRun,
  serviceNowOf,
  waitForIncident,
} from "./helpdesk.ts";
import { result } from "./pipeline.ts";
import { E2E_PREFIX, type E2eServiceNow } from "./servicenow.ts";

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

/** Runs the body, closes what it created, and merges the cleanup counts. */
async function withCleanup(
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
 * T5.L.01 (DoD 1, 2 and 5): the printer fault as demo.carol becomes exactly
 * one [E2E] incident within 60 s of the ticket's `createdAt`, with the category
 * `hardware`, the persona's caller, the view's number as `correlation_display`
 * and one work note.
 */
export const printerFaultScenario: Scenario = {
  id: "T5.L.01",
  async run(context) {
    const notRun = serviceNowNotRun(context);
    if (notRun) return notRun;
    const sn = serviceNowOf(context);
    return withCleanup(context, sn, async (ticketIds) => {
      const checks: string[] = [];
      const evidence: Evidence = {};
      const email = await personaEmail(sn, PERSONAS.carol.name, PERSONAS.carol.email);
      const ticket = await createHelpdeskTicket(context, "L01", {
        persona: { ...PERSONAS.carol, email },
        text: PRINTER_FAULT,
      });
      ticketIds.push(ticket.ticketId);

      const view = await waitForIncident(context, ticket.ticketId, INCIDENT_WAIT_MS);
      const createdAt = Date.parse(view.createdAt);
      const created = incidentCreatedAt(view);
      const incidents = await sn.incidentsByCorrelationId(ticket.ticketId);
      const incident = incidents.length === 1 ? incidents[0] : undefined;
      const carol = await sn.userByName(PERSONAS.carol.name);
      const notes = incident === undefined ? [] : await sn.workNotes(incident.sys_id);
      const creationMs = created === null ? null : created - createdAt;

      if (view.status !== "incident_created") checks.push("status-incident-created");
      if (creationMs === null || creationMs > INCIDENT_DEADLINE_MS) {
        checks.push("incident-created-within-60s");
      }
      if (incidents.length !== 1) checks.push("one-incident");
      if (incident?.category !== "hardware") checks.push("category-hardware");
      if (incident === undefined || incident.caller_id !== carol?.["sys_id"]) {
        checks.push("caller-persona");
      }
      if (incident === undefined || !incident.short_description.startsWith(E2E_PREFIX)) {
        checks.push("short-description-e2e");
      }
      if (incident === undefined || incident.correlation_display !== view.number) {
        checks.push("correlation-display");
      }
      if (notes.length !== 1) checks.push("one-work-note");

      Object.assign(evidence, {
        ticketId: ticket.ticketId,
        incidentNumber: incident?.number ?? null,
        status: view.status,
        creationMs,
        incidents: incidents.length,
        workNotes: notes.length,
        category: incident?.category ?? null,
        aiCallCount: view.aiCallCount,
      });
      return { checks, evidence };
    });
  },
};

/**
 * T5.L.03 (DoD 3): the same `testId` sent twice is one ticket and one incident.
 * The second answer is `duplicate: true` and the app returns the first ticket.
 */
export const duplicateSubmitScenario: Scenario = {
  id: "T5.L.03",
  async run(context) {
    const notRun = serviceNowNotRun(context);
    if (notRun) return notRun;
    const sn = serviceNowOf(context);
    return withCleanup(context, sn, async (ticketIds) => {
      const checks: string[] = [];
      const evidence: Evidence = {};
      const options = {
        persona: PERSONAS.carol,
        text: PRINTER_FAULT,
      };
      const first = await createHelpdeskTicket(context, "L03", options);
      const second = await createHelpdeskTicket(context, "L03", { ...options, n: 1 });
      ticketIds.push(first.ticketId);

      const view = await waitForIncident(context, first.ticketId);
      const incidents = await sn.incidentsByCorrelationId(first.ticketId);
      if (first.ticketId !== second.ticketId) checks.push("one-ticket");
      if (view.status !== "incident_created") checks.push("status-incident-created");
      if (incidents.length !== 1) checks.push("one-incident");

      Object.assign(evidence, {
        ticketId: first.ticketId,
        incidentNumber: incidents[0]?.number ?? null,
        status: view.status,
        incidents: incidents.length,
        sameTicket: first.ticketId === second.ticketId,
        aiCallCount: view.aiCallCount,
      });
      return { checks, evidence };
    });
  },
};

export const helpdeskScenarios: readonly Scenario[] = [
  printerFaultScenario,
  duplicateSubmitScenario,
];
