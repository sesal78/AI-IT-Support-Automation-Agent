import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evalTicketSchema, type EvalTicket } from "@ai-it-support/shared";
import { afterEach, describe, expect, it } from "vitest";
import { markerEnv } from "../testing/env.ts";
import {
  startMockE2e,
  type MockE2e,
  type MockReply,
  type MockRequest,
} from "../testing/mock-e2e.ts";
import { mockJudgments } from "../testing/mock-judgments.ts";
import { datasetItemId } from "./langfuse.ts";
import { computeMetrics, evaluateTargets, writeReport, type EvalResult } from "./metrics.ts";
import { runEval, type EvalRecord } from "./run.ts";

const datasetPath = fileURLToPath(new URL("../../../../evals/tickets.json", import.meta.url));
const dataset: readonly EvalTicket[] = evalTicketSchema
  .array()
  .parse(JSON.parse(readFileSync(datasetPath, "utf8")));
const byId = new Map(dataset.map((t) => [t.id, t]));
const allIds = dataset.map((t) => t.id);
const injectionIds = dataset.filter((t) => t.set === "injection").map((t) => t.id);
const normalIds = dataset.filter((t) => t.set === "normal").map((t) => t.id);

// Placed in every redacted description and fix step: it must never reach the output.
const MARKER = `TicketTextMarker${"m".repeat(12)}`;

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0)) await step();
});

const uuidOf = (id: string): string =>
  `00000000-0000-4000-8000-${id.replace(/\D/g, "").padStart(12, "0")}`;

interface Seed {
  readonly ids: readonly string[];
  /** Tickets whose triage has no fix steps. */
  readonly noFix?: readonly string[];
  /** Extra flags on the result record. */
  readonly flags?: Record<string, string[]>;
  /** Tickets that never ran (no ticket UUID). */
  readonly notRun?: readonly string[];
}

function viewOf(id: string, noFix: boolean) {
  const ticket = byId.get(id)!;
  return {
    id: uuidOf(id),
    status: "triaged",
    isTest: true,
    source: "web",
    createdAt: "2026-10-10T00:00:00.000Z",
    redacted: { title: `title of ${id}`, description: `description ${MARKER}` },
    triage: {
      sensitive: false,
      sensitiveFlags: [],
      category: ticket.expected.category,
      subcategory: null,
      priority: ticket.expected.priority,
      urgency: null,
      assignmentGroup: ticket.expected.assignmentGroup,
      route: ticket.expected.route ?? "auto",
      flags: [...ticket.expected.flags],
      probabilities: null,
      groundingScore: null,
      kbArticleIds: [],
      suggestedFix: noFix ? null : { steps: [`Restart it. ${MARKER}`], caveats: [] },
      modelVersions: null,
      triagedAt: "2026-10-10T00:01:00.000Z",
    },
    aiCallCount: 1,
    events: [],
    reviews: [],
    notifications: [],
    autofix: [],
  };
}

/** The eval ID a judgment body is about, from its redacted title. */
function judgedId(body: unknown): string {
  const state = (body as { state: { text?: string; ticket?: { title: string } } }).state;
  const title = state.text ?? state.ticket!.title;
  return /title of (E\d{3})/.exec(title)![1]!;
}

interface LangfuseMock {
  readonly requests: Array<{ method: string; path: string; auth: string; body: unknown }>;
  readonly items: Map<string, unknown>;
  readonly spans: Array<Record<string, unknown>>;
  datasetExists: boolean;
  fail: ((path: string) => number | undefined) | undefined;
}

type Values = Partial<Record<"J1" | "J2" | "J3", Record<string, number | "failed">>>;

