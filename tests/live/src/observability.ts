import { canaryTicketText, type InternalTicketView } from "@ai-it-support/shared";
import {
  CATEGORY_SAMPLES,
  isTriaged,
  result,
  testId,
  ticketBody,
  TRIAGE_LIMIT_MS,
  waitForTriage,
  type Pending,
} from "./pipeline.ts";
import type { Scenario, ScenarioContext, ScenarioResult } from "./runner.ts";
import {
  asText,
  readObservations,
  scanText,
  scanTraces,
  type LangfuseKeys,
  type Observation,
} from "./scan.ts";

/**
 * The live Langfuse scenarios (plan T3.L.04, T3.O.01). Both read Langfuse
 * through `readObservations` (scan.ts), so an API error fails the scenario
 * (fail closed). Evidence carries ticket IDs, counts, times and check names.
 */

/** Langfuse shows spans within seconds; this bounds the ingestion lag. */
export const LANGFUSE_WAIT_MS = 120_000;
export const LANGFUSE_POLL_MS = 5_000;
export const O01_TICKETS = 5;
/** The log exports the orchestrator scans with `scan:logs` after T3.L.04. */
export const LOG_EXPORTS = [
  "dokploy:e2e-web",
  "trigger.dev:e2e-intake-ticket",
  "trigger.dev:e2e-triage-ticket",
];

/**
 * The canary run ID (`[a-z0-9]{4,12}`, plan §4.3) of a harness run ID: its
 * last 12 lower-case letters and digits. The default run ID ends in random hex.
 */
export function canaryRunId(runId: string): string {
  const id = runId
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(-12);
  if (id.length < 4) throw new RangeError("run ID has fewer than 4 letters or digits");
  return id;
}

/** The validated Langfuse keys, or undefined when one is not set. */
function langfuseKeys(context: ScenarioContext): LangfuseKeys | undefined {
  const { publicKey, secretKey, baseUrl } = context.config.langfuse;
  if (publicKey === undefined || secretKey === undefined || baseUrl === undefined) return undefined;
  return {
    LANGFUSE_PUBLIC_KEY: publicKey,
    LANGFUSE_SECRET_KEY: secretKey,
    LANGFUSE_BASE_URL: baseUrl,
  };
}

const NOT_RUN: ScenarioResult = { status: "not_run", evidence: { missing: "langfuse-keys" } };

/** Every observation of one session (ticket ID); throws TraceApiError on any API problem. */
async function sessionObservations(
  context: ScenarioContext,
  keys: LangfuseKeys,
  ticketId: string,
): Promise<Observation[]> {
  const rows: Observation[] = [];
  const query = {
    sessionId: ticketId,
    until: new Date(context.now()),
    fields: "core,basic,io,metadata,model,usage",
  };
  for await (const page of readObservations(keys, query, { fetch: context.fetch })) {
    rows.push(...page.data);
  }
  return rows;
}

/** Polls until the session has at least `expected` observations, or the wait ends. */
async function waitForObservations(
  context: ScenarioContext,
  keys: LangfuseKeys,
  ticketId: string,
  expected: number,
): Promise<Observation[]> {
  const deadline = context.now() + LANGFUSE_WAIT_MS;
  for (;;) {
    const rows = await sessionObservations(context, keys, ticketId);
    if (rows.length >= expected || context.now() >= deadline) return rows;
    await context.sleep(LANGFUSE_POLL_MS);
  }
}

/**
 * T3.L.04: a test ticket holding all 10 canaries of the run is triaged, then
 * the trace scan for the run (from the scenario start) finds 0 hard hits. The
 * evidence names the canary run ID, the time and the log exports for
 * `pnpm scan:logs --run <canaryRunId> <files…>`.
 */
