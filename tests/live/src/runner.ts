import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { createInternalClient, errorClassName, type InternalClient } from "./client.ts";
import { loadLiveConfig, LiveConfigError, type LiveConfig } from "./config.ts";
import { createFormPacer, type FormPacer } from "./pacer.ts";

export type ScenarioStatus = "pass" | "fail" | "not_run";

/** IDs and numbers only: a number, a boolean, null, an ID-like string, or a list of those. */
type EvidenceScalar = number | boolean | null | string;
export type Evidence = Record<string, EvidenceScalar | readonly EvidenceScalar[]>;

export interface ScenarioResult {
  readonly status: ScenarioStatus;
  readonly evidence?: Evidence;
}

export interface ScenarioContext {
  readonly config: LiveConfig;
  readonly client: InternalClient;
  readonly pacer: FormPacer;
  /**
   * Plain fetch for the one request that must not carry credentials to a
   * second origin (the staging check). Everything else goes through `client`.
   */
  readonly fetch: (input: URL, init: RequestInit) => Promise<Response>;
  readonly now: () => number;
}

export interface Scenario {
  /** Test ID from the plan, for example `T3.S.02`. */
  readonly id: string;
  run(context: ScenarioContext): Promise<ScenarioResult>;
}

export interface ReportEntry {
  readonly id: string;
  readonly status: ScenarioStatus;
  readonly ms: number;
  readonly evidence: Evidence;
  /** Class name of the error, when the scenario threw or its evidence was refused. */
  readonly error?: string;
}

export interface LiveReport {
  readonly runId: string;
  readonly startedAt: string;
  readonly host: string;
  readonly scenarios: readonly ReportEntry[];
}

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const EVIDENCE_KEY = /^[A-Za-z0-9_.-]{1,64}$/;
// IDs, status names and URL paths. No spaces, quotes or `@`, so no prose or credentials.
const EVIDENCE_STRING = /^[A-Za-z0-9._:/-]{1,200}$/;
const RUN_ID = /^[A-Za-z0-9-]{1,64}$/;

/** Builds the registry. Throws on a duplicate or malformed ID. */
export function createRegistry(scenarios: readonly Scenario[]): ReadonlyMap<string, Scenario> {
  const registry = new Map<string, Scenario>();
  for (const scenario of scenarios) {
    if (!ID_PATTERN.test(scenario.id)) throw new Error("scenario ID is malformed");
    if (registry.has(scenario.id)) throw new Error(`duplicate scenario ID ${scenario.id}`);
    registry.set(scenario.id, scenario);
  }
  return registry;
}

class UsageError extends Error {
  override readonly name = "UsageError";
}

function parseArgs(argv: readonly string[]): { only: string[] | undefined } {
  let only: string[] | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    let value: string | undefined;
    if (arg === "--only") value = argv[++i];
    else if (arg.startsWith("--only=")) value = arg.slice("--only=".length);
    else if (arg === "--") continue;
    else throw new UsageError("unknown argument (known: --only <id,id,...>)");
    if (value === undefined || value === "") throw new UsageError("--only needs test IDs");
    only = [...(only ?? []), ...value.split(",").filter((id) => id !== "")];
  }
  return { only };
}

function cleanEvidence(evidence: unknown, secrets: readonly string[]): Evidence | null {
  if (evidence === undefined) return {};
  if (typeof evidence !== "object" || evidence === null || Array.isArray(evidence)) return null;
  const okScalar = (value: unknown): boolean =>
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" &&
      EVIDENCE_STRING.test(value) &&
      !secrets.some((secret) => value.includes(secret)));
  for (const [key, value] of Object.entries(evidence)) {
    if (!EVIDENCE_KEY.test(key)) return null;
    if (Array.isArray(value) ? !value.every(okScalar) : !okScalar(value)) return null;
  }
  return evidence as Evidence;
}

export interface RunLiveOptions {
  readonly argv: readonly string[];
  readonly env: Record<string, string | undefined>;
  readonly scenarios: readonly Scenario[];
  /** The `.loop-evidence` folder. */
  readonly evidenceDir: string;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly fetch?: (input: URL, init: RequestInit) => Promise<Response>;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly runId?: string;
}

/**
 * Runs the selected scenarios and writes `<evidenceDir>/live/<runId>.json`.
 * Exit code: 0 all passed, 1 one failed, 2 one could not run (or the harness
 * could not start: bad env, bad arguments, unknown IDs). Output and report
 * carry IDs, statuses, numbers and error class names only, never messages.
 */
export async function runLive(options: RunLiveOptions): Promise<number> {
  const now = options.now ?? Date.now;
  let registry: ReadonlyMap<string, Scenario>;
  let selected: Scenario[];
  let config: LiveConfig;
  try {
    registry = createRegistry(options.scenarios);
    const { only } = parseArgs(options.argv);
    if (only !== undefined) {
      const unknown = only.filter((id) => !registry.has(id));
      if (unknown.length > 0) {
        const shown = unknown.map((id) => (ID_PATTERN.test(id) ? id : "(malformed)"));
        throw new UsageError(
          `unknown test IDs: ${shown.join(", ")}. Known: ${[...registry.keys()].join(", ") || "(none)"}`,
        );
      }
    }
    selected = only === undefined ? [...registry.values()] : only.map((id) => registry.get(id)!);
    config = loadLiveConfig(options.env);
  } catch (error) {
    // Only our own errors carry safe messages; anything else shows its class.
    const safe = error instanceof LiveConfigError || error instanceof UsageError;
    options.stderr(`live: ${safe ? (error as Error).message : errorClassName(error)}`);
    return 2;
  }

  const runId =
    options.runId ??
    `${new Date(now()).toISOString().replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}`;
  const liveDir = resolve(options.evidenceDir, "live");
  const reportFile = resolve(liveDir, `${runId}.json`);
  if (!RUN_ID.test(runId) || relative(liveDir, reportFile).includes(sep)) {
    options.stderr("live: run ID is malformed");
    return 2;
  }

  const startedAt = new Date(now()).toISOString();
  const context: ScenarioContext = {
    config,
    client: createInternalClient(config, { fetch: options.fetch }),
    pacer: createFormPacer({ evidenceDir: options.evidenceDir, now, sleep: options.sleep }),
    fetch: options.fetch ?? ((input, init) => fetch(input, init)),
    now,
  };

  const entries: ReportEntry[] = [];
  for (const scenario of selected) {
    const start = now();
    let entry: ReportEntry;
    try {
      const result = await scenario.run(context);
      const evidence = cleanEvidence(result.evidence, config.secrets);
      entry =
        evidence === null
          ? { id: scenario.id, status: "fail", ms: 0, evidence: {}, error: "EvidenceRefused" }
          : { id: scenario.id, status: result.status, ms: 0, evidence };
    } catch (error) {
      entry = {
        id: scenario.id,
        status: "fail",
        ms: 0,
        evidence: {},
        error: errorClassName(error),
      };
    }
    entry = { ...entry, ms: Math.max(0, now() - start) };
    entries.push(entry);
    options.stdout(
      `${entry.id} ${entry.status} ${entry.ms}ms${entry.error ? ` ${entry.error}` : ""}`,
    );
  }

  const report: LiveReport = { runId, startedAt, host: config.host, scenarios: entries };
  mkdirSync(liveDir, { recursive: true });
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  options.stdout(`report: ${join(".loop-evidence", "live", `${runId}.json`)}`);

  if (entries.some((entry) => entry.status === "fail")) return 1;
  if (entries.some((entry) => entry.status === "not_run")) return 2;
  return 0;
}
