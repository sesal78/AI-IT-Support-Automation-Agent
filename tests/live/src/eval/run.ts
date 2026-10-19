import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  EVAL_SETS,
  evalTicketSchema,
  TRIAGE_FLAGS,
  type EvalSet,
  type EvalTicket,
  type InternalTicketView,
  type Route,
  type TriageFlag,
} from "@ai-it-support/shared";
import { createInternalClient, errorClassName, type InternalClient } from "../client.ts";
import { loadLiveConfig, LiveConfigError } from "../config.ts";
import { runJudgePass } from "./judge-pass.ts";
import { computeMetrics, evaluateTargets, writeReport, type EvalResult } from "./metrics.ts";

/** Tickets in flight at one time; the usage guard runs after each batch. */
export const BATCH_SIZE = 4;
/** Budget estimate per ticket (plan resolved point 10): one LLM call, 18 TypeSafe calls. */
export const LLM_CALLS_PER_TICKET = 1;
export const TYPESAFE_CALLS_PER_TICKET = 18;
export const DEFAULT_MAX_LLM_CALLS = 150;
export const DEFAULT_MAX_TYPESAFE_CALLS = 2500;
export const DEFAULT_TICKET_TIMEOUT_MS = 180_000;
export const DEFAULT_POLL_INTERVAL_MS = 2_000;

// Letters, digits and dashes only: the run ID names a folder under .loop-evidence/eval.
const RUN_ID = /^[A-Za-z0-9-]{1,64}$/;
const COUNT = /^\d{1,9}$/;
const PRE_TRIAGE = new Set<string>(["new", "redacted"]);
const REVIEW_STATUSES = new Set<string>([
  "review_pending",
  "approved",
  "rejected",
  "escalated_manual",
]);

export type EvalTicketStatus = "ok" | "failed" | "timeout" | "not_run" | "error";

/** One line of `results.json`: IDs, statuses and labels; never ticket text or fix steps. */
export interface EvalRecord {
  /** Dataset ID, for example `E001`. */
  readonly id: string;
  readonly testId: string;
  readonly status: EvalTicketStatus;
  /** The app's ticket UUID, once created. */
  readonly ticketId: string | null;
  readonly duplicate: boolean;
  readonly category: EvalResult["category"];
  readonly priority: EvalResult["priority"];
  readonly assignmentGroup: EvalResult["assignmentGroup"];
  readonly route: Route | null;
  readonly flags: readonly TriageFlag[];
  /** Error class name, for `error`. */
  readonly error?: string;
}

interface Outcome {
  readonly record: EvalRecord;
  /** For `ok` and `failed`: the result the metrics score. */
  readonly result?: EvalResult;
}

class UsageError extends Error {
  override readonly name = "UsageError";
}

/** The usage endpoint answered, but with a month or counts the guard cannot trust. */
class UsageUntrusted extends Error {
  override readonly name = "UsageUntrusted";
}

interface EvalArgs {
  readonly run: string;
  readonly set: EvalSet | undefined;
  readonly limit: number | undefined;
  readonly maxLlmCalls: number;
  readonly maxTypesafeCalls: number;
}

const OPTIONS = ["--run", "--set", "--limit", "--max-llm-calls", "--max-typesafe-calls"] as const;
type OptionName = (typeof OPTIONS)[number];

function parseArgs(argv: readonly string[]): EvalArgs {
  const values = new Map<OptionName, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") continue;
    const eq = arg.indexOf("=");
    const name = (eq === -1 ? arg : arg.slice(0, eq)) as OptionName;
    if (!OPTIONS.includes(name)) {
      throw new UsageError(`unknown argument (known: ${OPTIONS.join(", ")})`);
    }
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined || value === "") throw new UsageError(`${name} needs a value`);
    if (values.has(name)) throw new UsageError(`${name} is given twice`);
    values.set(name, value);
  }
  const count = (name: OptionName, fallback: number | undefined, min: number) => {
    const value = values.get(name);
    if (value === undefined) return fallback;
    if (!COUNT.test(value) || Number(value) < min) {
      throw new UsageError(`${name} must be a whole number of at least ${min}`);
    }
    return Number(value);
  };
  const run = values.get("--run");
  if (run === undefined) throw new UsageError("--run <id> is required");
  if (!RUN_ID.test(run)) throw new UsageError("--run must be 1-64 letters, digits or dashes");
  const set = values.get("--set");
  if (set !== undefined && !(EVAL_SETS as readonly string[]).includes(set)) {
    throw new UsageError(`--set must be one of ${EVAL_SETS.join(", ")}`);
  }
  return {
    run,
    set: set as EvalSet | undefined,
    limit: count("--limit", undefined, 1),
    maxLlmCalls: count("--max-llm-calls", DEFAULT_MAX_LLM_CALLS, 0)!,
    maxTypesafeCalls: count("--max-typesafe-calls", DEFAULT_MAX_TYPESAFE_CALLS, 0)!,
  };
}

