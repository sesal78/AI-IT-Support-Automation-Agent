// Phase 5 live scenarios, part one (P5-T5c): T5.L.01 the printer fault, and
// T5.L.03 the duplicate submit. Ticket text is synthetic and stays in the
// request bodies: evidence carries IDs, numbers, enums, counts and times in ms,
// plus the sum of aiCallCount, never ticket text.
import type { Evidence, Scenario, ScenarioContext, ScenarioResult } from "./runner.ts";
import {
  cleanupChecks,
  closeIncidents,
  createHelpdeskTicket,
  createdHelpdeskTickets,
  foreignTickets,
  incidentCreatedAt,
  type IncidentCleanup,
  PERSONAS,
  personaEmail,
  POLL_MS,
  runStartMs,
  serviceNowNotRun,
  serviceNowOf,
  waitForIncident,
} from "./helpdesk.ts";
import { p95, result } from "./pipeline.ts";
import { pool } from "./review-security.ts";
import { SIGN, slackNotRun } from "./review-flow.ts";
import { E2E_PREFIX, type E2eServiceNow } from "./servicenow.ts";
import { createSlackSigner, type Decision, type SendResult } from "./slack-signer.ts";
import { evalTicketSchema, type InternalTicketView } from "@ai-it-support/shared";
import { readFileSync } from "node:fs";

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

/** A ready review: the review with a card ts, or undefined when it never came. */
interface ReadyReview {
  readonly view: InternalTicketView;
  readonly review: InternalTicketView["reviews"][number] | undefined;
}

async function waitForReview(context: ScenarioContext, ticketId: string): Promise<ReadyReview> {
  const start = context.now();
  for (;;) {
    const view = await context.client.ticket(ticketId);
    const review = view.reviews.find((r) => r.kind === "triage" && r.slackTs !== null);
    if (view.status === "review_pending" && review !== undefined) return { view, review };
    if (view.status === "failed" || context.now() - start >= INCIDENT_WAIT_MS) {
      return { view, review };
    }
    await context.sleep(POLL_MS);
  }
}

async function waitForStatus(
  context: ScenarioContext,
  ticketId: string,
  status: string,
  limitMs: number,
): Promise<InternalTicketView> {
  const start = context.now();
  for (;;) {
    const view = await context.client.ticket(ticketId);
    if (view.status === status || view.status === "failed") return view;
    if (context.now() - start >= limitMs) return view;
    await context.sleep(POLL_MS);
  }
}

const eventAt = (view: InternalTicketView, type: string): number | null => {
  const event = view.events.find((e) => e.type === type);
  return event === undefined ? null : Date.parse(event.at);
};

/** Signs one decision as the e2e reviewer (P4-T6 helper) and sends it. */
async function sendDecision(
  context: ScenarioContext,
  review: { readonly id: string; readonly slackTs: string | null },
  decision: Decision,
): Promise<SendResult> {
  const signer = createSlackSigner(context.config, { client: context.client, now: context.now });
  return signer.send(
    signer.signedDecision({ reviewId: review.id, slackTs: review.slackTs!, decision }),
  );
}

/** How long a recorded decision may take to show in the view (P4 live value). */
export const DECISION_LIMIT_MS = 15_000;
/** How long an undecided review may take to reach `escalated_manual` (2m e2e + lag). */
export const ESCALATION_LIMIT_MS = 240_000;
/** After `rejected` or `escalated_manual`, incidents are checked after this wait. */
export const QUIET_MS = 60_000;

/** An HR complaint from demo.erin goes to review (plan §4.2). */
export const HR_COMPLAINT = {
  title: "Complaint about my manager",
  description:
    "I want to raise an HR complaint about repeated comments from my line manager. " +
    "Please handle this confidentially.",
};

/**
 * T5.L.04 (DoD 4): three HR tickets from demo.erin. A signed approve gets one
 * incident within 60 s of the decision; a signed reject and a ticket left to
 * the 2-minute timeout get none, checked 60 s after each end state.
 */
