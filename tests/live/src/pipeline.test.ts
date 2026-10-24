import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FORM_WINDOW_MS } from "./pacer.ts";
import {
  CATEGORY_SAMPLES,
  L02_TICKETS,
  p95,
  pipelineScenarios,
  TRIAGE_LIMIT_MS,
} from "./pipeline.ts";
import { runLive, type LiveReport, type ReportEntry } from "./runner.ts";
import { scenarios } from "./scenarios.ts";
import { securityScenarios } from "./security.ts";
import { markerEnv } from "./testing/env.ts";
import {
  defaultTicketOutcome,
  startMockE2e,
  type MockE2e,
  type MockE2eOptions,
} from "./testing/mock-e2e.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0)) await step();
});

/** A fake clock shared by the mock and the runner: sleeping moves time on at once. */
function fakeClock(start = Date.parse("2026-10-18T10:00:00.000Z")) {
  let time = start;
  return {
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
    },
    get elapsed() {
      return time - start;
    },
  };
}

async function setup(pipeline?: MockE2eOptions["pipeline"], override?: MockE2eOptions["override"]) {
  const dir = join(mkdtempSync(join(tmpdir(), "live-pipeline-")), ".loop-evidence");
  cleanup.push(() => rmSync(dirname(dir), { recursive: true, force: true }));
  const clock = fakeClock();
  const values = markerEnv("http://127.0.0.1:1");
  const mock = await startMockE2e({
    token: values.INTERNAL_API_TOKEN,
    accessClientId: values.CF_ACCESS_CLIENT_ID,
    accessClientSecret: values.CF_ACCESS_CLIENT_SECRET,
    now: clock.now,
    pipeline,
    override,
  });
  cleanup.push(() => mock.close());
  const env = { ...values, E2E_BASE_URL: mock.origin, STAGING_BASE_URL: undefined };
  const stdout: string[] = [];
  const stderr: string[] = [];
  const run = async (argv: string[], runId?: string) => {
    const code = await runLive({
      argv,
      env,
      scenarios,
      evidenceDir: dir,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      now: clock.now,
      sleep: clock.sleep,
      runId,
    });
    const live = join(dir, "live");
    const texts = readdirSync(live)
      .filter((name) => name !== "form-pacer.json")
      .map((name) => readFileSync(join(live, name), "utf8"));
    const report = JSON.parse(
      readFileSync(join(live, `${runId ?? JSON.parse(texts.at(-1)!).runId}.json`), "utf8"),
    ) as LiveReport;
    return { code, report, texts };
  };
  const one = async (
    id: string,
    runId = "run-1",
  ): Promise<{ code: number; entry: ReportEntry }> => {
    const { code, report } = await run(["--only", id], runId);
    return { code, entry: report.scenarios[0]! };
  };
  return { values, mock, clock, run, one, stdout, stderr };
}

const posts = (mock: MockE2e, path: string) =>
  mock.requests.filter((r) => r.method === "POST" && r.path === path);
const bodies = (mock: MockE2e, path: string) =>
  posts(mock, path).map((r) => JSON.parse(r.body) as Record<string, unknown>);

describe("p95", () => {
  it("is 19 for the values 1…20 (nearest rank), in any order", () => {
    const values = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(p95(values)).toBe(19);
    expect(p95([...values].reverse())).toBe(19);
    expect(p95([7])).toBe(7);
  });

  it("throws for an empty list", () => {
    expect(() => p95([])).toThrow(RangeError);
  });
});

describe("pipeline scenario registry", () => {
  it("registers the four pipeline IDs", () => {
    expect(pipelineScenarios.map((s) => s.id)).toEqual([
      "T3.L.02",
      "T3.L.03",
      "T3.F.01",
      "T3.S.04",
    ]);
    expect(scenarios.map((s) => s.id)).toEqual(
      expect.arrayContaining(["T3.S.02", "T3.L.02", "T3.S.04"]),
    );
  });
});