function loadDataset(path: string): EvalTicket[] {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new UsageError("evals/tickets.json could not be read");
  }
  // Never the zod message: it can quote ticket text.
  const parsed = evalTicketSchema.array().safeParse(json);
  if (!parsed.success) throw new UsageError("evals/tickets.json does not match evalTicketSchema");
  return parsed.data;
}

interface Calls {
  readonly llm: number;
  readonly typesafe: number;
}
interface Baseline extends Calls {
  readonly month: string;
}

const monthOf = (ms: number): string => new Date(ms).toISOString().slice(0, 7);

async function readUsage(client: InternalClient, month: string): Promise<Baseline> {
  const usage = await client.usage(month);
  if (usage.month !== month) throw new UsageUntrusted();
  return { month, llm: usage.llm.calls, typesafe: usage.typesafe.calls };
}

/**
 * Calls since the baseline. Across a month boundary the new month's calls are
 * added. A count that went down cannot be trusted, so it throws.
 */
async function usageGrowth(
  client: InternalClient,
  baseline: Baseline,
  now: number,
): Promise<Calls> {
  const same = await readUsage(client, baseline.month);
  let llm = same.llm - baseline.llm;
  let typesafe = same.typesafe - baseline.typesafe;
  const month = monthOf(now);
  if (month !== baseline.month) {
    const next = await readUsage(client, month);
    llm += next.llm;
    typesafe += next.typesafe;
  }
  if (llm < 0 || typesafe < 0) throw new UsageUntrusted();
  return { llm, typesafe };
}

const isFlag = (flag: string): flag is TriageFlag =>
  (TRIAGE_FLAGS as readonly string[]).includes(flag);

function fixStepsOf(fix: Record<string, unknown> | null): string[] {
  const steps = fix?.steps;
  return Array.isArray(steps) ? steps.filter((s): s is string => typeof s === "string") : [];
}

const empty = {
  category: null,
  priority: null,
  assignmentGroup: null,
  route: null,
  flags: [],
} as const;

/** Maps a finished view to an outcome; `undefined` while triage has not finished. */
function classify(
  base: Omit<EvalRecord, "status" | keyof typeof empty>,
  view: InternalTicketView,
): Outcome | undefined {
  if (view.status === "failed") {
    const result: EvalResult = {
      ticketId: base.id,
      status: "failed",
      ...empty,
      route: "auto", // ignored: a failed result is wrong for every metric
      fixSteps: [],
    };
    return { record: { ...base, status: "failed", ...empty }, result };
  }
  const triage = view.triage;
  if (PRE_TRIAGE.has(view.status) || triage === null) return undefined;
  const route: Route = triage.route ?? (REVIEW_STATUSES.has(view.status) ? "review" : "auto");
  const labels = {
    category: triage.category,
    priority: triage.priority,
    assignmentGroup: triage.assignmentGroup,
    route,
    flags: triage.flags.filter(isFlag),
  };
  return {
    record: { ...base, status: "ok", ...labels },
    result: {
      ticketId: base.id,
      status: "ok",
      ...labels,
      fixSteps: fixStepsOf(triage.suggestedFix),
    },
  };
}

interface TicketRun {
  readonly client: InternalClient;
  readonly run: string;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly pollIntervalMs: number;
  readonly ticketTimeoutMs: number;
}

