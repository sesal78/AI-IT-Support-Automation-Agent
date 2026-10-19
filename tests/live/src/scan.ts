// Canary scanners for the sinks (plan P3-T12): `scan:traces` reads Langfuse
// observations, `scan:logs` reads exported log files. Both fail closed: an API
// error, a broken page, a cursor loop or nothing to scan is exit 2, never a
// pass. Output names observation IDs or file:line and hit types; it never
// prints a matched value, a key or a response body.
import { readFile } from "node:fs/promises";
import { findCanaries, langfuseEnvShape, parseEnv, redact } from "@ai-it-support/shared";
import { z } from "zod";
import { errorClassName } from "./client.ts";

export const EXIT_CLEAN = 0;
export const EXIT_HARD_HIT = 1;
export const EXIT_NOT_SCANNED = 2;

/** Hit types of one text: hard (`canary:<type>`, `email`) and soft (`unredacted:<TYPE>`). */
export interface TextHits {
  readonly hard: string[];
  readonly soft: string[];
}

// A match may only start at the beginning of a local-part run, so matching
// stays linear on a long run with no `@`.
const EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;

/** The hit types in `text` for the canaries of `runId`. Never returns a value. */
export function scanText(text: string, runId: string): TextHits {
  const hard = findCanaries(text, runId).map((hit) => `canary:${hit.type}`);
  if (EMAIL.test(text)) hard.push("email");
  // EMAIL is already a hard hit; every other change redact() would make is a warning.
  const soft = redact(text)
    .log.filter((entry) => entry.type !== "EMAIL")
    .map((entry) => `unredacted:${entry.type}`);
  return { hard, soft };
}

/** Thrown for a bad command line; the message never quotes an argument. */
export class ScanUsageError extends Error {
  override readonly name = "ScanUsageError";
}

const RUN_ID = /^[a-z0-9]{4,12}$/;

export interface ScanArgs {
  readonly runId: string;
  readonly since: Date | undefined;
  readonly files: string[];
}

/** Parses `--run <id>`, `--since <ISO time>` and positional files. */
export function parseScanArgs(argv: readonly string[]): ScanArgs {
  let runId: string | undefined;
  let since: Date | undefined;
  const files: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") continue;
    if (arg === "--run" || arg === "--since") {
      const value = argv[++i];
      if (value === undefined) throw new ScanUsageError(`${arg} needs a value`);
      if (arg === "--run") runId = value;
      else {
        const time = new Date(value);
        // An ISO date-time with a zone; Date alone accepts too much.
        if (
          !/^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/.test(value) ||
          isNaN(time.getTime())
        ) {
          throw new ScanUsageError("--since must be an ISO date-time with a zone");
        }
        since = time;
      }
    } else if (arg.startsWith("--")) throw new ScanUsageError("unknown option");
    else files.push(arg);
  }
  if (runId === undefined || !RUN_ID.test(runId)) {
    throw new ScanUsageError("--run must be 4-12 lower-case letters or digits");
  }
  return { runId, since, files };
}

export interface ScanOutput {
  stdout(line: string): void;
  stderr(line: string): void;
}

type FetchLike = (input: URL, init: RequestInit) => Promise<Response>;

// Observation IDs are printed, so only plain ID characters are accepted.
const observationSchema = z.looseObject({
  id: z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  metadata: z.unknown().optional(),
});
const pageSchema = z.object({
  data: z.array(observationSchema),
  meta: z.object({ cursor: z.string().min(1).nullable().optional() }),
});

const PAGE_LIMIT = 100;
const MAX_PAGES = 1000;
const ENDPOINT = "GET /api/public/v2/observations";