export const approveRejectTimeoutScenario: Scenario = {
  id: "T5.L.04",
  async run(context) {
    const notRun = slackNotRun(context, SIGN) ?? serviceNowNotRun(context);
    if (notRun) return notRun;
    const sn = serviceNowOf(context);
    return withCleanup(context, sn, async (ticketIds) => {
      const checks: string[] = [];
      const evidence: Evidence = {};
      const create = () =>
        createHelpdeskTicket(context, "L04", { persona: PERSONAS.erin, text: HR_COMPLAINT });
      const [a, b, c] = [await create(), await create(), await create()];
      ticketIds.push(a.ticketId, b.ticketId, c.ticketId);

      const readyA = await waitForReview(context, a.ticketId);
      const readyB = await waitForReview(context, b.ticketId);
      const readyC = await waitForReview(context, c.ticketId);
      if (
        readyA.review === undefined ||
        readyB.review === undefined ||
        readyC.review === undefined
      ) {
        return { checks: [...checks, "review-ready"], evidence };
      }

      // A: a signed approve, then one incident within 60 s of the decision.
      const sentA = await sendDecision(context, readyA.review, "approve");
      const approved = await waitForStatus(context, a.ticketId, "approved", DECISION_LIMIT_MS);
      const aView = await waitForIncident(context, a.ticketId, INCIDENT_WAIT_MS);
      const approvedAt = eventAt(approved, "review_decided");
      const createdA = incidentCreatedAt(aView);
      const incidentsA = await sn.incidentsByCorrelationId(a.ticketId);
      if (sentA.status !== 200 || sentA.outcome !== "recorded") checks.push("approved-recorded");
      if (aView.status !== "incident_created") checks.push("approved-incident");
      if (
        approvedAt === null ||
        createdA === null ||
        createdA - approvedAt > INCIDENT_DEADLINE_MS
      ) {
        checks.push("approved-within-60s");
      }
      if (incidentsA.length !== 1) checks.push("approved-one-incident");

      // B: a signed reject, then no incident 60 s later.
      const sentB = await sendDecision(context, readyB.review, "reject");
      const rejected = await waitForStatus(context, b.ticketId, "rejected", DECISION_LIMIT_MS);
      const rejectedAt = eventAt(rejected, "review_decided");
      if (rejectedAt !== null && rejectedAt + QUIET_MS > context.now()) {
        await context.sleep(rejectedAt + QUIET_MS - context.now());
      }
      const incidentsB = await sn.incidentsByCorrelationId(b.ticketId);
      if (sentB.status !== 200 || sentB.outcome !== "recorded") checks.push("rejected-recorded");
      if (rejected.status !== "rejected") checks.push("rejected-status");
      if (incidentsB.length !== 0) checks.push("rejected-no-incident");

      // C: no decision, so the 2-minute timeout escalates it; no incident 60 s later.
      const escalated = await waitForStatus(
        context,
        c.ticketId,
        "escalated_manual",
        ESCALATION_LIMIT_MS,
      );
      const timeoutAt = eventAt(escalated, "review_timed_out");
      if (timeoutAt !== null && timeoutAt + QUIET_MS > context.now()) {
        await context.sleep(timeoutAt + QUIET_MS - context.now());
      }
      const incidentsC = await sn.incidentsByCorrelationId(c.ticketId);
      if (escalated.status !== "escalated_manual") checks.push("timeout-escalated");
      if (incidentsC.length !== 0) checks.push("timeout-no-incident");

      Object.assign(evidence, {
        approvedTicketId: a.ticketId,
        rejectedTicketId: b.ticketId,
        timedOutTicketId: c.ticketId,
        approvedIncident: incidentsA[0]?.number ?? null,
        approvedMs: approvedAt === null || createdA === null ? null : createdA - approvedAt,
        incidentsApproved: incidentsA.length,
        incidentsRejected: incidentsB.length,
        incidentsTimedOut: incidentsC.length,
        aiCallCount: aView.aiCallCount + rejected.aiCallCount + escalated.aiCallCount,
        decisionOutcomes: `${sentA.outcome ?? sentA.status}/${sentB.outcome ?? sentB.status}`,
      });
      return { checks, evidence };
    });
  },
};

/**
 * T5.L.05 (DoD 6): `testOverrides: { shadowMode: true }` gives
 * `incident_skipped_shadow`, a `shadow_skipped` event and no incident.
 */