async function runTicket(ctx: TicketRun, ticket: EvalTicket): Promise<Outcome> {
  const testId = `${ctx.run}:${ticket.id}`;
  let base: Omit<EvalRecord, "status" | keyof typeof empty> = {
    id: ticket.id,
    testId,
    ticketId: null,
    duplicate: false,
  };
  const failWith = (error: string): Outcome => ({
    record: { ...base, status: "error", ...empty, error },
  });
  try {
    const created = await ctx.client.createTestTicket({
      name: ticket.name,
      email: ticket.email,
      department: ticket.department,
      title: ticket.title,
      description: ticket.description,
      testId,
    });
    base = { ...base, ticketId: created.ticketId, duplicate: created.duplicate === true };
    if (!created.queued) return failWith("NotQueued");
    const start = ctx.now();
    for (;;) {
      const outcome = classify(base, await ctx.client.ticket(created.ticketId));
      if (outcome) return outcome;
      if (ctx.now() - start >= ctx.ticketTimeoutMs) {
        return { record: { ...base, status: "timeout", ...empty } };
      }
      await ctx.sleep(ctx.pollIntervalMs);
    }
  } catch (error) {
    return failWith(errorClassName(error));
  }
}

export interface RunEvalOptions {
  readonly argv: readonly string[];
  readonly env: Record<string, string | undefined>;
  /** `evals/tickets.json`. */
  readonly datasetPath: string;
  /** The `.loop-evidence` folder. */
  readonly evidenceDir: string;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly fetch?: (input: URL, init: RequestInit) => Promise<Response>;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly pollIntervalMs?: number;
  readonly ticketTimeoutMs?: number;
}

/**
 * `pnpm eval --run <id>`: submits the selected eval tickets as test tickets
 * (`testId` = `<run>:<ticket id>`, BATCH_SIZE at a time), waits for each to be
 * triaged or failed, and writes `results.json`, `metrics.json` and `report.md`
 * under `<evidenceDir>/eval/<run>/`.
 *
 * Budget guard, fail closed: it refuses to start (exit 2, nothing created)
 * when the estimate is above a maximum or the usage cannot be read; after each
 * batch it stops (exit 2, the rest `not_run`) when the growth since the start is
 * above a maximum or the usage cannot be read. Exit 0 only when every DoD
 * target passes, 1 when one is missed, 2 when the run is incomplete.
 * Output carries ticket IDs, statuses and numbers, never ticket text.
 *
 * With `--judges` (`pnpm eval --run <id> --judges`) it runs the judge pass on
 * the finished run instead (judge-pass.ts); the judge files are read from
 * `judges/` next to the dataset.
 */
