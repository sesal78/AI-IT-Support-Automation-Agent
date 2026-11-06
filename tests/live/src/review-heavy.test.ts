// T4.L.05 and T4.F.01 (P4-T8d) through runLive, against the mocks only, and
// the runner selection of the heavy scenarios.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { f01File, L05_TICKETS, sensitiveEvalTickets } from "./review-heavy.ts";
import { createRegistry, selectScenarios } from "./runner.ts";
import { scenarios } from "./scenarios.ts";
import {
  startReviewHarness,
  type ReviewHarness,
  type ReviewHarnessOptions,
} from "./testing/review-harness.ts";

const harnesses: ReviewHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});
async function harness(options: ReviewHarnessOptions = {}) {
  const h = await startReviewHarness(options);
  harnesses.push(h);
  return h;
}

const RUN_ID = "run-mock-0001";
const HEAVY = ["T4.L.05", "T4.F.01:start", "T4.F.01:finish"];
const evidenceOf = (report: { scenarios: readonly { evidence: Record<string, unknown> }[] }) =>
  report.scenarios[0]!.evidence;

describe("heavy selection", () => {
  const registry = createRegistry(scenarios);
  const ids = (argv: string[]) => selectScenarios(registry, argv).map((s) => s.id);

  it("the default run and --phase 4 select none of the three", () => {
    for (const id of HEAVY) {
      expect(registry.get(id)?.heavy).toBe(true);
      expect(ids([])).not.toContain(id);
      expect(ids(["--phase", "4"])).not.toContain(id);
    }
  });

  it("--only selects them", () => {
    expect(ids(["--only", "T4.L.05"])).toEqual(["T4.L.05"]);
    expect(ids(["--only", "T4.F.01:start"])).toEqual(["T4.F.01:start"]);
  });
});

describe("T4.L.05 sensitive replay", () => {
  it("uses the 20 sensitive eval tickets", () => {
    const tickets = sensitiveEvalTickets();
    expect(tickets).toHaveLength(L05_TICKETS);
    expect(tickets.every((t) => t.expected.sensitiveTopic !== null)).toBe(true);
  });

  it("passes when the mock gives 20 cards, with at most 5 creations in flight", async () => {
    const h = await harness({ delayMs: 10 });
    const { code, report, text } = await h.run(["--only", "T4.L.05"]);
    expect(code).toBe(0);
    const evidence = evidenceOf(report);
    expect(evidence).toMatchObject({
      tickets: 20,
      cards: 20,
      missingCards: [],
      slowTickets: [],
      maxLatencyMs: 1_000,
      p95LatencyMs: 1_000,
      aiCallCount: 40,
      failedChecks: [],
    });
    expect(evidence["latenciesMs"]).toHaveLength(20);
    expect(h.count("POST", "/api/internal/test-tickets")).toBe(20);
    expect(h.e2e.peakInFlightOf("POST /api/internal/test-tickets")).toBeLessThanOrEqual(5);
    expect(h.e2e.peakInFlightOf("POST /api/internal/test-tickets")).toBeGreaterThan(1);
    expect([...h.review.tickets.keys()]).toContain(`${RUN_ID}:L05:E065`);
    // The tickets are left to time out: no decision is sent.
    expect(h.review.interactivityRequests()).toBe(0);
    // No ticket text in the report.
    for (const t of sensitiveEvalTickets()) expect(text).not.toContain(t.title);
  });

  it("fails, naming the eval ID, when one card is missing", async () => {
    const h = await harness({ faults: { hideCard: (id) => id.endsWith(":L05:E065") } });
    const { code, report } = await h.run(["--only", "T4.L.05"]);
    expect(code).toBe(1);
    expect(evidenceOf(report)).toMatchObject({
      cards: 19,
      missingCards: ["E065"],
      failedChecks: ["all-cards"],
    });
  });

  it("waits for review_requested when the card ts comes first (the real task order)", async () => {
    const h = await harness({ faults: { requestedEventLagMs: 400 } });
    const { code, report } = await h.run(["--only", "T4.L.05"]);
    expect(code).toBe(0);
    expect(evidenceOf(report)).toMatchObject({
      cards: 20,
      missingTimes: [],
      maxLatencyMs: 1_400,
      failedChecks: [],
    });
    expect(evidenceOf(report)["latenciesMs"]).toHaveLength(20);
  });

  it("fails, naming the ticket, when one latency is 11 seconds", async () => {
    const h = await harness({
      faults: { reviewAfterMs: (id) => (id.endsWith(":L05:E070") ? 11_000 : 1_000) },
    });
    const { code, report } = await h.run(["--only", "T4.L.05"]);
    expect(code).toBe(1);
    const slow = h.review.tickets.get(`${RUN_ID}:L05:E070`)!.id;
    expect(evidenceOf(report)).toMatchObject({
      slowTickets: [slow],
      maxLatencyMs: 11_000,
      failedChecks: ["latency-at-most-10s"],
    });
  });
});

