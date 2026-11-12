// T5.L.01 and T5.L.03 (P5-T5c) through runLive, against the mocks only: the
// positive case, and every acceptance negative with the check it must name.
import { afterEach, describe, expect, it } from "vitest";
import {
  approveRejectTimeoutScenario,
  autoEvalTickets,
  duplicateSubmitScenario,
  L02_TICKETS,
  printerFaultScenario,
  shadowModeScenario,
} from "./helpdesk-scenarios.ts";
import type { Scenario } from "./runner.ts";
import { createRegistry, selectScenarios } from "./runner.ts";
import { scenarios } from "./scenarios.ts";
import { startHelpdeskHarness, type HelpdeskHarness } from "./testing/helpdesk-harness.ts";
import type { MockHelpdeskFaults } from "./testing/mock-helpdesk.ts";
import { sysId } from "./testing/mock-servicenow.ts";

const harnesses: HelpdeskHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});
async function harness(options: Parameters<typeof startHelpdeskHarness>[0] = {}) {
  const h = await startHelpdeskHarness(options);
  harnesses.push(h);
  return h;
}

const RUN = "run-mock-helpdesk";
const evidenceOf = (report: { scenarios: readonly { evidence: Record<string, unknown> }[] }) =>
  report.scenarios[0]!.evidence;
const failedChecks = (report: { scenarios: readonly { evidence: Record<string, unknown> }[] }) =>
  evidenceOf(report)["failedChecks"];

describe("T5.L.01 printer fault", () => {
  it("passes against the mocks with one hardware incident, the persona caller and one note", async () => {
    const h = await harness();
    const { code, report, text } = await h.run([], [printerFaultScenario]);
    expect(code).toBe(0);
    expect(evidenceOf(report)).toMatchObject({
      status: "incident_created",
      creationMs: 7_000,
      incidents: 1,
      workNotes: 1,
      category: "hardware",
      aiCallCount: 1,
      cleanupClosed: 1,
      cleanupOpen: 0,
      failedChecks: [],
    });
    expect(evidenceOf(report)["incidentNumber"]).toBe("INC0000001");
    // The incident is closed, and no ticket text is anywhere in the report.
    expect(h.data.incidents.every((i) => i["state"] === "7")).toBe(true);
    expect(h.count("POST", "/api/internal/test-tickets")).toBe(1);
    expect(h.count("POST", "/api/tickets")).toBe(0);
    expect(text).not.toContain("paper jam");
    expect(text).not.toContain("boarding passes");
  });

  it.each([
    [
      "the incident comes after 61 s",
      { incidentAfterMs: () => 55_000 },
      "incident-created-within-60s",
      61_000,
    ],
    ["the category is software", { category: () => "software" }, "category-hardware", 7_000],
    ["the caller is the default caller", { caller: () => sysId(1) }, "caller-persona", 7_000],
    ["there are two incidents", { incidents: () => 2 }, "one-incident", 7_000],
    ["the work note is missing", { workNotes: () => 0 }, "one-work-note", 7_000],
    [
      "the correlation display is not the number",
      { correlationDisplay: () => "ITS-999999" },
      "correlation-display",
      7_000,
    ],
  ] as const)("fails, naming the check, when %s", async (_case, faults, check, creationMs) => {
    const h = await harness({ faults: faults as MockHelpdeskFaults });
    const { code, report } = await h.run([], [printerFaultScenario]);
    expect(code).toBe(1);
    expect(failedChecks(report)).toContain(check);
    expect(evidenceOf(report)["creationMs"]).toBe(creationMs);
    // Cleanup still ran, whatever the finding.
    expect(evidenceOf(report)["cleanupOpen"]).toBe(0);
    expect(h.data.incidents.every((i) => i["state"] === "7")).toBe(true);
  });

  it("still closes the incident when a check throws", async () => {
    const h = await harness();
    const broken: Scenario = {
      ...printerFaultScenario,
      async run(context) {
        await printerFaultScenario.run(context);
        throw new RangeError("after the scenario");
      },
    };
    const { report } = await h.run([], [broken]);
    expect(report.scenarios[0]).toMatchObject({ status: "fail", error: "RangeError" });
    expect(h.data.incidents.every((i) => i["state"] === "7")).toBe(true);
  });

  it("is not_run, with no request, when the ServiceNow variables are unset", async () => {
    const h = await harness({ withServiceNow: false });
    const { code, report } = await h.run([], [printerFaultScenario]);
    expect(code).toBe(2);
    expect(report.scenarios[0]).toMatchObject({ status: "not_run" });
    expect(h.count("POST", "/api/internal/test-tickets")).toBe(0);
  });
});