describe("T3.L.02", () => {
  it("passes when every ticket is triaged in 5 s, with p95, min, max and the 20 IDs", async () => {
    const h = await setup();
    const { code, entry } = await h.one("T3.L.02", "run-l02");
    expect(code).toBe(0);
    const created = posts(h.mock, "/api/internal/test-tickets");
    expect(created).toHaveLength(L02_TICKETS);
    expect(bodies(h.mock, "/api/internal/test-tickets").map((b) => b["testId"])).toEqual(
      Array.from({ length: 20 }, (_, i) => `run-l02:L02:${i + 1}`),
    );
    const titles = new Set(bodies(h.mock, "/api/internal/test-tickets").map((b) => b["title"]));
    expect(titles).toEqual(new Set(CATEGORY_SAMPLES.map((s) => s.title)));
    // The mock redacts after 1 s and triages after 5 s: 4 s from redacted to triaged.
    expect(entry).toMatchObject({
      status: "pass",
      evidence: {
        tickets: 20,
        triaged: 20,
        p95Ms: 4000,
        minMs: 4000,
        maxMs: 4000,
        failedChecks: [],
      },
    });
    const ids = entry.evidence.ticketIds as string[];
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20);
  });

  it("fails, naming the ticket ID, when one ticket never reaches triaged", async () => {
    const h = await setup((ticket, defaults) =>
      ticket.body["testId"] === "run-1:L02:7" ? { ...defaults, triagedAfterMs: null } : defaults,
    );
    const { code, entry } = await h.one("T3.L.02");
    expect(code).toBe(1);
    const ids = entry.evidence.ticketIds as string[];
    expect(entry).toMatchObject({
      status: "fail",
      evidence: { triaged: 19, notTriaged: [ids[6]], failedChecks: ["all-triaged"] },
    });
    // It waited out the 120-second limit on the fake clock.
    expect(h.clock.elapsed).toBeGreaterThanOrEqual(TRIAGE_LIMIT_MS);
  });

  it("fails when the p95 is 31 seconds", async () => {
    const h = await setup((_, defaults) => ({
      ...defaults,
      triagedAfterMs: defaults.redactedAfterMs + 31_000,
    }));
    const { code, entry } = await h.one("T3.L.02");
    expect(code).toBe(1);
    expect(entry).toMatchObject({
      status: "fail",
      evidence: { triaged: 20, p95Ms: 31_000, failedChecks: ["p95-under-30s"] },
    });
  });
});

describe("T3.L.03", () => {
  it("passes for the route review plus the flag hr, sent as demo.erin", async () => {
    const h = await setup();
    const { code, entry } = await h.one("T3.L.03");
    expect(code).toBe(0);
    expect(entry).toMatchObject({
      status: "pass",
      evidence: { route: "review", sensitiveFlags: ["hr"], failedChecks: [] },
    });
    const [body] = bodies(h.mock, "/api/internal/test-tickets");
    expect(body).toMatchObject({ name: "demo.erin", testId: "run-1:L03:1" });
  });

  it("fails when the route is auto", async () => {
    const h = await setup((_, defaults) => ({ ...defaults, route: "auto" }));
    const { code, entry } = await h.one("T3.L.03");
    expect(code).toBe(1);
    expect(entry.evidence).toMatchObject({ route: "auto", failedChecks: ["route-review"] });
  });

  it("fails when the hr flag is missing", async () => {
    const h = await setup((_, defaults) => ({ ...defaults, sensitiveFlags: [] }));
    const { code, entry } = await h.one("T3.L.03");
    expect(code).toBe(1);
    expect(entry.evidence).toMatchObject({ sensitiveFlags: [], failedChecks: ["flag-hr"] });
  });
});

describe("T3.F.01", () => {
  it("passes when the ticket is triaged with a trace_export_failed event", async () => {
    const h = await setup();
    const { code, entry } = await h.one("T3.F.01");
    expect(code).toBe(0);
    expect(entry.evidence).toMatchObject({ triaged: true, traceExportFailed: true });
    expect(bodies(h.mock, "/api/internal/test-tickets")[0]).toMatchObject({
      testOverrides: { langfuseDown: true },
    });
  });

  it("fails when the event is absent", async () => {
    const h = await setup((_, defaults) => ({ ...defaults, extraEvents: [] }));
    const { code, entry } = await h.one("T3.F.01");
    expect(code).toBe(1);
    expect(entry.evidence).toMatchObject({
      traceExportFailed: false,
      failedChecks: ["trace-export-failed-event"],
    });
  });

  it("fails when the ticket ends as failed", async () => {
    const h = await setup((_, defaults) => ({ ...defaults, failedAfterMs: 3_000 }));
    const { code, entry } = await h.one("T3.F.01");
    expect(code).toBe(1);
    expect(entry.evidence).toMatchObject({ status: "failed", triaged: false });
    expect(entry.evidence.failedChecks).toContain("triaged");
    // A failed ticket ends the wait early; it does not sit out the limit.
    expect(h.clock.elapsed).toBeLessThan(TRIAGE_LIMIT_MS);
  });
});

