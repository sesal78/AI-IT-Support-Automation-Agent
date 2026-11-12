// T5.L.01 and T5.L.03 (P5-T5c) through runLive, against the mocks only: the
// positive case, and every acceptance negative with the check it must name.
import { afterEach, describe, expect, it } from "vitest";
import { duplicateSubmitScenario, printerFaultScenario } from "./helpdesk-scenarios.ts";
import type { Scenario } from "./runner.ts";
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
