import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evalTicketSchema, type EvalTicket } from "@ai-it-support/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { markerEnv } from "../testing/env.ts";
import { startMockE2e, type MockE2e, type MockE2eOptions } from "../testing/mock-e2e.ts";
import {
  DEFAULT_MAX_LLM_CALLS,
  LLM_CALLS_PER_TICKET,
  runEval,
  type EvalRecord,
  type RunEvalOptions,
} from "./run.ts";

const datasetPath = fileURLToPath(new URL("../../../../evals/tickets.json", import.meta.url));
const dataset: readonly EvalTicket[] = evalTicketSchema
  .array()
  .parse(JSON.parse(readFileSync(datasetPath, "utf8")));
const byId = new Map(dataset.map((t) => [t.id, t]));

const cleanup: Array<() => Promise<void> | void> = [];
const mocks: MockE2e[] = [];
afterEach(async () => {
  // Every test: the form path is never used.
  for (const mock of mocks.splice(0)) {
    expect(mock.requests.filter((r) => r.method === "POST" && r.path === "/api/tickets")).toEqual(
      [],
    );
  }
  for (const step of cleanup.splice(0)) await step();
  vi.restoreAllMocks();
});

type View = { status: string; triage: unknown };

/** A finished view that matches the ticket's labels, with optional changes to the triage. */
function perfectView(ticket: EvalTicket, change: Record<string, unknown> = {}): View {
  const route = (change.route as string | undefined) ?? ticket.expected.route ?? "auto";
  return {
    status: route === "review" ? "review_pending" : "auto",
    triage: {
      sensitive: ticket.expected.route === "review",
      sensitiveFlags: [],
      category: ticket.expected.category,
      subcategory: null,
      priority: ticket.expected.priority,
      urgency: null,
      assignmentGroup: ticket.expected.assignmentGroup,
      route,
      flags: [...ticket.expected.flags],
      probabilities: null,
      groundingScore: null,
      kbArticleIds: [],
      suggestedFix: { steps: ["Restart the service."], caveats: [] },
      modelVersions: null,
      triagedAt: "2026-10-10T00:01:00.000Z",
      ...change,
    },
  };
}

const datasetIdOf = (testId: string): string => testId.split(":")[1]!;

async function harness(mockOptions: Partial<MockE2eOptions> = {}) {
  const dir = join(mkdtempSync(join(tmpdir(), "eval-run-")), ".loop-evidence");
  cleanup.push(() => rmSync(dirname(dir), { recursive: true, force: true }));
  const values = markerEnv("http://127.0.0.1:1");
  const mock = await startMockE2e({
    token: values.INTERNAL_API_TOKEN,
    accessClientId: values.CF_ACCESS_CLIENT_ID,
    accessClientSecret: values.CF_ACCESS_CLIENT_SECRET,
    ticketView: (testId) => perfectView(byId.get(datasetIdOf(testId))!),
    ...mockOptions,
  });
  mocks.push(mock);
  cleanup.push(() => mock.close());
  const env = { ...values, E2E_BASE_URL: mock.origin };
  const stdout: string[] = [];
  const stderr: string[] = [];
  const run = (argv: string[], extra: Partial<RunEvalOptions> = {}) =>
    runEval({
      argv,
      env,
      datasetPath,
      evidenceDir: dir,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      pollIntervalMs: 1,
      ...extra,
    });
  const out = (runId: string, file: string) => join(dir, "eval", runId, file);
  const results = (runId: string) =>
    JSON.parse(readFileSync(out(runId, "results.json"), "utf8")) as {
      stopped: string | null;
      tickets: EvalRecord[];
    };
  const metrics = (runId: string) =>
    JSON.parse(readFileSync(out(runId, "metrics.json"), "utf8")) as {
      metrics: { missingIds: string[]; failedIds: string[]; category: { wrongIds: string[] } };
      targets: { passed: boolean };
    };
  const testTicketPosts = () =>
    mock.requests.filter((r) => r.method === "POST" && r.path === "/api/internal/test-tickets");
  return { dir, env, mock, stdout, stderr, run, out, results, metrics, testTicketPosts };
}