describe("T3.S.04", () => {
  it("passes against the default mock: form path ignores the switch, test path honours it", async () => {
    const h = await setup();
    const { code, entry } = await h.one("T3.S.04");
    expect(code).toBe(0);
    expect(entry).toMatchObject({
      status: "pass",
      evidence: {
        formStatus: 201,
        formIsTest: true,
        formFixSteps: 2,
        formCapEvent: false,
        controlRoute: "review",
        controlCapEvent: true,
        failedChecks: [],
      },
    });
    const [form] = posts(h.mock, "/api/tickets");
    expect(form!.hasAuthorization).toBe(false);
    expect(JSON.parse(form!.body)).toMatchObject({ testOverrides: { llmCallCap: 0 } });
    expect(bodies(h.mock, "/api/internal/test-tickets")[0]).toMatchObject({
      testId: "run-1:S04:b",
      testOverrides: { llmCallCap: 0 },
    });
  });

  it("fails part (a) when the mock honours the switch on the form path", async () => {
    const h = await setup((ticket, defaults) =>
      ticket.path === "form" ? defaultTicketOutcome({ ...ticket, path: "test" }) : defaults,
    );
    const { code, entry } = await h.one("T3.S.04");
    expect(code).toBe(1);
    expect(entry.evidence).toMatchObject({
      formCapEvent: true,
      failedChecks: ["a-fix-steps", "a-switch-ignored"],
    });
  });

  it("fails part (a) when the form ticket is not a test ticket", async () => {
    const h = await setup((ticket, defaults) =>
      ticket.path === "form" ? { ...defaults, isTest: false } : defaults,
    );
    const { entry } = await h.one("T3.S.04");
    expect(entry.evidence.failedChecks).toEqual(["a-is-test"]);
  });

  it("fails part (a) when the form path refuses the request", async () => {
    const h = await setup(undefined, (r) =>
      r.path === "/api/tickets" ? { status: 400, json: { error: "invalid_body" } } : undefined,
    );
    const { code, entry } = await h.one("T3.S.04");
    expect(code).toBe(1);
    expect(entry.evidence).toMatchObject({ formStatus: 400, formTicketId: null });
    expect(entry.evidence.failedChecks).toEqual(["a-form-ticket"]);
  });

  it("fails part (b) when the mock ignores the switch on the test path", async () => {
    const h = await setup((ticket, defaults) =>
      ticket.path === "test" ? defaultTicketOutcome({ ...ticket, path: "form" }) : defaults,
    );
    const { code, entry } = await h.one("T3.S.04");
    expect(code).toBe(1);
    expect(entry.evidence).toMatchObject({
      controlCapEvent: false,
      controlRoute: "auto",
      failedChecks: ["b-cap-event", "b-route-review"],
    });
  });
});

describe("pipeline suite", () => {
  it("sends one form-path ticket per run; every other ticket goes through test-tickets", async () => {
    const h = await setup();
    // The security and pipeline scenarios; the browser and Langfuse ones have
    // their own tests (browser-form, observability).
    const ids = [...securityScenarios, ...pipelineScenarios].map((s) => s.id);
    const { code, report } = await h.run(["--only", ids.join(",")]);
    // T3.S.02-staging is not run: STAGING_BASE_URL is unset.
    expect(code).toBe(2);
    for (const entry of report.scenarios) {
      expect(entry.status, entry.id).toBe(entry.id === "T3.S.02-staging" ? "not_run" : "pass");
    }
    expect(posts(h.mock, "/api/tickets")).toHaveLength(1);
    expect(posts(h.mock, "/api/internal/test-tickets")).toHaveLength(L02_TICKETS + 3);
  });

  it("never sends more than 4 form-path tickets in 10 minutes across runs", async () => {
    const h = await setup();
    for (let i = 0; i < 6; i++) {
      expect(await h.run(["--only", "T3.S.04"])).toMatchObject({ code: 0 });
    }
    const times = posts(h.mock, "/api/tickets").map((r) => r.at);
    expect(times).toHaveLength(6);
    for (const start of times) {
      expect(
        times.filter((t) => t >= start && t < start + FORM_WINDOW_MS).length,
      ).toBeLessThanOrEqual(4);
    }
    expect(times[4]! - times[0]!).toBeGreaterThanOrEqual(FORM_WINDOW_MS);
  });

  it("keeps ticket text and env values out of the output and the report", async () => {
    const h = await setup();
    const { texts, report } = await h.run(
      ["--only", pipelineScenarios.map((s) => s.id).join(",")],
      "run-text",
    );
    for (const entry of report.scenarios) {
      expect(entry.status, entry.id).toBe("pass");
      for (const value of Object.values(entry.evidence).flat()) {
        if (typeof value === "string") expect(value).toMatch(/^[A-Za-z0-9._:/-]+$/);
        else expect(value === null || ["number", "boolean"].includes(typeof value)).toBe(true);
      }
    }
    const output = [...h.stdout, ...h.stderr, ...texts].join("\n");
    const sent = [
      ...bodies(h.mock, "/api/internal/test-tickets"),
      ...bodies(h.mock, "/api/tickets"),
    ];
    const words = sent.flatMap((b) => [b["title"], b["description"], b["email"], b["name"]]);
    for (const text of [...new Set(words)]) {
      expect(output.includes(String(text)), "ticket text leaked").toBe(false);
    }
    const secrets = Object.entries(h.values)
      .filter(([key]) => key !== "E2E_BASE_URL")
      .map(([, value]) => value);
    for (const secret of secrets) expect(output.includes(secret), "a value leaked").toBe(false);
  });
});
