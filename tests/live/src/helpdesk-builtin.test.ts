import { afterEach, expect, it } from "vitest";
import { builtinScenarios } from "./helpdesk-builtin.ts";
import { startHelpdeskHarness, type HelpdeskHarness } from "./testing/helpdesk-harness.ts";

const harnesses: HelpdeskHarness[] = [];
const ids = "T5.L.09,T5.L.10,T5.L.11,T5.S.06";
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

async function start(options: Parameters<typeof startHelpdeskHarness>[0] = {}) {
  const h = await startHelpdeskHarness({ builtinHelpdesk: true, ...options });
  harnesses.push(h);
  return h;
}

it("checks all four built-in scenarios without a ServiceNow request", async () => {
  const h = await start();
  const { code, report } = await h.run(["--only", ids]);
  expect(code).toBe(0);
  expect(report.scenarios.map((entry) => [entry.id, entry.status])).toEqual(
    ids.split(",").map((id) => [id, "pass"]),
  );
  expect(h.count("POST", "/api/internal/test-tickets")).toBe(5);
  expect(h.serviceNowMethods()).toEqual([]);
  expect(report.scenarios[1]?.evidence).toMatchObject({ createdEvents: 1 });
  expect(report.scenarios[3]?.evidence).toHaveProperty("logsSince");
});

it("does not create a ticket when the app is on ServiceNow", async () => {
  const h = await start({ builtinHelpdesk: false });
  const { report } = await h.run(["--only", "T5.L.09"], builtinScenarios);
  expect(report.scenarios[0]?.status).toBe("not_run");
  expect(h.count("POST", "/api/internal/test-tickets")).toBe(0);
});

it("rejects a late creation and a helpdesk write on a rejected ticket", async () => {
  const late = await start({ faults: { incidentAfterMs: () => 60_000 } });
  const rejected = await start({ faults: { syncRejected: () => true } });
  const l09 = await late.run(["--only", "T5.L.09"], builtinScenarios);
  const l11 = await rejected.run(["--only", "T5.L.11"], builtinScenarios);
  expect(l09.report.scenarios[0]?.evidence.failedChecks).toContain("builtin-within-60s");
  expect(l11.report.scenarios[0]?.evidence.failedChecks).toContain("rejected-no-helpdesk");
});

it("fails a canary in Slack without copying it into evidence", async () => {
  const h = await start();
  const marker = "078-05-1120";
  h.slack.messages.push({ ts: String(h.startedAt / 1000 + 5), text: marker });
  const { code, report, text } = await h.run(["--only", "T5.S.06"], builtinScenarios);
  expect(code).toBe(1);
  expect(report.scenarios[0]?.evidence.failedChecks).toContain("canary-in-slack");
  expect(text).not.toContain(marker);
});

it("fails a canary that appears only in a reply to the ticket's Slack review", async () => {
  const marker = "078-05-1120";
  const h = await start({ faults: { route: () => "review" }, reviewThreadText: marker });
  const { code, report, text } = await h.run(["--only", "T5.S.06"], builtinScenarios);
  expect(code).toBe(1);
  expect(report.scenarios[0]?.evidence.failedChecks).toContain("canary-in-slack");
  expect(text).not.toContain(marker);
});