describe("T5.L.03 duplicate submit", () => {
  it("passes with one ticket and one incident", async () => {
    const h = await harness();
    const { code, report } = await h.run([], [duplicateSubmitScenario]);
    expect(code).toBe(0);
    expect(evidenceOf(report)).toMatchObject({
      status: "incident_created",
      incidents: 1,
      sameTicket: true,
      cleanupClosed: 1,
      failedChecks: [],
    });
    expect(h.count("POST", "/api/internal/test-tickets")).toBe(2);
    expect([...h.helpdesk.tickets.keys()]).toEqual([`${RUN}:L03:1`]);
  });

  it("fails, naming the check, when the duplicate creates a second incident", async () => {
    const h = await harness({ faults: { incidents: () => 2 } });
    const { code, report } = await h.run([], [duplicateSubmitScenario]);
    expect(code).toBe(1);
    expect(failedChecks(report)).toEqual(["one-incident"]);
    expect(evidenceOf(report)["incidents"]).toBe(2);
    // Both are closed: cleanup covers an unexpected duplicate.
    expect(evidenceOf(report)["cleanupClosed"]).toBe(2);
  });
});

describe("T5.L.04 approve, reject and timeout", () => {
  it("passes for 1 incident from the approve and 0 from the reject and the timeout", async () => {
    const h = await harness();
    const { code, report } = await h.run([], [approveRejectTimeoutScenario]);
    expect(code).toBe(0);
    expect(evidenceOf(report)).toMatchObject({
      incidentsApproved: 1,
      incidentsRejected: 0,
      incidentsTimedOut: 0,
      decisionOutcomes: "recorded/recorded",
      cleanupClosed: 1,
      cleanupOpen: 0,
      failedChecks: [],
    });
    expect(evidenceOf(report)["approvedMs"]).toBe(2_000);
    expect(h.count("POST", "/api/slack/interactivity")).toBe(2);
    expect(h.data.incidents).toHaveLength(1);
    expect(h.data.incidents[0]!["state"]).toBe("7");
  });

  it("fails, naming the check, when the rejected ticket gets an incident", async () => {
    const h = await harness({ faults: { syncRejected: (id) => id.endsWith(":L04:2") } });
    const { code, report } = await h.run([], [approveRejectTimeoutScenario]);
    expect(code).toBe(1);
    expect(failedChecks(report)).toEqual(["rejected-no-incident"]);
    expect(evidenceOf(report)["incidentsRejected"]).toBe(1);
    // The unexpected incident is still closed.
    expect(h.data.incidents.every((i) => i["state"] === "7")).toBe(true);
  });

  it("fails, naming the check, when the timed-out ticket gets an incident", async () => {
    const h = await harness({ faults: { syncRejected: (id) => id.endsWith(":L04:3") } });
    const { code, report } = await h.run([], [approveRejectTimeoutScenario]);
    expect(code).toBe(1);
    expect(failedChecks(report)).toEqual(["timeout-no-incident"]);
    expect(evidenceOf(report)["incidentsTimedOut"]).toBe(1);
  });

  it("is not_run, with no ticket, when a Slack signer variable is unset", async () => {
    const h = await harness({ withSlack: false });
    const { code, report } = await h.run([], [approveRejectTimeoutScenario]);
    expect(code).toBe(2);
    expect(report.scenarios[0]).toMatchObject({ status: "not_run" });
    expect(h.count("POST", "/api/internal/test-tickets")).toBe(0);
  });
});

