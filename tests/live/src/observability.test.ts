import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildCanaries, canaryTicketText } from "@ai-it-support/shared";
import { afterEach, describe, expect, it } from "vitest";
import { canaryRunId, LOG_EXPORTS, O01_TICKETS, observabilityScenarios } from "./observability.ts";
import { runLive, type LiveReport, type ReportEntry } from "./runner.ts";
import { markerEnv } from "./testing/env.ts";
import { startMockE2e, type MockE2e, type MockE2eOptions } from "./testing/mock-e2e.ts";
import {
  cleanObservation,
  startMockLangfuse,
  type MockObservation,
} from "./testing/mock-langfuse.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0)) await step();
});

type Rows = (rows: MockObservation[], mock: MockE2e) => MockObservation[];

async function setup(
  options: {
    rows?: Rows;
    langfuseKeys?: "right" | "wrong" | "unset";
    pipeline?: MockE2eOptions["pipeline"];
  } = {},
) {
  const dir = join(mkdtempSync(join(tmpdir(), "live-observability-")), ".loop-evidence");
  cleanup.push(() => rmSync(dirname(dir), { recursive: true, force: true }));
  let time = Date.parse("2026-10-19T10:00:00.000Z");
  const clock = { now: () => time, sleep: async (ms: number) => void (time += ms) };
  const values = markerEnv("http://127.0.0.1:1");
  const mock = await startMockE2e({
    token: values.INTERNAL_API_TOKEN,
    accessClientId: values.CF_ACCESS_CLIENT_ID,
    accessClientSecret: values.CF_ACCESS_CLIENT_SECRET,
    now: clock.now,
    pipeline: options.pipeline,
  });
  cleanup.push(() => mock.close());
  const langfuse = startMockLangfuse({
    origin: new URL(values.LANGFUSE_BASE_URL).origin,
    publicKey: values.LANGFUSE_PUBLIC_KEY,
    secretKey:
      options.langfuseKeys === "wrong" ? `Other${"w".repeat(20)}` : values.LANGFUSE_SECRET_KEY,
    observations: () => {
      const rows = [...mock.testTickets.values()].map((t) => cleanObservation(t.ticketId));
      return options.rows ? options.rows(rows, mock) : rows;
    },
  });
  const unset = options.langfuseKeys === "unset";
  const env = {
    ...values,
    E2E_BASE_URL: mock.origin,
    STAGING_BASE_URL: undefined,
    ...(unset ? { LANGFUSE_PUBLIC_KEY: undefined, LANGFUSE_SECRET_KEY: undefined } : {}),
  };
  const output: string[] = [];
  const one = async (
    id: string,
    runId = "run-obs1",
  ): Promise<{ code: number; entry: ReportEntry; text: string }> => {
    const code = await runLive({
      argv: ["--only", id],
      env,
      scenarios: observabilityScenarios,
      evidenceDir: dir,
      stdout: (line) => output.push(line),
      stderr: (line) => output.push(line),
      fetch: langfuse.fetch,
      now: clock.now,
      sleep: clock.sleep,
      runId,
    });
    const live = join(dir, "live");
    const texts = readdirSync(live).map((name) => readFileSync(join(live, name), "utf8"));
    const report = JSON.parse(readFileSync(join(live, `${runId}.json`), "utf8")) as LiveReport;
    const text = [...output, ...texts].join("\n");
    for (const [key, value] of Object.entries(values)) {
      if (key !== "E2E_BASE_URL") expect(text.includes(value), `${key} leaked`).toBe(false);
    }
    return { code, entry: report.scenarios[0]!, text };
  };
  return { mock, langfuse, one };
}

/** The ticket ID of the test ticket whose testId ends with `suffix`. */
const ticketOf = (mock: MockE2e, suffix: string) =>
  [...mock.testTickets.values()].find((t) => t.testId.endsWith(suffix))!.ticketId;

const expectIdsOnly = (entry: ReportEntry) => {
  for (const value of Object.values(entry.evidence).flat()) {
    if (typeof value === "string") expect(value).toMatch(/^[A-Za-z0-9._:/-]+$/);
    else expect(value === null || ["number", "boolean"].includes(typeof value)).toBe(true);
  }
};