export const shadowModeScenario: Scenario = {
  id: "T5.L.05",
  async run(context) {
    const notRun = serviceNowNotRun(context);
    if (notRun) return notRun;
    const sn = serviceNowOf(context);
    return withCleanup(context, sn, async (ticketIds) => {
      const checks: string[] = [];
      const evidence: Evidence = {};
      const ticket = await createHelpdeskTicket(context, "L05", {
        persona: PERSONAS.carol,
        text: PRINTER_FAULT,
        testOverrides: { shadowMode: true },
      });
      ticketIds.push(ticket.ticketId);
      const view = await waitForIncident(context, ticket.ticketId, INCIDENT_WAIT_MS);
      const incidents = await sn.incidentsByCorrelationId(ticket.ticketId);
      const shadowEvent = view.events.some((e) => e.type === "shadow_skipped");
      if (view.status !== "incident_skipped_shadow") checks.push("status-incident-skipped-shadow");
      if (!shadowEvent) checks.push("shadow-skipped-event");
      if (incidents.length !== 0) checks.push("no-incidents");
      Object.assign(evidence, {
        ticketId: ticket.ticketId,
        status: view.status,
        shadowEvent,
        incidents: incidents.length,
        aiCallCount: view.aiCallCount,
      });
      return { checks, evidence };
    });
  },
};

const DATASET = new URL("../../../evals/tickets.json", import.meta.url);
export const L02_TICKETS = 10;
/** At most this many ticket creations are in flight (T5.L.02). */
export const L02_CONCURRENCY = 4;

/**
 * The 10 eval tickets that route `auto` live (resolved point 18). The dataset
 * has no `auto` label: they are the first 10 of the `normal` set, which carry
 * no sensitive topic and no `needs_info` or `injection_suspected` flag.
 */
export function autoEvalTickets(path: URL | string = DATASET) {
  const normal = evalTicketSchema
    .array()
    .parse(JSON.parse(readFileSync(path, "utf8")))
    .filter((t) => t.set === "normal");
  if (normal.length < L02_TICKETS) throw new RangeError("expected 10 normal eval tickets");
  return normal.slice(0, L02_TICKETS);
}

/**
 * T5.L.02 (DoD 1): the 10 auto eval tickets, at most 4 created at a time, each
 * reaches `incident_created`, and the p95 of (incident_created - createdAt) is
 * under 60 s. Seun chose on 2026-11-13 AEDT to keep the existing nearest-rank
 * p95, so with 10 values p95 is the maximum: all 10 must be under 60 000 ms.
 * A ticket that routes `review` fails, naming the eval ID.
 */
export const autoIncidentLatencyScenario: Scenario = {
  id: "T5.L.02",
  heavy: true,
  async run(context) {
    const notRun = serviceNowNotRun(context);
    if (notRun) return notRun;
    const sn = serviceNowOf(context);
    return withCleanup(context, sn, async (ticketIds) => {
      const checks: string[] = [];
      const evidence: Evidence = {};
      const created: Array<{ evalId: string; ticketId: string }> = [];
      await pool(autoEvalTickets(), L02_CONCURRENCY, async (t, index) => {
        const ticket = await createHelpdeskTicket(context, "L02", {
          persona: {
            name: t.name,
            email: `e2e-load+${index + 1}@example.com`,
            department: t.department,
          },
          text: { title: t.title, description: t.description },
        });
        created.push({ evalId: t.id, ticketId: ticket.ticketId });
        ticketIds.push(ticket.ticketId);
      });
      // Eval order, not finishing order.
      created.sort((x, y) => x.evalId.localeCompare(y.evalId));

      const views = new Map<string, InternalTicketView>();
      for (const { ticketId } of created) {
        views.set(ticketId, await waitForIncident(context, ticketId, INCIDENT_WAIT_MS));
      }

      const byEval = new Map<string, number>();
      const notCreated: string[] = [];
      const reviewRouted: string[] = [];
      let aiCallCount = 0;
      for (const { evalId, ticketId } of created) {
        const view = views.get(ticketId)!;
        aiCallCount += view.aiCallCount;
        if (view.triage?.route !== "auto") reviewRouted.push(evalId);
        const at = incidentCreatedAt(view);
        if (view.status !== "incident_created" || at === null) notCreated.push(evalId);
        else byEval.set(evalId, at - Date.parse(view.createdAt));
      }
      const latencies = [...byEval.values()];
      const p95Ms = latencies.length === L02_TICKETS ? p95(latencies) : null;
      const slowTickets = [...byEval.entries()]
        .filter(([, ms]) => ms >= INCIDENT_DEADLINE_MS)
        .map(([evalId]) => evalId);

      if (notCreated.length > 0) checks.push("all-incident-created");
      if (reviewRouted.length > 0) checks.push("route-auto");
      if (p95Ms === null || p95Ms >= INCIDENT_DEADLINE_MS) checks.push("p95-under-60s");

      Object.assign(evidence, {
        tickets: created.length,
        latenciesMs: latencies,
        p95Ms,
        maxMs: latencies.length > 0 ? Math.max(...latencies) : null,
        notCreated,
        reviewRouted,
        slowTickets,
        aiCallCount,
      });
      return { checks, evidence };
    });
  },
};

