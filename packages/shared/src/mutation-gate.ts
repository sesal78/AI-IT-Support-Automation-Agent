import { z } from "zod";
// `.ts`, so the gate script can run this file in Node by type stripping.
import { type GuardModule, REPO_PATH } from "./guard-modules.ts";

// The mutation gate behind the root script `pnpm test:mutation` (plan §9,
// T3.S.06). This file holds the decisions; packages/shared/scripts/
// mutation-gate.mjs (P3-T15d2) does the git, Stryker and file work. Like
// guard-modules.ts, index.ts does not export it.

/**
 * Files whose change re-runs every module with a floor: the list and its parser,
 * the gate itself (it holds the Stryker options), every Vitest config that the
 * command runner loads, and the root package.json and lockfile (the Stryker and
 * Vitest versions and the `test:mutation` script).
 */
const GATE_FILES = [
  "guard-modules.json",
  "packages/shared/src/guard-modules.ts",
  "packages/shared/scripts/mutation-gate.mjs",
  "packages/shared/src/mutation-gate.ts",
  "vitest.config.ts",
  "apps/web/vitest.config.ts",
  "packages/ai/vitest.config.ts",
  "packages/db/vitest.config.ts",
  "packages/shared/vitest.config.ts",
  "services/pipeline/vitest.config.ts",
  "package.json",
  "pnpm-lock.yaml",
];

/**
 * True when a changed file is a guard module with a mutation floor, its own test
 * file (`x.ts` → `x.test.ts`), one of its listed `tests`, or a gate file.
 * Back-slashes are read as `/`.
 */
export function guardFilesTouched(
  changed: ReadonlyArray<string>,
  list: ReadonlyArray<GuardModule>,
): boolean {
  const watched = new Set([
    ...GATE_FILES,
    ...list
      .filter((m) => m.mutation !== null)
      .flatMap((m) => [m.path, m.path.replace(/\.tsx?$/, ".test$&"), ...(m.tests ?? [])]),
  ]);
  return changed.some((file) => watched.has(file.replaceAll("\\", "/")));
}

// Stryker's standard score: killed ÷ (killed + survived). Ignored, compile
// errors and runtime errors are left out. A finished report has no `Pending`.
const KILLED = ["Killed", "Timeout"];
const SURVIVED = ["Survived", "NoCoverage"];
const LEFT_OUT = ["Ignored", "CompileError", "RuntimeError"];

// The fields that the official mutation-testing-report-schema (3.x) requires.
const position = z.object({ line: z.int().min(1), column: z.int().min(1) });
const percent = z.int().min(0).max(100);
const reportSchema = z.object({
  schemaVersion: z.string().regex(/^[12](\.(0|[1-9]\d*)){0,2}$/),
  thresholds: z.object({ high: percent, low: percent }),
  files: z.record(
    z.string(),
    z.object({
      language: z.string(),
      source: z.string(),
      mutants: z.array(
        z.object({
          id: z.string(),
          mutatorName: z.string(),
          location: z.object({ start: position, end: position }),
          status: z.enum([...KILLED, ...SURVIVED, ...LEFT_OUT]),
        }),
      ),
    }),
  ),
});

/** Thrown when the input is not a finished Stryker JSON report. */
export class MutationReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MutationReportError";
  }
}

/**
 * JSON.parse for a report file that also refuses a repeated key in any object:
 * JSON.parse keeps only the last one, so a forged second entry would go unseen.
 */
export function parseMutationReport(text: string): unknown {
  let report: unknown;
  try {
    report = JSON.parse(text);
  } catch (error) {
    throw new MutationReportError(`not JSON: ${String(error)}`);
  }
  // The text is valid JSON, so a string is a key exactly when it follows `{` or
  // a `,` inside an object. Brackets inside a string are matched as the string.
  const objects: (Set<string> | null)[] = [];
  let keyNext = false;
  for (const [token] of text.matchAll(/"(?:[^"\\]|\\.)*"|[{}[\],]/g)) {
    if (token === "{" || token === "[") objects.push(token === "{" ? new Set() : null);
    else if (token === "}" || token === "]") objects.pop();
    else if (token !== "," && keyNext) {
      const key = JSON.parse(token) as string;
      if (objects.at(-1)?.has(key)) {
        throw new MutationReportError(`repeated key ${JSON.stringify(key)} in the report`);
      }
      objects.at(-1)?.add(key);
    }
    keyNext = (token === "{" || token === ",") && objects.at(-1) instanceof Set;
  }
  return report;
}

/** The key as a path with `/`, or a MutationReportError when it is not a plain repo-relative path. */
function repoKey(key: string): string {
  const path = key.replaceAll("\\", "/");
  // Windows drops a trailing `.` from a name, so `a./b.ts.` opens `a/b.ts`.
  if (!REPO_PATH.test(path) || path.split("/").some((name) => name.endsWith("."))) {
    throw new MutationReportError(`report key ${JSON.stringify(key)} is not repo-relative`);
  }
  return path;
}

export interface MutationCheck {
  path: string;
  floor: number;
  /** Percent, or null when the report has no scored mutant for the module. */
  score: number | null;
  passed: boolean;
  message: string;
}

/** One check for each guard module with a mutation floor, against a Stryker JSON report. */
export function checkMutationReport(
  report: unknown,
  list: ReadonlyArray<GuardModule>,
): MutationCheck[] {
  // zod's z.record drops a `__proto__` key unchecked, so the raw keys are checked first.
  const files = (report as { files?: unknown } | null)?.files;
  if (typeof files === "object" && files !== null) Object.keys(files).forEach(repoKey);
  const parsed = reportSchema.safeParse(report);
  if (!parsed.success) {
    throw new MutationReportError(`not a Stryker JSON report: ${z.prettifyError(parsed.error)}`);
  }
  // A repeated mutant or a second key for the same file would skew the score.
  // Stryker writes plain repo-relative keys, so any other spelling is refused.
  const statusesByPath = new Map<string, string[]>();
  const lowerPaths = new Set<string>();
  const ids = new Set<string>();
  for (const [key, { mutants }] of Object.entries(parsed.data.files)) {
    const path = repoKey(key);
    if (lowerPaths.has(path.toLowerCase())) {
      throw new MutationReportError(`two report keys name ${path}`);
    }
    lowerPaths.add(path.toLowerCase());
    statusesByPath.set(
      path,
      mutants.map((mutant) => mutant.status),
    );
    for (const { id } of mutants) {
      if (ids.has(id)) throw new MutationReportError(`repeated mutant id ${id} in ${path}`);
      ids.add(id);
    }
  }
  return list.flatMap(({ path, mutation: floor }): MutationCheck[] => {
    if (floor === null) return [];
    const statuses = statusesByPath.get(path) ?? [];
    const killed = statuses.filter((status) => KILLED.includes(status)).length;
    const scored = killed + statuses.filter((status) => SURVIVED.includes(status)).length;
    if (scored === 0) {
      return [{ path, floor, score: null, passed: false, message: `${path}: no mutants reported` }];
    }
    const score = (killed / scored) * 100;
    const passed = score >= floor;
    const shown = Math.floor(score * 100) / 100;
    const verdict = passed ? "meets" : "is below";
    const message = `${path}: mutation score ${String(shown)} ${verdict} the floor ${String(floor)} (${String(killed)} of ${String(scored)} killed)`;
    return [{ path, floor, score, passed, message }];
  });
}