const ids = (n: number) => dataset.slice(0, n).map((t) => t.id);
const statuses = (records: EvalRecord[]) => records.map((r) => `${r.id}:${r.status}`);

describe("runEval against the mock", () => {
  it("--run r1 --limit 10 creates r1:E001 to r1:E010, at most 4 at a time, and writes the three files", async () => {
    const h = await harness();
    const code = await h.run(["--run", "r1", "--limit", "10"]);
    // Ten tickets cannot meet the DoD targets (no sensitive ticket among them).
    expect(code).toBe(1);
    expect([...h.mock.testTickets.keys()]).toEqual(ids(10).map((id) => `r1:${id}`));
    expect(h.mock.maxOpenTickets()).toBe(4);
    for (const file of ["results.json", "metrics.json", "report.md"]) {
      expect(existsSync(h.out("r1", file)), file).toBe(true);
    }
    const first = h.mock.testTickets.get("r1:E001")!;
    const e001 = byId.get("E001")!;
    expect(first.body).toEqual({
      name: e001.name,
      email: e001.email,
      department: e001.department,
      title: e001.title,
      description: e001.description,
      testId: "r1:E001",
    });
    expect(statuses(h.results("r1").tickets)).toEqual(ids(10).map((id) => `${id}:ok`));
    expect(h.mock.requests.every((r) => r.accessOk && r.bearerOk)).toBe(true);
  });

  it("re-running the same run ID creates no new ticket and gives the same results", async () => {
    const h = await harness();
    expect(await h.run(["--run", "r1", "--limit", "10"])).toBe(1);
    const firstResults = h.results("r1").tickets;
    const firstMetrics = h.metrics("r1");
    expect(await h.run(["--run", "r1", "--limit", "10"])).toBe(1);
    expect(h.mock.testTickets.size).toBe(10);
    expect(h.testTicketPosts()).toHaveLength(20);
    const second = h.results("r1").tickets;
    expect(second.every((r) => r.duplicate)).toBe(true);
    expect(second.map((r) => ({ ...r, duplicate: false }))).toEqual(firstResults);
    expect(h.metrics("r1")).toEqual(firstMetrics);
    expect(h.stdout).toContain("E001 ok duplicate");
  });

  it("refuses to start with --max-llm-calls 5 for 10 tickets: exit 2, no ticket, no files", async () => {
    const h = await harness();
    expect(await h.run(["--run", "r1", "--limit", "10", "--max-llm-calls", "5"])).toBe(2);
    expect(h.stderr.join("\n")).toMatch(/budget guard: 10 tickets need about 13 LLM.*Not started/);
    expect(h.testTicketPosts()).toEqual([]);
    expect(h.mock.testTickets.size).toBe(0);
    expect(existsSync(join(h.dir, "eval"))).toBe(false);
    // The TypeSafe estimate (18 per ticket) is guarded the same way.
    expect(await h.run(["--run", "r1", "--limit", "10", "--max-typesafe-calls=179"])).toBe(2);
    expect(h.mock.requests).toEqual([]);
  });

  it("stops after the first batch when TypeSafe usage grows past --max-typesafe-calls, marks the rest not run, exits 2", async () => {
    let created = () => 0;
    const h = await harness({ usage: () => ({ llm: 0, typesafe: created() > 0 ? 2501 : 0 }) });
    created = () => h.mock.testTickets.size;
    expect(await h.run(["--run", "r2", "--limit", "10"])).toBe(2);
    expect(h.mock.testTickets.size).toBe(4);
    const { tickets, stopped } = h.results("r2");
    expect(statuses(tickets)).toEqual([
      ...ids(4).map((id) => `${id}:ok`),
      ...ids(10)
        .slice(4)
        .map((id) => `${id}:not_run`),
    ]);
    expect(stopped).toMatch(/TypeSafe calls grew by 2501, above --max-typesafe-calls 2500/);
    expect(h.stderr.at(-1)).toMatch(/budget guard: .*stopped with 6 tickets not run/);
    expect(h.metrics("r2").metrics.missingIds).toEqual(ids(10).slice(4));
  });

  it("lets a normal 100-ticket eval pass its own LLM guard by a 1.5x margin", () => {
    expect(Math.ceil(100 * LLM_CALLS_PER_TICKET)).toBe(130);
    expect(DEFAULT_MAX_LLM_CALLS).toBeGreaterThanOrEqual(1.5 * 130);
    // The p3-eval-a rate (152 calls for 56 tickets, 2.7 per ticket) still stops.
    expect(DEFAULT_MAX_LLM_CALLS).toBeLessThan(100 * 2.7);
  });

  it("stops the same way when LLM usage grows past --max-llm-calls", async () => {
    let calls = 100;
    const h = await harness({ usage: () => ({ llm: (calls += 7), typesafe: 0 }) });
    // Baseline 107; after batch 1 the growth is 7, above the maximum of 13 only after batch 2.
    expect(await h.run(["--run", "r3", "--limit", "10", "--max-llm-calls", "13"])).toBe(2);
    expect(h.mock.testTickets.size).toBe(8);
    expect(h.results("r3").tickets.filter((r) => r.status === "not_run")).toHaveLength(2);
  });

  describe("fails closed when the usage cannot be trusted", () => {
    const broken: Array<[string, (n: number) => object | undefined]> = [
      ["a 500", () => ({ status: 500, json: { error: "internal_error" } })],
      ["a body off its schema", () => ({ status: 200, json: { month: "2026-10" } })],
      ["an HTML page", () => ({ status: 200, text: "<html></html>", contentType: "text/html" })],
      [
        "another month",
        () => ({
          status: 200,
          json: {
            month: "1999-01",
            llm: { calls: 0, tokensIn: 0, tokensOut: 0, costUsd: null },
            typesafe: { calls: 0, tokensIn: 0, tokensOut: 0, costUsd: null },
          },
        }),
      ],
    ];

    it.each(broken)("refuses to start on %s: exit 2, no ticket, no files", async (_, answer) => {
      const h = await harness({
        override: (r) =>
          r.path === "/api/internal/usage"
            ? (answer(0) as ReturnType<NonNullable<MockE2eOptions["override"]>>)
            : undefined,
      });
      expect(await h.run(["--run", "r1", "--limit", "10"])).toBe(2);
      expect(h.stderr.at(-1)).toMatch(
        /budget guard: usage could not be read \(\w+\)\. Not started\./,
      );
      expect(h.testTicketPosts()).toEqual([]);
      expect(existsSync(join(h.dir, "eval"))).toBe(false);
    });

    it.each(broken)("stops after a batch on %s: exit 2, the rest not run", async (_, answer) => {
      let reads = 0;
      const h = await harness({
        override: (r) =>
          r.path === "/api/internal/usage" && ++reads > 1
            ? (answer(reads) as ReturnType<NonNullable<MockE2eOptions["override"]>>)
            : undefined,
      });
      expect(await h.run(["--run", "r1", "--limit", "10"])).toBe(2);
      expect(h.mock.testTickets.size).toBe(4);
      expect(h.results("r1").stopped).toMatch(/^usage could not be read \(\w+\)$/);
      expect(h.results("r1").tickets.filter((r) => r.status === "not_run")).toHaveLength(6);
    });

    it("stops when a usage count goes down", async () => {
      let calls = 50;
      const h = await harness({ usage: () => ({ llm: (calls -= 1), typesafe: 0 }) });
      expect(await h.run(["--run", "r1", "--limit", "10"])).toBe(2);
      expect(h.results("r1").stopped).toBe("usage could not be read (UsageUntrusted)");
    });
  });

  it("records a ticket that does not finish inside the limit as timeout, and counts it wrong; a slow one that finishes is ok", async () => {
    const h = await harness({
      ticketView: (testId, reads) => {
        const id = datasetIdOf(testId);
        if (id === "E002") return { status: "redacted", triage: null };
        if (id === "E003" && reads < 3) return { status: "new", triage: null };
        return perfectView(byId.get(id)!);
      },
    });
    expect(await h.run(["--run", "r4", "--limit", "4"], { ticketTimeoutMs: 40 })).toBe(1);
    expect(statuses(h.results("r4").tickets)).toEqual([
      "E001:ok",
      "E002:timeout",
      "E003:ok",
      "E004:ok",
    ]);
    expect(h.mock.testTickets.get("r4:E003")!.reads).toBe(3);
    const { metrics } = h.metrics("r4");
    expect(metrics.missingIds).toEqual(["E002"]);
    expect(metrics.category.wrongIds).toEqual(["E002"]);
    expect(h.stdout).toContain("E002 timeout");
  });

  it("maps a failed ticket to failed and counts it wrong", async () => {
    const h = await harness({
      ticketView: (testId) =>
        datasetIdOf(testId) === "E001"
          ? { status: "failed", triage: null }
          : perfectView(byId.get(datasetIdOf(testId))!),
    });
    expect(await h.run(["--run", "r5", "--limit", "2"])).toBe(1);
    expect(h.metrics("r5").metrics.failedIds).toEqual(["E001"]);
  });

  it("exits 0 when the mock's results meet every target, and 1 naming the missed target", async () => {
    const h = await harness();
    expect(await h.run(["--run", "all-pass"])).toBe(0);
    expect(h.mock.testTickets.size).toBe(100);
    expect(h.mock.maxOpenTickets()).toBe(4);
    expect(h.metrics("all-pass").targets.passed).toBe(true);

    const sensitive = dataset.filter((t) => t.set === "sensitive")[0]!;
    const missed = await harness({
      ticketView: (testId) => {
        const ticket = byId.get(datasetIdOf(testId))!;
        return perfectView(ticket, ticket.id === sensitive.id ? { route: "auto" } : {});
      },
    });
    expect(await missed.run(["--run", "one-miss"])).toBe(1);
    const report = readFileSync(missed.out("one-miss", "report.md"), "utf8");
    expect(report).toContain(
      "| Sensitive tickets routed to review 100 % | 19/20 (95.0 %) | FAIL |",
    );
    expect(report).toContain(`- Sensitive not routed to review: ${sensitive.id}`);
    expect(missed.stdout).toContain("target sensitiveRecall FAIL 19/20 (95.0 %)");
    expect(
      missed.stdout.filter((l) => l.startsWith("target ") && l.includes(" FAIL ")),
    ).toHaveLength(1);
  });

  it("prints no ticket text and no secret: only IDs, statuses and metric values", async () => {
    const h = await harness();
    const stray: string[] = [];
    for (const stream of [process.stdout, process.stderr]) {
      vi.spyOn(stream, "write").mockImplementation((chunk: string | Uint8Array) => {
        stray.push(String(chunk));
        return true;
      });
    }
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        stray.push(args.map(String).join(" "));
      });
    }
    expect(await h.run(["--run", "quiet"])).toBe(0);
    vi.restoreAllMocks();

    const line =
      /^(E\d{3} (ok|failed|timeout|not_run|error)( duplicate)?( \w+)?|target \w+ (pass|FAIL) [\w /().%,]+|(results|report): [\w./\\-]+)$/;
    for (const l of [...h.stdout, ...h.stderr]) expect(l).toMatch(line);
    expect(stray).toEqual([]);

    const written = ["results.json", "metrics.json", "report.md"]
      .map((f) => readFileSync(h.out("quiet", f), "utf8"))
      .join("\n");
    const everything = [...h.stdout, ...h.stderr, written].join("\n");
    for (const ticket of dataset) {
      for (const text of [ticket.title, ticket.description, ticket.name, ticket.email]) {
        expect(everything.includes(text), ticket.id).toBe(false);
      }
    }
    for (const [key, value] of Object.entries(h.env)) {
      if (key !== "E2E_BASE_URL") expect(everything.includes(value), key).toBe(false);
    }
  });

  it("records a ticket that cannot be created or queued as error and exits 2", async () => {
    const h = await harness({
      override: (r) => {
        if (r.path !== "/api/internal/test-tickets") return undefined;
        if (r.body.includes('"r6:E001"')) return { status: 500, json: { error: "internal_error" } };
        if (r.body.includes('"r6:E002"')) {
          return {
            status: 201,
            json: { ticketId: "00000000-0000-4000-8000-000000000009", queued: false },
          };
        }
        return undefined;
      },
    });
    expect(await h.run(["--run", "r6", "--limit", "3"])).toBe(2);
    const [e1, e2, e3] = h.results("r6").tickets;
    expect([e1!.status, e1!.error]).toEqual(["error", "LiveContractError"]);
    expect([e2!.status, e2!.error, e2!.ticketId]).toEqual([
      "error",
      "NotQueued",
      "00000000-0000-4000-8000-000000000009",
    ]);
    expect(e3!.status).toBe("ok");
    expect(h.stderr.at(-1)).toBe("eval: 2 tickets could not run");
  });

  it("--set runs only that set", async () => {
    const h = await harness();
    await h.run(["--run", "vague", "--set", "vague"]);
    const vague = dataset.filter((t) => t.set === "vague").map((t) => t.id);
    expect(h.results("vague").tickets.map((r) => r.id)).toEqual(vague);
  });

  it.each([
    [[], /--run <id> is required/],
    [["--run", "../escape"], /--run must be/],
    [["--run", ".."], /--run must be/],
    [["--run", "a/b"], /--run must be/],
    [["--run", "a\\b"], /--run must be/],
    [["--run", "r1:x"], /--run must be/],
    [["--run", "x".repeat(65)], /--run must be/],
    [["--run", ""], /--run needs a value/],
    [["--run", "r1", "--set", "bogus"], /--set must be one of/],
    [["--run", "r1", "--limit", "0"], /--limit must be a whole number of at least 1/],
    [["--run", "r1", "--limit", "-3"], /--limit must be/],
    [["--run", "r1", "--max-llm-calls", "1e3"], /--max-llm-calls must be/],
    [["--run", "r1", "--run", "r2"], /--run is given twice/],
    [["--run", "r1", "--bogus"], /unknown argument/],
  ])("refuses %j: exit 2, nothing created or written", async (argv, message) => {
    const h = await harness();
    expect(await h.run(argv as string[])).toBe(2);
    expect(h.stderr.join("\n")).toMatch(message);
    expect(h.mock.requests).toEqual([]);
    expect(readdirSync(dirname(h.dir))).toEqual([]);
  });

  it("never echoes an argument value", async () => {
    const h = await harness();
    expect(await h.run(["--run", h.env.CF_ACCESS_CLIENT_SECRET])).toBe(2);
    expect(await h.run(["--run", "r1", h.env.INTERNAL_API_TOKEN])).toBe(2);
    expect(h.stderr.join("\n")).not.toContain(h.env.CF_ACCESS_CLIENT_SECRET);
    expect(h.stderr.join("\n")).not.toContain(h.env.INTERNAL_API_TOKEN);
  });

  it("exits 2 naming the variable when the env is incomplete", async () => {
    const h = await harness();
    const code = await h.run(["--run", "r1"], { env: { ...h.env, INTERNAL_API_TOKEN: undefined } });
    expect(code).toBe(2);
    expect(h.stderr.join("\n")).toContain("INTERNAL_API_TOKEN");
    expect(h.mock.requests).toEqual([]);
  });
});