describe("canaryRunId", () => {
  it("keeps the last 12 lower-case letters and digits of the run ID", () => {
    expect(canaryRunId("run-1")).toBe("run1");
    expect(canaryRunId("2026-10-19T10-00-00-000Z-a1b2c3d4")).toBe("000za1b2c3d4");
    expect(canaryRunId("2026-10-19T10-00-00-000Z-a1b2c3d4")).toMatch(/^[a-z0-9]{12}$/);
  });

  it("throws for a run ID with fewer than 4 letters or digits", () => {
    expect(() => canaryRunId("a-b-")).toThrow(RangeError);
  });
});

describe("T3.L.04", () => {
  it("passes when Langfuse holds only redacted text, and names the log exports to scan", async () => {
    const h = await setup();
    const { code, entry } = await h.one("T3.L.04");
    expect(code).toBe(0);
    const ticket = [...h.mock.testTickets.values()][0]!;
    expect(ticket.testId).toBe("run-obs1:L04:1");
    expect(String(ticket.body["description"])).toContain(canaryTicketText("runobs1"));
    expect(entry).toMatchObject({
      status: "pass",
      evidence: {
        ticketId: ticket.ticketId,
        canaryRunId: "runobs1",
        scanSince: "2026-10-19T10:00:00.000Z",
        aiCallCount: 1,
        observationsFound: 1,
        observationsScanned: 1,
        scanExit: 0,
        hardHits: 0,
        hardObservationIds: [],
        logExports: [...LOG_EXPORTS],
        logsSince: "2026-10-19T10:00:00.000Z",
        failedChecks: [],
      },
    });
    // The scan reads by time; the presence check reads by session.
    expect(
      h.langfuse.requests.some((u) => u.searchParams.get("sessionId") === ticket.ticketId),
    ).toBe(true);
    expect(
      h.langfuse.requests.some(
        (u) => u.searchParams.get("fromStartTime") === "2026-10-19T10:00:00.000Z",
      ),
    ).toBe(true);
    expectIdsOnly(entry);
  });

  it("fails when one observation holds the run's email canary, without printing it", async () => {
    const email = buildCanaries("runobs1").find((c) => c.type === "email")!.value;
    const h = await setup({
      rows: (rows) => [...rows, { ...rows[0]!, id: "obs-leak", output: `Reply to ${email}` }],
    });
    const { code, entry, text } = await h.one("T3.L.04");
    expect(code).toBe(1);
    expect(entry.evidence).toMatchObject({
      scanExit: 1,
      hardObservationIds: ["obs-leak"],
      failedChecks: ["trace-scan-hard-hits"],
    });
    expect((entry.evidence["hardHits"] as number) >= 1).toBe(true);
    expect(text).not.toContain(email);
  });

  it("fails closed when the Langfuse API refuses the keys", async () => {
    const h = await setup({ langfuseKeys: "wrong" });
    const { code, entry } = await h.one("T3.L.04");
    expect(code).toBe(1);
    expect(entry).toMatchObject({ status: "fail", error: "TraceApiError" });
  });

  it("fails when no observation of the ticket reaches Langfuse", async () => {
    const h = await setup({ rows: () => [] });
    const { code, entry } = await h.one("T3.L.04");
    expect(code).toBe(1);
    expect(entry.evidence).toMatchObject({
      observationsFound: 0,
      scanExit: 2,
      failedChecks: ["observations-present", "trace-scan-not-proven"],
    });
  });

  it("is not run when the Langfuse keys are unset", async () => {
    const h = await setup({ langfuseKeys: "unset" });
    const { code, entry } = await h.one("T3.L.04");
    expect(code).toBe(2);
    expect(entry).toMatchObject({ status: "not_run", evidence: { missing: "langfuse-keys" } });
    expect(h.mock.testTickets.size).toBe(0);
  });
});