describe("T4.F.01 waiting run", () => {
  it("start writes the three IDs and nothing else; finish approves from that file", async () => {
    const h = await harness();
    const start = await h.run(["--only", "T4.F.01:start"]);
    expect(start.code).toBe(0);
    const ticket = h.review.tickets.get(`${RUN_ID}:F01:1`)!;
    expect(ticket.timeoutLabel).toBe("30m");
    const file = f01File(h.dir, RUN_ID);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      ticketId: ticket.id,
      reviewId: ticket.review!.id,
      slackTs: ticket.review!.slackTs,
    });
    const finish = await h.run(
      ["--only", "T4.F.01:finish", "--from", file],
      undefined,
      "run-mock-0002",
    );
    expect(finish.code).toBe(0);
    expect(evidenceOf(finish.report)).toMatchObject({
      responseStatus: 200,
      decidedMs: 500,
      status: "approved",
    });
    expect(ticket.status).toBe("approved");
  });

  it("finish passes when approved comes after 7 seconds (the real waitpoint resume)", async () => {
    const h = await harness({ faults: { decisionDelayMs: 7_000 } });
    await h.run(["--only", "T4.F.01:start"]);
    const finish = await h.run(
      ["--only", "T4.F.01:finish", `--from=${f01File(h.dir, RUN_ID)}`],
      undefined,
      "run-mock-0002",
    );
    expect(finish.code).toBe(0);
    expect(evidenceOf(finish.report)["decidedMs"]).toBe(7_000);
  });

  it("finish fails when the status is not approved within 15 seconds", async () => {
    const h = await harness({ faults: { decisionDelayMs: 16_000 } });
    await h.run(["--only", "T4.F.01:start"]);
    const finish = await h.run(
      ["--only", "T4.F.01:finish", `--from=${f01File(h.dir, RUN_ID)}`],
      undefined,
      "run-mock-0002",
    );
    expect(finish.code).toBe(1);
    expect(evidenceOf(finish.report)["failedChecks"]).toEqual(["approved-within-limit"]);
  });

  it("start writes no file when the card is missing", async () => {
    const h = await harness({ faults: { hideCard: () => true } });
    const { code, report } = await h.run(["--only", "T4.F.01:start"]);
    expect(code).toBe(1);
    expect(evidenceOf(report)["failedChecks"]).toEqual(["card-in-history"]);
    expect(existsSync(f01File(h.dir, RUN_ID))).toBe(false);
  });

  it("finish fails with a usage message when --from is missing", async () => {
    const h = await harness();
    expect(await h.exitCode(["--only", "T4.F.01:finish"])).toBe(2);
    expect(h.stderr.join("\n")).toContain("T4.F.01:finish needs --from <file>");
    expect(h.e2e.requests).toEqual([]);
  });

  it.each([
    ["does not parse", "{not json"],
    [
      "has another key",
      JSON.stringify({ ticketId: "x", reviewId: "y", slackTs: "1.1", note: "z" }),
    ],
  ])("finish fails with a usage message when the file %s", async (_case, content) => {
    const h = await harness();
    const file = join(h.dir, "..", "bad-f01.json");
    writeFileSync(file, content);
    const { code, report } = await h.run(["--only", "T4.F.01:finish", "--from", file]);
    expect(code).toBe(1);
    expect(report.scenarios[0]).toMatchObject({ status: "fail", error: "UsageError" });
    expect(h.stderr.join("\n")).toContain(
      "T4.F.01:finish: --from: the file is not a T4.F.01:start file",
    );
    expect(h.e2e.requests).toEqual([]);
  });

  it("refuses --from for a scenario that reads no file", async () => {
    const h = await harness();
    expect(await h.exitCode(["--only", "T4.L.05", "--from", "x.json"])).toBe(2);
    expect(h.stderr.join("\n")).toContain("--from is only for a scenario that reads a file");
  });
});