function asText(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

class TraceApiError extends Error {}

/**
 * Reads every observation with a start time at or after `since` (up to the
 * scan start) from the Langfuse public API, page by page, and scans its input,
 * output and metadata. Returns the exit code.
 */
export async function scanTraces(
  args: ScanArgs,
  env: Record<string, string | undefined>,
  out: ScanOutput,
  options: { fetch?: FetchLike; now?: Date } = {},
): Promise<number> {
  if (args.since === undefined) throw new ScanUsageError("--since is required");
  if (args.files.length > 0) throw new ScanUsageError("scan:traces takes no files");
  let config;
  try {
    config = parseEnv(langfuseEnvShape, env);
  } catch (error) {
    // parseEnv names variables, never values.
    out.stderr(`scan:traces: ${error instanceof Error ? error.message : "invalid environment"}`);
    return EXIT_NOT_SCANNED;
  }
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const origin = new URL(config.LANGFUSE_BASE_URL).origin;
  const auth = `Basic ${Buffer.from(`${config.LANGFUSE_PUBLIC_KEY}:${config.LANGFUSE_SECRET_KEY}`).toString("base64")}`;
  const until = (options.now ?? new Date()).toISOString();

  async function page(cursor: string | undefined): Promise<z.infer<typeof pageSchema>> {
    const url = new URL("/api/public/v2/observations", origin);
    url.searchParams.set("fromStartTime", args.since!.toISOString());
    url.searchParams.set("toStartTime", until);
    url.searchParams.set("fields", "core,io,metadata");
    url.searchParams.set("limit", String(PAGE_LIMIT));
    if (cursor !== undefined) url.searchParams.set("cursor", cursor);
    if (url.origin !== origin) throw new TraceApiError(`${ENDPOINT}: origin refused`);
    let response: Response;
    let text: string;
    try {
      response = await doFetch(url, {
        headers: { Authorization: auth, Accept: "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
      text = await response.text();
    } catch (error) {
      throw new TraceApiError(`${ENDPOINT}: request failed (${errorClassName(error)})`);
    }
    if (response.status !== 200) {
      throw new TraceApiError(`${ENDPOINT}: unexpected status ${response.status}`);
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new TraceApiError(`${ENDPOINT}: page is not JSON`);
    }
    const parsed = pageSchema.safeParse(json);
    if (!parsed.success) throw new TraceApiError(`${ENDPOINT}: page does not match its schema`);
    return parsed.data;
  }

  let scanned = 0;
  let pages = 0;
  let hard = 0;
  let soft = 0;
  let failure: string | undefined;
  const seenCursors = new Set<string>();
  try {
    let cursor: string | undefined;
    do {
      if (pages >= MAX_PAGES) throw new TraceApiError(`${ENDPOINT}: more than ${MAX_PAGES} pages`);
      const result = await page(cursor);
      pages++;
      for (const observation of result.data) {
        const text = [observation.input, observation.output, observation.metadata]
          .map(asText)
          .join("\n");
        const hits = scanText(text, args.runId);
        for (const type of hits.hard) out.stdout(`HARD observation ${observation.id} ${type}`);
        for (const type of hits.soft) out.stdout(`WARN observation ${observation.id} ${type}`);
        hard += hits.hard.length;
        soft += hits.soft.length;
        scanned++;
      }
      cursor = result.meta.cursor ?? undefined;
      if (cursor !== undefined) {
        // A repeated cursor would loop or skip pages: not proven clean.
        if (seenCursors.has(cursor)) throw new TraceApiError(`${ENDPOINT}: cursor repeated`);
        seenCursors.add(cursor);
      }
    } while (cursor !== undefined);
  } catch (error) {
    failure =
      error instanceof TraceApiError ? error.message : `${ENDPOINT}: ${errorClassName(error)}`;
  }

  out.stdout(
    `scan:traces: ${scanned} observations scanned on ${pages} pages; ${hard} hard hits, ${soft} warnings`,
  );
  if (failure !== undefined) out.stderr(`scan:traces: ${failure}; not proven clean`);
  if (hard > 0) return EXIT_HARD_HIT;
  if (failure !== undefined) return EXIT_NOT_SCANNED;
  if (scanned === 0) {
    out.stderr("scan:traces: no observations in the time window; nothing to scan is not a pass");
    return EXIT_NOT_SCANNED;
  }
  return EXIT_CLEAN;
}

/** Scans each log file line by line. Returns the exit code. */
export async function scanLogs(
  args: ScanArgs,
  out: ScanOutput,
  options: { readFile?: (path: string) => Promise<string> } = {},
): Promise<number> {
  if (args.since !== undefined) throw new ScanUsageError("scan:logs takes no --since");
  if (args.files.length === 0) throw new ScanUsageError("scan:logs needs at least one file");
  const read = options.readFile ?? ((path: string) => readFile(path, "utf8"));
  let lines = 0;
  let hard = 0;
  let soft = 0;
  let failed = false;
  for (const file of args.files) {
    let content: string;
    try {
      content = await read(file);
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      const reason =
        typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code) ? code : errorClassName(error);
      out.stderr(`scan:logs: ${file}: cannot read (${reason}); not proven clean`);
      failed = true;
      continue;
    }
    content.split(/\r?\n/).forEach((line, index) => {
      if (line === "") return;
      lines++;
      const hits = scanText(line, args.runId);
      for (const type of hits.hard) out.stdout(`HARD ${file}:${index + 1} ${type}`);
      for (const type of hits.soft) out.stdout(`WARN ${file}:${index + 1} ${type}`);
      hard += hits.hard.length;
      soft += hits.soft.length;
    });
  }
  out.stdout(`scan:logs: ${lines} lines scanned; ${hard} hard hits, ${soft} warnings`);
  if (hard > 0) return EXIT_HARD_HIT;
  if (failed) return EXIT_NOT_SCANNED;
  if (lines === 0) {
    out.stderr("scan:logs: no lines to scan; nothing to scan is not a pass");
    return EXIT_NOT_SCANNED;
  }
  return EXIT_CLEAN;
}

const USAGE = {
  traces: "usage: scan:traces --run <id> --since <ISO date-time>",
  logs: "usage: scan:logs --run <id> <file...>",
};

/** CLI entry: `traces` or `logs`, then the options. Returns the exit code. */
export async function runScan(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  out: ScanOutput,
  options: { fetch?: FetchLike; readFile?: (path: string) => Promise<string>; now?: Date } = {},
): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== "traces" && command !== "logs") {
    out.stderr(`${USAGE.traces}\n${USAGE.logs}`);
    return EXIT_NOT_SCANNED;
  }
  try {
    const args = parseScanArgs(rest);
    return command === "traces"
      ? await scanTraces(args, env, out, options)
      : await scanLogs(args, out, options);
  } catch (error) {
    if (error instanceof ScanUsageError) {
      out.stderr(`scan:${command}: ${error.message}`);
      out.stderr(USAGE[command]);
      return EXIT_NOT_SCANNED;
    }
    out.stderr(`scan:${command}: error (${errorClassName(error)})`);
    return EXIT_NOT_SCANNED;
  }
}