describe("T5.L.02 auto incident latency and T5.L.08 triage group", () => {
  it("uses the first 10 normal eval tickets whose labels permit auto routing", () => {
    const tickets = autoEvalTickets();
    expect(tickets).toHaveLength(L02_TICKETS);
    expect(tickets.every((t) => t.expected.sensitiveTopic === null)).toBe(true);
    expect(tickets.every((t) => t.expected.route === null)).toBe(true);
    expect(tickets.map((t) => t.id)).toEqual([
      "E001",
      "E002",
      "E003",
      "E005",
      "E006",
      "E007",
      "E008",
      "E009",
      "E010",
      "E011",
    ]);
    expect(new Set(tickets.map((t) => t.id)).size).toBe(L02_TICKETS);
  });

  it("passes with 10 incidents, a p95 of 7 s, and at most 4 creations in flight", async () => {
    const h = await harness({ delayMs: 10 });
    const { code, report } = await h.run(["--only", "T5.L.02"]);
    expect(code).toBe(0);
    expect(evidenceOf(report)).toMatchObject({
      tickets: 10,
      p95Ms: 7_000,
      maxMs: 7_000,
      notCreated: [],
      reviewRouted: [],
      slowTickets: [],
      cleanupClosed: 10,
      cleanupOpen: 0,
      failedChecks: [],
    });
    expect(evidenceOf(report)["latenciesMs"]).toHaveLength(10);
    expect(h.e2e.peakInFlightOf("POST /api/internal/test-tickets")).toBeLessThanOrEqual(4);
    expect(h.e2e.peakInFlightOf("POST /api/internal/test-tickets")).toBeGreaterThan(1);
    expect(h.count("POST", "/api/internal/test-tickets")).toBe(10);
    expect(h.data.incidents.every((i) => i["state"] === "7")).toBe(true);
  });

  it.each([
    [54_000, 60_000],
    [55_000, 61_000],
  ])("fails when the slowest latency is %i ms (p95 %i)", async (slowFault, p95Ms) => {
    const h = await harness({
      faults: { incidentAfterMs: (id) => (id.endsWith(":L02:10") ? slowFault : 1_000) },
    });
    const { code, report } = await h.run(["--only", "T5.L.02"]);
    expect(code).toBe(1);
    expect(failedChecks(report)).toEqual(["p95-under-60s"]);
    expect(evidenceOf(report)["p95Ms"]).toBe(p95Ms);
    expect(evidenceOf(report)["slowTickets"]).toEqual(["E011"]);
  });

  it("fails, naming the eval ID, when a ticket routes review", async () => {
    const h = await harness({
      faults: { route: (id) => (id.endsWith(":L02:2") ? "review" : "auto") },
    });
    const { code, report } = await h.run(["--only", "T5.L.02"]);
    expect(code).toBe(1);
    expect(failedChecks(report)).toContain("route-auto");
    expect(evidenceOf(report)["reviewRouted"]).toEqual(["E002"]);
  });

  it("T5.L.08 passes for the 10 closed incidents T5.L.02 left behind", async () => {
    const h = await harness();
    const { code, report } = await h.run(["--only", "T5.L.02,T5.L.08"]);
    expect(code).toBe(0);
    expect(report.scenarios.map((s) => s.status)).toEqual(["pass", "pass"]);
    expect(report.scenarios[1]!.evidence).toMatchObject({
      tickets: 10,
      matched: 10,
      mismatched: [],
      unknownGroup: [],
      failedChecks: [],
    });
  });

  it("T5.L.08 fails, naming the ticket, when one group differs", async () => {
    const h = await harness({
      faults: { assignmentGroup: (id) => (id.endsWith(":L02:3") ? "Network" : "Software") },
    });
    const { code, report } = await h.run(["--only", "T5.L.02,T5.L.08"]);
    expect(code).toBe(1);
    expect(report.scenarios[1]!.status).toBe("fail");
    expect(report.scenarios[1]!.evidence).toMatchObject({
      matched: 9,
      failedChecks: ["assignment-group"],
    });
    expect(report.scenarios[1]!.evidence["mismatched"]).toHaveLength(1);
  });

  it("T5.L.08 is not_run when T5.L.02 did not run", async () => {
    const h = await harness();
    const { code, report } = await h.run(["--only", "T5.L.08"]);
    expect(code).toBe(2);
    expect(report.scenarios[0]).toMatchObject({
      status: "not_run",
      evidence: { reason: "l02-not-in-run" },
    });
    expect(h.count("POST", "/api/internal/test-tickets")).toBe(0);
  });
});

describe("T5.L.05 shadow mode", () => {
  it("passes for no incident, the skipped status and the shadow event", async () => {
    const h = await harness();
    const { code, report } = await h.run([], [shadowModeScenario]);
    expect(code).toBe(0);
    expect(evidenceOf(report)).toMatchObject({
      status: "incident_skipped_shadow",
      shadowEvent: true,
      incidents: 0,
      cleanupClosed: 0,
      failedChecks: [],
    });
    expect(h.data.incidents).toEqual([]);
  });

  it("fails, naming the check, when the mock creates an incident", async () => {
    const h = await harness({ faults: { createInShadow: true } });
    const { code, report } = await h.run([], [shadowModeScenario]);
    expect(code).toBe(1);
    expect(failedChecks(report)).toEqual(["no-incidents"]);
    expect(evidenceOf(report)["incidents"]).toBe(1);
    // The leaked incident is closed anyway.
    expect(h.data.incidents[0]!["state"]).toBe("7");
  });
});