describe("T3.O.01", () => {
  it("passes when each of the 5 tickets has as many observations as its aiCallCount", async () => {
    const h = await setup();
    const { code, entry } = await h.one("T3.O.01");
    expect(code).toBe(0);
    const ids = [...h.mock.testTickets.values()].map((t) => t.ticketId);
    expect(ids).toHaveLength(O01_TICKETS);
    expect([...h.mock.testTickets.keys()]).toEqual(
      Array.from({ length: 5 }, (_, i) => `run-obs1:O01:${i + 1}`),
    );
    expect(entry).toMatchObject({
      status: "pass",
      evidence: {
        ticketIds: ids,
        aiCallCounts: [1, 1, 1, 1, 1],
        observationCounts: [1, 1, 1, 1, 1],
        failedChecks: [],
      },
    });
    const fields = h.langfuse.requests.map((u) => u.searchParams.get("fields"));
    expect(fields.every((f) => f === "core,basic,io,metadata,model,usage")).toBe(true);
    expectIdsOnly(entry);
  });

  const second =
    (change: (row: MockObservation) => MockObservation[]): Rows =>
    (rows, mock) => {
      const id = ticketOf(mock, ":O01:2");
      return rows.flatMap((row) => (row.sessionId === id ? change(row) : [row]));
    };

  it.each<[string, Rows]>([
    ["count", second((row) => [row, { ...row, id: `${row.id}-extra` }])],
    ["model", second((row) => [{ ...row, model: null }])],
    ["tokens", second((row) => [{ ...row, usageDetails: { input: 120, output: 0 } }])],
    ["environment", second((row) => [{ ...row, environment: "production" }])],
    [
      "input-hit",
      second((row) => [{ ...row, input: `SSN ${buildCanaries("runobs1")[0]!.value}` }]),
    ],
  ])("fails with %s:<ticket ID> for the ticket that is off", async (check, rows) => {
    const h = await setup({ rows });
    const { code, entry } = await h.one("T3.O.01");
    expect(code).toBe(1);
    expect(entry.evidence["failedChecks"]).toEqual([`${check}:${ticketOf(h.mock, ":O01:2")}`]);
  });

  /** Ticket 2 made 2 AI calls: its first LLM request failed and was retried. */
  const retried: MockE2eOptions["pipeline"] = (ticket, d) =>
    String(ticket.body["testId"]).endsWith(":O01:2") ? { ...d, aiCallCount: 2 } : d;
  const failedAttempt = (row: MockObservation): MockObservation => ({
    ...row,
    id: `${row.id}-failed`,
    level: "ERROR",
    statusMessage: "LlmError",
    usageDetails: {},
    output: undefined,
  });

  it("passes for a retried ticket: 1 failed and 1 successful observation, aiCallCount 2", async () => {
    const h = await setup({ pipeline: retried, rows: second((row) => [failedAttempt(row), row]) });
    const { code, entry } = await h.one("T3.O.01");
    expect(code).toBe(0);
    expect(entry.evidence).toMatchObject({
      aiCallCounts: [1, 2, 1, 1, 1],
      observationCounts: [1, 2, 1, 1, 1],
      failedChecks: [],
    });
  });

  it("still fails tokens:<ticket ID> for a successful observation with 0 tokens beside a failed one", async () => {
    const h = await setup({
      pipeline: retried,
      rows: second((row) => [
        failedAttempt(row),
        { ...row, usageDetails: { input: 120, output: 0 } },
      ]),
    });
    const { code, entry } = await h.one("T3.O.01");
    expect(code).toBe(1);
    expect(entry.evidence["failedChecks"]).toEqual([`tokens:${ticketOf(h.mock, ":O01:2")}`]);
  });

  it("still counts a failed observation against aiCallCount", async () => {
    const h = await setup({ rows: second((row) => [failedAttempt(row), row]) });
    const { code, entry } = await h.one("T3.O.01");
    expect(code).toBe(1);
    expect(entry.evidence["failedChecks"]).toEqual([`count:${ticketOf(h.mock, ":O01:2")}`]);
  });

  it("fails naming the ticket when an observation is missing after the wait", async () => {
    const h = await setup({ rows: second(() => []) });
    const { code, entry } = await h.one("T3.O.01");
    expect(code).toBe(1);
    expect(entry.evidence).toMatchObject({
      observationCounts: [1, 0, 1, 1, 1],
      failedChecks: [`count:${ticketOf(h.mock, ":O01:2")}`],
    });
  });

  it("fails naming the ticket that never reaches triaged", async () => {
    const h = await setup({
      pipeline: (ticket, d) =>
        String(ticket.body["testId"]).endsWith(":O01:4") ? { ...d, triagedAfterMs: null } : d,
    });
    const { code, entry } = await h.one("T3.O.01");
    expect(code).toBe(1);
    expect(entry.evidence).toMatchObject({
      aiCallCounts: [1, 1, 1, 0, 1],
      observationCounts: [1, 1, 1, 0, 1],
      failedChecks: [`triaged:${ticketOf(h.mock, ":O01:4")}`],
    });
  });
});
