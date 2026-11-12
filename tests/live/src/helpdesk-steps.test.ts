// P5-T5c shared steps (3/6): creating helpdesk tickets on the test path, the
// run's ticket list and the wait for the incident. Each probe runs through
// runLive against the mocks; no host is reached.
import { afterEach, describe, expect, it } from "vitest";
import {
  createHelpdeskTicket,
  createdHelpdeskTickets,
  incidentCreatedAt,
  PERSONAS,
  runStartMs,
  serviceNowNotRun,
  serviceNowOf,
  waitForIncident,
} from "./helpdesk.ts";
import { result } from "./pipeline.ts";
import type { Evidence, Scenario, ScenarioContext, ScenarioResult } from "./runner.ts";
import { startHelpdeskHarness, type HelpdeskHarness } from "./testing/helpdesk-harness.ts";

const PRINTER = {
  title: "Printer on level 2 is offline",
  description: "The printer shows a paper jam and will not print.",
};

const harnesses: HelpdeskHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});
async function harness(options: Parameters<typeof startHelpdeskHarness>[0] = {}) {
  const h = await startHelpdeskHarness(options);
  harnesses.push(h);
  return h;
}

const evidenceOf = (report: { scenarios: readonly { evidence: Record<string, unknown> }[] }) =>
  report.scenarios[0]!.evidence;

/** A probe with the shape every helpdesk scenario uses: create, wait, read. */
function probe(
  id: string,
  body: (context: ScenarioContext, checks: string[], evidence: Evidence) => Promise<void>,
): Scenario {
  return {
    id,
    async run(context): Promise<ScenarioResult> {
      const notRun = serviceNowNotRun(context);
      if (notRun) return notRun;
      const checks: string[] = [];
      const evidence: Evidence = {};
      await body(context, checks, evidence);
      return result(checks, evidence);
    },
  };
}

const printerProbe = probe("T9.L.01", async (context, checks, evidence) => {
  const sn = serviceNowOf(context);
  const ticket = await createHelpdeskTicket(context, "L01", {
    persona: PERSONAS.carol,
    text: PRINTER,
  });
  const view = await waitForIncident(context, ticket.ticketId);
  const incidents = await sn.incidentsByCorrelationId(ticket.ticketId);
  const created = incidentCreatedAt(view);
  const notes = incidents[0] === undefined ? [] : await sn.workNotes(incidents[0].sys_id);
  if (view.status !== "incident_created") checks.push("incident-created");
  if (incidents.length !== 1) checks.push("one-incident");
  if (incidents[0]?.category !== "hardware") checks.push("category");
  if (incidents[0]?.correlation_display !== view.number) checks.push("correlation-display");
  if (notes.length !== 1) checks.push("work-note");
  Object.assign(evidence, {
    ticketId: ticket.ticketId,
    incidentNumber: incidents[0]?.number ?? null,
    creationMs: created === null ? null : created - Date.parse(view.createdAt),
    incidents: incidents.length,
    workNotes: notes.length,
    category: incidents[0]?.category ?? null,
    aiCallCount: view.aiCallCount,
  });
});

describe("createHelpdeskTicket", () => {
  it("sends the printer ticket and the mock answers with one [E2E] incident", async () => {
    const h = await harness();
    const { code, report } = await h.run([], [printerProbe]);
    expect(code).toBe(0);
    expect(evidenceOf(report)).toMatchObject({
      creationMs: 7_000,
      incidents: 1,
      workNotes: 1,
      category: "hardware",
      aiCallCount: 1,
      failedChecks: [],
    });
    expect(evidenceOf(report)["ticketId"]).toBe(
      h.helpdesk.tickets.get("run-mock-helpdesk:L01:1")!.ticketId,
    );
    expect(h.count("POST", "/api/internal/test-tickets")).toBe(1);
    expect(h.data.incidents[0]!["short_description"]).toBe("[E2E] Printer on level 2 is offline");
  });

  it("numbers the tickets of one scenario 1, 2 in the test ID", async () => {
    const h = await harness();
    const two = probe("T9.L.02", async (context) => {
      for (let i = 0; i < 2; i++) {
        await createHelpdeskTicket(context, "L02", { persona: PERSONAS.carol, text: PRINTER });
      }
    });
    expect((await h.run([], [two])).code).toBe(0);
    expect([...h.helpdesk.tickets.keys()]).toEqual([
      "run-mock-helpdesk:L02:1",
      "run-mock-helpdesk:L02:2",
    ]);
  });

  it("sends a repeated test ID twice and keeps one ticket, one record", async () => {
    const h = await harness();
    const twice = probe("T9.L.03", async (context, _checks, evidence) => {
      const options = { persona: PERSONAS.carol, text: PRINTER, n: 1 };
      const first = await createHelpdeskTicket(context, "L03", options);
      const second = await createHelpdeskTicket(context, "L03", options);
      await waitForIncident(context, first.ticketId);
      Object.assign(evidence, {
        sameTicketId: first.ticketId === second.ticketId,
        tracked: createdHelpdeskTickets(context).length,
      });
    });
    const { report } = await h.run([], [twice]);
    expect(evidenceOf(report)).toMatchObject({ sameTicketId: true, tracked: 1, failedChecks: [] });
    expect(h.count("POST", "/api/internal/test-tickets")).toBe(2);
    expect(h.helpdesk.tickets.size).toBe(1);
    expect(h.data.incidents).toHaveLength(1);
  });

  it("records the run start once, at the first ticket, and never moves it", async () => {
    const h = await harness();
    const once = probe("T9.L.04", async (context, _checks, evidence) => {
      const first = runStartMs(context);
      await context.sleep(5_000);
      Object.assign(evidence, { first, again: runStartMs(context) });
    });
    const { report } = await h.run([], [once]);
    expect(evidenceOf(report)["first"]).toBe(evidenceOf(report)["again"]);
    expect(evidenceOf(report)["first"]).toBe(h.startedAt);
  });

  it("is not_run with no request when a ServiceNow variable is unset", async () => {
    const h = await harness({ withServiceNow: false });
    const { code, report } = await h.run([], [printerProbe]);
    expect(code).toBe(2);
    expect(report.scenarios[0]).toMatchObject({
      status: "not_run",
      evidence: {
        missing: [
          "E2E_SERVICENOW_INSTANCE_URL",
          "E2E_SERVICENOW_USERNAME",
          "E2E_SERVICENOW_PASSWORD",
        ],
      },
    });
    expect(h.count("POST", "/api/internal/test-tickets")).toBe(0);
  });
});
