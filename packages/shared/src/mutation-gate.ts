import { z } from "zod";
import type { GuardModule } from "./guard-modules.js";

// The mutation gate behind the root script `pnpm test:mutation` (plan §9,
// T3.S.06). This file holds the decisions; packages/shared/scripts/
// mutation-gate.mjs (P3-T15d2) does the git, Stryker and file work. Like
// guard-modules.ts, index.ts does not export it.

/** Files whose change re-runs every module with a floor: the list and the gate itself (it holds the Stryker options). */
const GATE_FILES = [
  "guard-modules.json",
  "packages/shared/scripts/mutation-gate.mjs",
  "packages/shared/src/mutation-gate.ts",
];

/** True when a changed file is a guard module with a mutation floor, or a gate file. Back-slashes are read as `/`. */
export function guardFilesTouched(
  changed: ReadonlyArray<string>,
  list: ReadonlyArray<GuardModule>,
): boolean {
  const watched = new Set([
    ...GATE_FILES,
    ...list.filter((m) => m.mutation !== null).map((m) => m.path),
  ]);
  return changed.some((file) => watched.has(file.replaceAll("\\", "/")));
}

// Stryker's standard score: killed ÷ (killed + survived). Ignored, compile
// errors and runtime errors are left out. A finished report has no `Pending`.
const KILLED = ["Killed", "Timeout"];
const SURVIVED = ["Survived", "NoCoverage"];
const LEFT_OUT = ["Ignored", "CompileError", "RuntimeError"];

const reportSchema = z.object({
  schemaVersion: z.string(),
  files: z.record(
    z.string(),
    z.object({
      mutants: z.array(z.object({ status: z.enum([...KILLED, ...SURVIVED, ...LEFT_OUT]) })),
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
  const parsed = reportSchema.safeParse(report);
  if (!parsed.success) {
    throw new MutationReportError(`not a Stryker JSON report: ${z.prettifyError(parsed.error)}`);
  }
  return list.flatMap(({ path, mutation: floor }): MutationCheck[] => {
    if (floor === null) return [];
    const statuses = (parsed.data.files[path]?.mutants ?? []).map((mutant) => mutant.status);
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