async function harness(seed: Seed, values: Values = {}, defaults = { J1: 0.8, J2: 0.1, J3: 0.1 }) {
  const dir = join(mkdtempSync(join(tmpdir(), "eval-judges-")), ".loop-evidence");
  cleanup.push(() => rmSync(dirname(dir), { recursive: true, force: true }));
  const env0 = markerEnv("http://127.0.0.1:1");
  const judgments = mockJudgments((_, body) => {
    const judgeId = (body as { judgeId: "J1" | "J2" | "J3" }).judgeId;
    return values[judgeId]?.[judgedId(body)] ?? defaults[judgeId];
  });
  const noFix = new Set(seed.noFix ?? []);
  const viewReads: string[] = [];
  const views = new Map(seed.ids.map((id) => [uuidOf(id), id]));
  const override = (request: MockRequest): MockReply | undefined => {
    const match = /^\/api\/internal\/tickets\/([^/]+)$/.exec(request.path);
    const id = match ? views.get(match[1]!) : undefined;
    if (id !== undefined) {
      viewReads.push(id);
      return { status: 200, json: viewOf(id, noFix.has(id)) };
    }
    return judgments.override(request);
  };
  const mock: MockE2e = await startMockE2e({
    token: env0.INTERNAL_API_TOKEN,
    accessClientId: env0.CF_ACCESS_CLIENT_ID,
    accessClientSecret: env0.CF_ACCESS_CLIENT_SECRET,
    override,
  });
  cleanup.push(() => mock.close());
  const env = { ...env0, E2E_BASE_URL: mock.origin };

  const langfuseOrigin = new URL(env.LANGFUSE_BASE_URL).origin;
  const lf: LangfuseMock = {
    requests: [],
    items: new Map(),
    spans: [],
    datasetExists: false,
    fail: undefined,
  };
  const reply = (status: number, json: unknown) =>
    new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  const fetchFn = async (input: URL, init: RequestInit): Promise<Response> => {
    if (input.origin !== langfuseOrigin) return fetch(input, init);
    const body: unknown = init.body ? JSON.parse(init.body as string) : undefined;
    const auth = new Headers(init.headers).get("authorization") ?? "";
    lf.requests.push({ method: init.method ?? "GET", path: input.pathname, auth, body });
    const failed = lf.fail?.(input.pathname);
    if (failed !== undefined) return reply(failed, { message: "boom" });
    if (input.pathname === "/api/public/v2/datasets/itsupport-eval-v1") {
      return lf.datasetExists ? reply(200, { id: "ds_1" }) : reply(404, { message: "nf" });
    }
    if (input.pathname === "/api/public/v2/datasets") {
      lf.datasetExists = true;
      return reply(200, { id: "ds_1" });
    }
    if (input.pathname === "/api/public/dataset-items") {
      const item = body as { id: string };
      lf.items.set(item.id, item);
      return reply(200, item);
    }
    if (input.pathname === "/api/public/otel/v1/traces") {
      const spans = (
        body as {
          resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<Record<string, unknown>> }> }>;
        }
      ).resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans));
      lf.spans.push(...spans);
      return reply(200, {});
    }
    return reply(404, {});
  };

  const run = "r1";
  const outDir = join(dir, "eval", run);
  const notRun = new Set(seed.notRun ?? []);
  const records: EvalRecord[] = seed.ids.map((id) => {
    const t = byId.get(id)!;
    return {
      id,
      testId: `${run}:${id}`,
      status: notRun.has(id) ? "not_run" : "ok",
      ticketId: notRun.has(id) ? null : uuidOf(id),
      duplicate: false,
      category: t.expected.category,
      priority: t.expected.priority,
      assignmentGroup: t.expected.assignmentGroup,
      route: t.expected.route ?? "auto",
      flags: [...t.expected.flags, ...((seed.flags?.[id] ?? []) as EvalRecord["flags"])],
    };
  });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, "results.json"),
    JSON.stringify({ runId: run, tickets: records }, null, 2),
  );
  // The rule targets pass: every labeled ticket has a perfect result.
  const perfect: EvalResult[] = dataset.map((t) => ({
    ticketId: t.id,
    status: "ok",
    category: t.expected.category,
    priority: t.expected.priority,
    assignmentGroup: t.expected.assignmentGroup,
    route: t.expected.route ?? "auto",
    flags: [...t.expected.flags],
    fixSteps: [],
  }));
  const metrics = computeMetrics(dataset, perfect);
  const targets = evaluateTargets(metrics);
  expect(targets.passed).toBe(true);
  writeReport(outDir, metrics, targets);

  const stdout: string[] = [];
  const stderr: string[] = [];
  const pass = (
    argv: string[] = ["--run", run, "--judges"],
    envOverride: Record<string, string | undefined> = {},
  ) =>
    runEval({
      argv,
      env: { ...env, ...envOverride },
      datasetPath,
      evidenceDir: dir,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      fetch: fetchFn,
      // Langfuse pacing and retries wait on this; the judge client polls with it too.
      sleep: async () => undefined,
      pollIntervalMs: 1,
    });
  const posts = (judgeId?: string) =>
    judgments.bodies.filter(
      (b) => judgeId === undefined || (b as { judgeId: string }).judgeId === judgeId,
    );
  const report = () => readFileSync(join(outDir, "report.md"), "utf8");
  const judgesFile = () =>
    JSON.parse(readFileSync(join(outDir, "judges.json"), "utf8")) as {
      tickets: Record<string, { noFix?: boolean; J1?: { value?: number } }>;
    };
  const line = (start: string) =>
    report()
      .split("\n")
      .find((l) => l.startsWith(start)) ?? "";
  return {
    dir,
    env,
    mock,
    lf,
    stdout,
    stderr,
    pass,
    posts,
    report,
    judgesFile,
    line,
    viewReads,
    outDir,
  };
}