export const canaryTraceScenario: Scenario = {
  id: "T3.L.04",
  async run(context) {
    const keys = langfuseKeys(context);
    if (keys === undefined) return NOT_RUN;
    const canaryRun = canaryRunId(context.runId);
    const since = new Date(context.now());
    const { ticketId } = await context.client.createTestTicket({
      ...ticketBody(context, {
        title: "VPN unreachable since this morning",
        description: canaryTicketText(canaryRun),
      }),
      testId: testId(context, "L04:1"),
    });
    const views = await waitForTriage(context, [
      { id: ticketId, deadline: context.now() + TRIAGE_LIMIT_MS },
    ]);
    const view = views.get(ticketId)!;
    const triaged = isTriaged(view);
    let found = 0;
    if (triaged)
      found = (await waitForObservations(context, keys, ticketId, view.aiCallCount)).length;

    const lines: string[] = [];
    const scanExit = await scanTraces(
      { runId: canaryRun, since, files: [] },
      { ...keys },
      { stdout: (line) => lines.push(line), stderr: (line) => lines.push(line) },
      { fetch: context.fetch, now: new Date(context.now()) },
    );
    // `HARD observation <id> <type>`: the observation ID is ID characters only (scan.ts).
    const hardIds = [
      ...new Set(lines.flatMap((line) => /^HARD observation (\S+) /.exec(line)?.[1] ?? [])),
    ];
    const scanned = Number(/(\d+) observations scanned/.exec(lines.join("\n"))?.[1] ?? 0);
    const failedChecks = [
      ...(triaged ? [] : ["triaged"]),
      ...(triaged && (view.aiCallCount < 1 || found < view.aiCallCount)
        ? ["observations-present"]
        : []),
      ...(scanExit === 0
        ? []
        : [scanExit === 1 ? "trace-scan-hard-hits" : "trace-scan-not-proven"]),
    ];
    return result(failedChecks, {
      ticketId,
      canaryRunId: canaryRun,
      scanSince: since.toISOString(),
      aiCallCount: view.aiCallCount,
      observationsFound: found,
      observationsScanned: scanned,
      scanExit,
      hardHits: lines.filter((line) => line.startsWith("HARD ")).length,
      hardObservationIds: hardIds,
      logExports: LOG_EXPORTS,
      logsSince: since.toISOString(),
    });
  },
};

const positive = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

/** The check names one ticket fails, each ending in the ticket ID. */
function ticketChecks(view: InternalTicketView, rows: readonly Observation[], canaryRun: string) {
  const id = view.id;
  const checks: string[] = [];
  if (view.aiCallCount < 1) checks.push(`ai-calls:${id}`);
  if (rows.length !== view.aiCallCount) checks.push(`count:${id}`);
  const each = (ok: (row: Observation) => boolean) => rows.every(ok);
  if (!each((row) => typeof row["model"] === "string" && row["model"] !== "")) {
    checks.push(`model:${id}`);
  }
  const usage = (row: Observation) => row["usageDetails"] as Record<string, unknown> | undefined;
  if (!each((row) => positive(usage(row)?.["input"]) && positive(usage(row)?.["output"]))) {
    checks.push(`tokens:${id}`);
  }
  if (!each((row) => row["environment"] === "e2e")) checks.push(`environment:${id}`);
  if (!each((row) => scanText(asText(row.input), canaryRun).hard.length === 0)) {
    checks.push(`input-hit:${id}`);
  }
  return checks;
}

/**
 * T3.O.01: for 5 triaged test tickets, Langfuse has, by `sessionId` = ticket
 * ID, as many observations as the ticket's `aiCallCount`; each has a model
 * name, input and output token counts above 0 and the environment `e2e`, and
 * no input has a hard hit. A failed check names the ticket ID.
 */
export const langfuseObservationsScenario: Scenario = {
  id: "T3.O.01",
  async run(context) {
    const keys = langfuseKeys(context);
    if (keys === undefined) return NOT_RUN;
    const canaryRun = canaryRunId(context.runId);
    const created: Pending[] = [];
    for (let n = 1; n <= O01_TICKETS; n++) {
      const { ticketId } = await context.client.createTestTicket({
        ...ticketBody(context, CATEGORY_SAMPLES[(n - 1) % CATEGORY_SAMPLES.length]!),
        testId: testId(context, `O01:${n}`),
      });
      created.push({ id: ticketId, deadline: context.now() + TRIAGE_LIMIT_MS });
    }
    const views = await waitForTriage(context, created);

    const failedChecks: string[] = [];
    const aiCallCounts: number[] = [];
    const observationCounts: number[] = [];
    for (const { id } of created) {
      const view = views.get(id)!;
      aiCallCounts.push(view.aiCallCount);
      if (!isTriaged(view)) {
        failedChecks.push(`triaged:${id}`);
        observationCounts.push(0);
        continue;
      }
      const rows = await waitForObservations(context, keys, id, view.aiCallCount);
      observationCounts.push(rows.length);
      failedChecks.push(...ticketChecks(view, rows, canaryRun));
    }
    return result(failedChecks, {
      ticketIds: created.map(({ id }) => id),
      aiCallCounts,
      observationCounts,
    });
  },
};

export const observabilityScenarios: readonly Scenario[] = [
  canaryTraceScenario,
  langfuseObservationsScenario,
];