/**
 * T5.L.08 (after T5.L.02 in the same run): for those 10 tickets, the incident's
 * `assignment_group` is the `sys_id` of the triage group. It reads the closed
 * incidents T5.L.02 left behind and creates nothing. Without T5.L.02 in this
 * run it reports `not_run`.
 */
export const triageGroupScenario: Scenario = {
  id: "T5.L.08",
  heavy: true,
  async run(context) {
    const notRun = serviceNowNotRun(context);
    if (notRun) return notRun;
    const tickets = createdHelpdeskTickets(context).filter((t) => t.scenarioId === "L02");
    if (tickets.length === 0) return { status: "not_run", evidence: { reason: "l02-not-in-run" } };
    const sn = serviceNowOf(context);
    const checks: string[] = [];
    const mismatched: string[] = [];
    const unknownGroup: string[] = [];
    let matched = 0;
    let aiCallCount = 0;
    for (const ticket of tickets) {
      const view = await context.client.ticket(ticket.ticketId);
      aiCallCount += view.aiCallCount;
      const name = view.triage?.assignmentGroup ?? null;
      const group = name === null ? undefined : await sn.groupByName(name);
      if (group?.["sys_id"] === undefined) {
        unknownGroup.push(ticket.ticketId);
        continue;
      }
      const incidents = await sn.incidentsByCorrelationId(ticket.ticketId);
      if (incidents.length === 1 && incidents[0]!.assignment_group === group["sys_id"])
        matched += 1;
      else mismatched.push(ticket.ticketId);
    }
    if (mismatched.length > 0) checks.push("assignment-group");
    if (unknownGroup.length > 0) checks.push("triage-group-exists");
    return result(checks, {
      tickets: tickets.length,
      matched,
      mismatched,
      unknownGroup,
      aiCallCount,
    });
  },
};

/** An incident must appear within this time after the instance wakes (T5.F.01). */
export const ASLEEP_INCIDENT_LIMIT_MS = 600_000;
/** A ticket still without an incident after this is also reported as late. */
export const ASLEEP_WAIT_MS = 660_000;

/**
 * T5.F.01 (DoD 7, resolved points 9-10): with `helpdeskAsleepMinutes: 3` the
 * instance reports asleep, the ticket waits at `helpdesk_pending`, at least one
 * `helpdesk_asleep` event is written, and one incident appears within 10
 * minutes.
 */