export async function runEval(options: RunEvalOptions): Promise<number> {
  if (options.argv.includes("--judges")) {
    return runJudgePass({
      argv: options.argv,
      env: options.env,
      datasetPath: options.datasetPath,
      judgesDir: join(dirname(options.datasetPath), "judges"),
      evidenceDir: options.evidenceDir,
      stdout: options.stdout,
      stderr: options.stderr,
      fetch: options.fetch,
      judge: { now: options.now, sleep: options.sleep, pollIntervalMs: options.pollIntervalMs },
    });
  }
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const fail = (message: string): number => {
    options.stderr(`eval: ${message}`);
    return 2;
  };

  let args: EvalArgs;
  let tickets: EvalTicket[];
  let config;
  try {
    args = parseArgs(options.argv);
    config = loadLiveConfig(options.env);
    tickets = loadDataset(options.datasetPath).filter(
      (t) => args.set === undefined || t.set === args.set,
    );
    if (args.limit !== undefined) tickets = tickets.slice(0, args.limit);
  } catch (error) {
    const safe = error instanceof LiveConfigError || error instanceof UsageError;
    return fail(safe ? (error as Error).message : errorClassName(error));
  }
  if (tickets.length === 0) return fail("no tickets selected");

  const evalDir = resolve(options.evidenceDir, "eval");
  const outDir = resolve(evalDir, args.run);
  if (relative(evalDir, outDir) !== args.run) return fail("run ID is malformed");

  const estimate = {
    llm: tickets.length * LLM_CALLS_PER_TICKET,
    typesafe: tickets.length * TYPESAFE_CALLS_PER_TICKET,
  };
  if (estimate.llm > args.maxLlmCalls || estimate.typesafe > args.maxTypesafeCalls) {
    return fail(
      `budget guard: ${tickets.length} tickets need about ${estimate.llm} LLM and ` +
        `${estimate.typesafe} TypeSafe calls; the maximum is ${args.maxLlmCalls} LLM ` +
        `(--max-llm-calls) and ${args.maxTypesafeCalls} TypeSafe (--max-typesafe-calls). Not started.`,
    );
  }

  const client = createInternalClient(config, { fetch: options.fetch });
  let baseline: Baseline;
  try {
    baseline = await readUsage(client, monthOf(now()));
  } catch (error) {
    return fail(`budget guard: usage could not be read (${errorClassName(error)}). Not started.`);
  }

  const startedAt = new Date(now()).toISOString();
  const ctx: TicketRun = {
    client,
    run: args.run,
    now,
    sleep,
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    ticketTimeoutMs: options.ticketTimeoutMs ?? DEFAULT_TICKET_TIMEOUT_MS,
  };
  const outcomes: Outcome[] = [];
  let growth: Calls | null = { llm: 0, typesafe: 0 };
  let stopped: string | null = null;
  for (let i = 0; i < tickets.length && stopped === null; i += BATCH_SIZE) {
    const batch = await Promise.all(tickets.slice(i, i + BATCH_SIZE).map((t) => runTicket(ctx, t)));
    for (const { record } of batch) {
      options.stdout(
        `${record.id} ${record.status}${record.duplicate ? " duplicate" : ""}${record.error ? ` ${record.error}` : ""}`,
      );
    }
    outcomes.push(...batch);
    try {
      growth = await usageGrowth(client, baseline, now());
    } catch (error) {
      growth = null;
      stopped = `usage could not be read (${errorClassName(error)})`;
      break;
    }
    if (growth.llm > args.maxLlmCalls) {
      stopped = `LLM calls grew by ${growth.llm}, above --max-llm-calls ${args.maxLlmCalls}`;
    } else if (growth.typesafe > args.maxTypesafeCalls) {
      stopped = `TypeSafe calls grew by ${growth.typesafe}, above --max-typesafe-calls ${args.maxTypesafeCalls}`;
    }
  }
  for (const ticket of tickets.slice(outcomes.length)) {
    const record: EvalRecord = {
      id: ticket.id,
      testId: `${args.run}:${ticket.id}`,
      status: "not_run",
      ticketId: null,
      duplicate: false,
      ...empty,
    };
    outcomes.push({ record });
  }

  const results = outcomes.flatMap((o) => (o.result ? [o.result] : []));
  const metrics = computeMetrics(tickets, results);
  const targets = evaluateTargets(metrics);
  const records = outcomes.map((o) => o.record);
  mkdirSync(outDir, { recursive: true });
  const resultsPath = join(outDir, "results.json");
  writeFileSync(
    resultsPath,
    `${JSON.stringify(
      {
        runId: args.run,
        startedAt,
        host: config.host,
        options: {
          set: args.set ?? null,
          limit: args.limit ?? null,
          maxLlmCalls: args.maxLlmCalls,
          maxTypesafeCalls: args.maxTypesafeCalls,
        },
        estimate,
        usageAtStart: baseline,
        usageGrowth: growth,
        stopped,
        tickets: records,
      },
      null,
      2,
    )}\n`,
  );
  writeReport(outDir, metrics, targets);

  for (const check of targets.checks) {
    options.stdout(`target ${check.id} ${check.passed ? "pass" : "FAIL"} ${check.actual}`);
  }
  const shown = join(".loop-evidence", "eval", args.run);
  options.stdout(`results: ${join(shown, "results.json")}`);
  options.stdout(`report: ${join(shown, "report.md")}`);

  if (stopped !== null) {
    const notRun = records.filter((r) => r.status === "not_run").length;
    return fail(`budget guard: ${stopped}; stopped with ${notRun} tickets not run`);
  }
  const errors = records.filter((r) => r.status === "error").length;
  if (errors > 0) return fail(`${errors} tickets could not run`);
  return targets.passed ? 0 : 1;
}