describe("T5.F.01 asleep instance and T5.O.01 reconciliation", () => {
  it("T5.F.01 passes when the instance sleeps for 3 minutes and then creates one incident", async () => {
    const h = await harness();
    const { code, report } = await h.run(["--only", "T5.F.01"]);
    expect(code).toBe(0);
    expect(evidenceOf(report)).toMatchObject({
      status: "incident_created",
      incidents: 1,
      createdAtMs: 181_000,
      cleanupClosed: 1,
      cleanupOpen: 0,
      failedChecks: [],
    });
    expect(evidenceOf(report)["asleepEvents"]).toBe(3);
    expect(h.data.incidents.every((i) => i["state"] === "7")).toBe(true);
  });

  it("T5.F.01 fails when no helpdesk_asleep event is written", async () => {
    const h = await harness({ faults: { asleepWithoutEvent: true } });
    const { code, report } = await h.run(["--only", "T5.F.01"]);
    expect(code).toBe(1);
    expect(failedChecks(report)).toContain("helpdesk-asleep-event");
    expect(evidenceOf(report)["asleepEvents"]).toBe(0);
  });

  it("T5.F.01 fails when the ticket has no incident at the 10-minute limit", async () => {
    const h = await harness({ faults: { asleepExtraMs: () => 480_000 } });
    const { code, report } = await h.run(["--only", "T5.F.01"]);
    expect(code).toBe(1);
    expect(failedChecks(report)).toContain("incident-created-within-10m");
    expect(evidenceOf(report)["status"]).not.toBe("incident_created");
  });

  it("T5.O.01 passes after the default scenarios and closes nothing itself", async () => {
    const h = await harness();
    const { code, report } = await h.run(["--phase", "5"]);
    expect(code).toBe(0);
    const reconciliation = report.scenarios.find((s) => s.id === "T5.O.01")!;
    expect(reconciliation.status).toBe("pass");
    expect(reconciliation.evidence).toMatchObject({
      tickets: 6,
      withIncident: 3,
      ticketIncidents: 3,
      wrongCount: [],
      orphans: [],
      truncated: false,
    });
    // Every incident of the run, including the contract suite's, is closed.
    expect(h.data.incidents.every((i) => i["state"] === "7")).toBe(true);
  });

  it("T5.O.01 fails when an incident has no matching ticket", async () => {
    const h = await harness({ faults: { orphan: (id) => id.endsWith(":L01:1") } });
    const { code, report } = await h.run(["--only", "T5.L.01,T5.O.01"]);
    expect(code).toBe(1);
    const reconciliation = report.scenarios.find((s) => s.id === "T5.O.01")!;
    expect(reconciliation.evidence["failedChecks"]).toEqual(["orphans"]);
    expect(reconciliation.evidence["orphans"]).toHaveLength(1);
  });

  it("T5.O.01 fails when a ticket has two incidents", async () => {
    const h = await harness({ faults: { incidents: () => 2 } });
    const { code, report } = await h.run(["--only", "T5.L.01,T5.O.01"]);
    expect(code).toBe(1);
    const reconciliation = report.scenarios.find((s) => s.id === "T5.O.01")!;
    expect(reconciliation.evidence["failedChecks"]).toEqual(["ticket-incidents"]);
    expect(reconciliation.evidence["wrongCount"]).toHaveLength(1);
  });

  it("T5.O.01 reports a full page instead of trusting it", async () => {
    const h = await harness();
    const page = Array.from({ length: 1_000 }, (_, i) => ({
      sys_id: sysId(2_000 + i),
      number: `INC${String(2_000 + i).padStart(7, "0")}`,
      category: "software",
      caller_id: sysId(1),
      assignment_group: "",
      short_description: "[E2E] page filler",
      description: "d",
      state: "7",
      correlation_id: "11111111-2222-3333-4444-555555555555",
      correlation_display: "ITS-000999",
      sys_created_on: "2026-11-13 00:00:00",
    }));
    h.data.incidents.push(...page);
    const { report } = await h.run(["--only", "T5.O.01"]);
    expect(report.scenarios[0]!.evidence["truncated"]).toBe(true);
    expect(report.scenarios[0]!.evidence["failedChecks"]).toContain("not-truncated");
  });
});

describe("the phase 5 selection", () => {
  const registry = createRegistry(scenarios);
  const ids = (argv: string[]) => selectScenarios(registry, argv).map((s) => s.id);

  it("--phase 5 selects the six light phase 5 scenarios, with T5.O.01 last", () => {
    expect(ids(["--phase", "5"])).toEqual([
      "T5.C.02",
      "T5.L.01",
      "T5.L.03",
      "T5.L.04",
      "T5.L.05",
      "T5.O.01",
    ]);
  });

  it("the three heavy phase 5 scenarios are left out unless named", () => {
    for (const id of ["T5.L.02", "T5.L.08", "T5.F.01"]) {
      expect(registry.get(id)?.heavy).toBe(true);
      expect(ids(["--phase", "5"])).not.toContain(id);
      expect(ids([])).not.toContain(id);
      expect(ids(["--only", id])).toEqual([id]);
    }
  });

  it("--phase 5 creates 6 tickets with 7 test-ticket requests and no form submit", async () => {
    const h = await harness();
    const { code } = await h.run(["--phase", "5"]);
    expect(code).toBe(0);
    // The spec's "6 requests" counts tickets; T5.L.03 sends its testId twice.
    expect(h.helpdesk.tickets.size).toBe(6);
    expect(h.count("POST", "/api/internal/test-tickets")).toBe(7);
    expect(h.count("POST", "/api/tickets")).toBe(0);
  });
});