const idsOf = (bodies: unknown[]) => bodies.map(judgedId).sort();

describe("pnpm eval --run <id> --judges against the mock", () => {
  it("on a 10-ticket run: one J1 per ticket with fix steps, one J3 per ticket, J2 only for injection tickets", async () => {
    const ids = [...normalIds.slice(0, 6), ...injectionIds.slice(0, 4)];
    const noFix = [normalIds[5]!, injectionIds[3]!];
    const h = await harness({ ids, noFix });
    await h.pass();
    const withFix = ids.filter((id) => !noFix.includes(id));
    expect(idsOf(h.posts("J1"))).toEqual([...withFix].sort());
    expect(idsOf(h.posts("J3"))).toEqual([...ids].sort());
    expect(idsOf(h.posts("J2"))).toEqual(injectionIds.slice(0, 3).sort());
    expect(h.posts()).toHaveLength(8 + 10 + 3);
    expect(h.mock.requests.every((r) => r.accessOk && r.bearerOk)).toBe(true);
  });

  it("skips a ticket without fix steps for J1 and J2 and counts it under no_fix", async () => {
    const ids = [normalIds[0]!, normalIds[1]!, injectionIds[0]!];
    const h = await harness({ ids, noFix: [normalIds[1]!, injectionIds[0]!] });
    await h.pass();
    expect(h.posts("J1").map(judgedId)).toEqual([normalIds[0]]);
    expect(h.posts("J2")).toEqual([]);
    const file = h.judgesFile();
    expect(file.tickets[normalIds[1]!]).toMatchObject({ noFix: true });
    expect(file.tickets[normalIds[1]!]!.J1).toBeUndefined();
    expect(h.report()).toContain("no_fix 2.");
    expect(h.line("- No fix steps")).toContain(`${normalIds[1]}, ${injectionIds[0]}`);
    expect(h.stdout).toContain("no_fix: 2");
  });

  it("passes the J1 target with a mean of 0.72 on the normal tickets (exit 0) and fails it at 0.69 (exit 1)", async () => {
    const good = await harness(
      { ids: allIds },
      { J1: Object.fromEntries(normalIds.map((id, i) => [id, i % 2 === 0 ? 0.64 : 0.8])) },
    );
    expect(await good.pass()).toBe(0);
    expect(good.line("| J1 mean")).toMatch(/0\.720 over 60 normal tickets \| pass/);

    const bad = await harness(
      { ids: allIds },
      { J1: Object.fromEntries(normalIds.map((id, i) => [id, i % 2 === 0 ? 0.58 : 0.8])) },
    );
    expect(await bad.pass()).toBe(1);
    expect(bad.line("| J1 mean")).toMatch(/0\.690 over 60 normal tickets \| FAIL/);
    expect(bad.report()).toContain("Overall with judges: FAIL.");
  });

  it("lists a ticket with J1 = 0.3 and a ticket flagged ungrounded_fix to be read by the agent", async () => {
    const [low, ungrounded, fine] = normalIds;
    const h = await harness(
      { ids: [low!, ungrounded!, fine!], flags: { [ungrounded!]: ["ungrounded_fix"] } },
      { J1: { [low!]: 0.3 } },
    );
    await h.pass();
    expect(h.line("- To be read by the agent")).toMatch(new RegExp(`: ${low}, ${ungrounded}$`));
  });

  it("an injection ticket with J2 = 0.6 is listed and fails the injection target (exit 1)", async () => {
    const h = await harness({ ids: allIds }, { J2: { [injectionIds[1]!]: 0.6 } });
    expect(await h.pass()).toBe(1);
    expect(h.line("- Injection with J2")).toMatch(new RegExp(`: ${injectionIds[1]}$`));
    expect(h.line("| Injection: rule checks")).toMatch(/J2 flags 1 \| FAIL/);
    expect(h.stdout).toContain("target injection+J2 FAIL J2 flags 1");
  });

  it("a ticket with J3 = 0.5 is listed for the check by hand and does not change the exit code", async () => {
    const h = await harness({ ids: allIds }, { J3: { [normalIds[2]!]: 0.5 } });
    expect(await h.pass()).toBe(0);
    expect(h.line("- J3 >= 0.5")).toMatch(new RegExp(`: ${normalIds[2]}$`));
    expect(h.report()).toContain("Overall with judges: PASS.");
  });

  it("running twice sends no second request for a ticket whose values are already in judges.json", async () => {
    const ids = [normalIds[0]!, normalIds[1]!, injectionIds[0]!];
    const h = await harness({ ids }, { J1: { [normalIds[1]!]: "failed" } });
    expect(await h.pass()).toBe(2);
    expect(h.stderr.at(-1)).toMatch(/1 tickets have judgments that did not finish/);
    const first = h.posts().length;
    expect(first).toBe(3 + 3 + 1);
    const reads = h.viewReads.length;

    // Only the failed J1 is asked for again; the two finished tickets are not even read.
    expect(await h.pass()).toBe(2);
    expect(
      h
        .posts()
        .slice(first)
        .map((b) => `${(b as { judgeId: string }).judgeId}:${judgedId(b)}`),
    ).toEqual([`J1:${normalIds[1]}`]);
    expect(h.viewReads.slice(reads)).toEqual([normalIds[1]]);
    expect(h.report().match(/## Judges\n/g)).toHaveLength(1);
  });

  it("records one dataset item and one run link per eval ticket in Langfuse, idempotently", async () => {
    const ids = [normalIds[0]!, injectionIds[0]!, normalIds[1]!];
    const h = await harness({ ids, notRun: [normalIds[1]!] });
    expect(await h.pass()).toBe(0);
    expect(h.lf.requests.map((r) => `${r.method} ${r.path}`).slice(0, 2)).toEqual([
      "GET /api/public/v2/datasets/itsupport-eval-v1",
      "POST /api/public/v2/datasets",
    ]);
    const expectedAuth = `Basic ${Buffer.from(`${h.env.LANGFUSE_PUBLIC_KEY}:${h.env.LANGFUSE_SECRET_KEY}`).toString("base64")}`;
    expect(h.lf.requests.every((r) => r.auth === expectedAuth)).toBe(true);
    expect([...h.lf.items.keys()].sort()).toEqual(ids.map(datasetItemId).sort());
    expect(h.lf.items.get(datasetItemId(ids[0]!))).toMatchObject({
      datasetName: "itsupport-eval-v1",
      input: { evalTicketId: ids[0] },
    });

    // One link per ticket that ran, under the run name, with the ticket's trace reference.
    const attrs = (span: Record<string, unknown>) =>
      Object.fromEntries(
        (span.attributes as Array<{ key: string; value: { stringValue: string } }>).map((a) => [
          a.key,
          a.value.stringValue,
        ]),
      );
    expect(h.lf.spans).toHaveLength(2);
    for (const [i, id] of [ids[0]!, ids[1]!].entries()) {
      const a = attrs(h.lf.spans[i]!);
      expect(a["langfuse.experiment.name"]).toBe("r1");
      expect(a["langfuse.experiment.item.id"]).toBe(datasetItemId(id));
      expect(a["langfuse.experiment.dataset.id"]).toBe("ds_1");
      expect(a["langfuse.session.id"]).toBe(uuidOf(id));
      expect(a["langfuse.experiment.item.root_observation_id"]).toBe(h.lf.spans[i]!.spanId);
    }
    const firstIds = h.lf.spans.map((s) => `${s.traceId as string}/${s.spanId as string}`);

    await h.pass();
    expect(h.lf.requests.filter((r) => r.path === "/api/public/v2/datasets")).toHaveLength(1);
    expect(h.lf.items.size).toBe(3);
    expect(h.lf.spans.slice(2).map((s) => `${s.traceId as string}/${s.spanId as string}`)).toEqual(
      firstIds,
    );
  });

  it("reports a Langfuse 500 and exits 2", async () => {
    const h = await harness({ ids: allIds });
    h.lf.fail = (path) => (path === "/api/public/dataset-items" ? 500 : undefined);
    expect(await h.pass()).toBe(2);
    expect(h.stderr.at(-1)).toMatch(
      /Langfuse: FAILED \(POST \/api\/public\/dataset-items: status 500 after 5 tries\)/,
    );
    // A 5xx is retried, 5 tries in all, then it fails loudly.
    expect(h.lf.requests.filter((r) => r.path === "/api/public/dataset-items")).toHaveLength(5);
    expect(h.report()).toContain("Langfuse: FAILED");
    // The judge values were still saved.
    expect(Object.keys(h.judgesFile().tickets)).toHaveLength(100);
  });

  it("prints and writes no ticket text", async () => {
    const h = await harness({ ids: [normalIds[0]!, injectionIds[0]!] });
    await h.pass();
    const written = [
      h.stdout.join("\n"),
      h.stderr.join("\n"),
      h.report(),
      readFileSync(join(h.outDir, "judges.json"), "utf8"),
      JSON.stringify(h.lf.requests),
    ];
    for (const text of written) {
      expect(text).not.toContain(MARKER);
      expect(text).not.toContain("title of");
    }
    for (const t of [byId.get(normalIds[0]!)!, byId.get(injectionIds[0]!)!]) {
      expect(h.report()).not.toContain(t.description);
      expect(JSON.stringify(h.lf.requests)).not.toContain(t.description);
    }
  });

  it("fails with exit 2 and no request when the run has no results.json or Langfuse is not configured", async () => {
    const h = await harness({ ids: [normalIds[0]!] });
    expect(await h.pass(["--run", "nope", "--judges"])).toBe(2);
    expect(h.stderr.at(-1)).toMatch(/results\.json not found/);
    expect(await h.pass(["--run", "r1", "--judges", "--limit", "3"])).toBe(2);
    expect(h.stderr.at(-1)).toMatch(/usage: --run <id> --judges/);
    expect(await h.pass(undefined, { LANGFUSE_SECRET_KEY: undefined })).toBe(2);
    expect(h.stderr.at(-1)).toMatch(
      /LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY and LANGFUSE_BASE_URL are needed/,
    );
    expect(h.mock.requests).toEqual([]);
    expect(h.lf.requests).toEqual([]);
    expect(existsSync(join(h.outDir, "judges.json"))).toBe(false);
  });
});

describe("the judge pass on a run made by pnpm eval", () => {
  it("reads the results.json that runEval wrote and judges its tickets", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "eval-judges-e2e-")), ".loop-evidence");
    cleanup.push(() => rmSync(dirname(dir), { recursive: true, force: true }));
    const env0 = markerEnv("http://127.0.0.1:1");
    const judgments = mockJudgments(() => 0.9);
    const mock = await startMockE2e({
      token: env0.INTERNAL_API_TOKEN,
      accessClientId: env0.CF_ACCESS_CLIENT_ID,
      accessClientSecret: env0.CF_ACCESS_CLIENT_SECRET,
      override: judgments.override,
      ticketView: (testId) => {
        const view = viewOf(testId.split(":")[1]!, false);
        return { status: view.status, triage: view.triage, redacted: view.redacted };
      },
    });
    cleanup.push(() => mock.close());
    const env = { ...env0, E2E_BASE_URL: mock.origin };
    const langfuse = new URL(env.LANGFUSE_BASE_URL).origin;
    const paths: string[] = [];
    const fetchFn = async (input: URL, init: RequestInit): Promise<Response> => {
      if (input.origin !== langfuse) return fetch(input, init);
      paths.push(input.pathname);
      return new Response(JSON.stringify({ id: "ds_1" }), { status: 200 });
    };
    const options = {
      env,
      datasetPath,
      evidenceDir: dir,
      stdout: () => undefined,
      stderr: () => undefined,
      fetch: fetchFn,
      sleep: async () => undefined,
      pollIntervalMs: 1,
    };
    // Two normal tickets cannot meet the rule targets: exit 1 on both steps.
    expect(await runEval({ ...options, argv: ["--run", "e1", "--limit", "2"] })).toBe(1);
    expect(await runEval({ ...options, argv: ["--run", "e1", "--judges"] })).toBe(1);
    expect(judgments.bodies).toHaveLength(4);
    expect(paths.filter((p) => p === "/api/public/otel/v1/traces")).toHaveLength(2);
  });
});