export const asleepInstanceScenario: Scenario = {
  id: "T5.F.01",
  heavy: true,
  async run(context) {
    const notRun = serviceNowNotRun(context);
    if (notRun) return notRun;
    const sn = serviceNowOf(context);
    return withCleanup(context, sn, async (ticketIds) => {
      const checks: string[] = [];
      const evidence: Evidence = {};
      const ticket = await createHelpdeskTicket(context, "F01", {
        persona: PERSONAS.carol,
        text: PRINTER_FAULT,
        testOverrides: { helpdeskAsleepMinutes: 3 },
      });
      ticketIds.push(ticket.ticketId);

      const asleepEvents = (view: InternalTicketView) =>
        view.events.filter((e) => e.type === "helpdesk_asleep").length;
      let sawPendingWhileAsleep = false;
      let asleepCount = 0;
      const start = context.now();
      let view = await context.client.ticket(ticket.ticketId);
      for (;;) {
        asleepCount = Math.max(asleepCount, asleepEvents(view));
        if (view.status === "helpdesk_pending" && asleepEvents(view) > 0) {
          sawPendingWhileAsleep = true;
        }
        const done =
          view.status === "incident_created" ||
          view.status === "incident_skipped_shadow" ||
          view.status === "failed";
        if (done || context.now() - start >= ASLEEP_WAIT_MS) break;
        await context.sleep(POLL_MS);
        view = await context.client.ticket(ticket.ticketId);
      }

      const createdAt = Date.parse(view.createdAt);
      const created = incidentCreatedAt(view);
      const incidents = await sn.incidentsByCorrelationId(ticket.ticketId);
      if (asleepCount === 0) checks.push("helpdesk-asleep-event");
      if (!sawPendingWhileAsleep) checks.push("helpdesk-pending-while-asleep");
      if (view.status !== "incident_created") checks.push("status-incident-created");
      if (created === null || created - createdAt > ASLEEP_INCIDENT_LIMIT_MS) {
        checks.push("incident-created-within-10m");
      }
      if (incidents.length !== 1) checks.push("one-incident");
      Object.assign(evidence, {
        ticketId: ticket.ticketId,
        incidentNumber: incidents[0]?.number ?? null,
        status: view.status,
        asleepEvents: asleepCount,
        createdAtMs: created === null ? null : created - createdAt,
        incidents: incidents.length,
        aiCallCount: view.aiCallCount,
      });
      return { checks, evidence };
    });
  },
};

/**
 * T5.O.01 (runs last): every ticket of this run with an `incident_created`
 * event has exactly one incident whose `correlation_id` is the ticket ID, and
 * every `[E2E]` incident created since the run started has such a ticket. It
 * reads the closed incidents too, reports a truncated read instead of trusting
 * a partial list, and closes nothing.
 */
export const reconciliationScenario: Scenario = {
  id: "T5.O.01",
  async run(context) {
    const notRun = serviceNowNotRun(context);
    if (notRun) return notRun;
    const sn = serviceNowOf(context);
    const checks: string[] = [];
    const tickets = createdHelpdeskTickets(context);
    const owned = new Set(tickets.map((t) => t.ticketId));
    const foreign = foreignTickets(context);
    const withoutIncident: string[] = [];
    const wrongCount: string[] = [];
    let withIncident = 0;
    let incidentCount = 0;
    let aiCallCount = 0;

    for (const ticket of tickets) {
      const view = await context.client.ticket(ticket.ticketId);
      aiCallCount += view.aiCallCount;
      if (!view.events.some((e) => e.type === "incident_created")) {
        withoutIncident.push(ticket.ticketId);
        continue;
      }
      withIncident += 1;
      const incidents = await sn.incidentsByCorrelationId(ticket.ticketId);
      incidentCount += incidents.length;
      if (incidents.length !== 1) wrongCount.push(ticket.ticketId);
    }
    if (wrongCount.length > 0) checks.push("ticket-incidents");

    let orphans: string[] = [];
    let truncated = false;
    try {
      const page = await sn.e2eIncidentsSince(runStartMs(context));
      truncated = page.truncated;
      orphans = page.incidents
        .filter((i) => !owned.has(i.correlation_id) && !foreign.has(i.correlation_id))
        .map((i) => i.number);
    } catch {
      checks.push("incident-read");
    }
    if (truncated) checks.push("not-truncated");
    if (orphans.length > 0) checks.push("orphans");

    return result(checks, {
      tickets: tickets.length,
      withIncident,
      withoutIncident,
      ticketIncidents: incidentCount,
      wrongCount,
      orphans,
      foreign: foreign.size,
      truncated,
      aiCallCount,
    });
  },
};

export const helpdeskScenarios: readonly Scenario[] = [
  printerFaultScenario,
  duplicateSubmitScenario,
  approveRejectTimeoutScenario,
  shadowModeScenario,
  autoIncidentLatencyScenario,
  triageGroupScenario,
  asleepInstanceScenario,
  reconciliationScenario,
];
