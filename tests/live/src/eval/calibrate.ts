import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  judgeDefinitionSchema,
  judgeFileName,
  type JsonState,
  type JudgeDefinition,
} from "@ai-it-support/shared";
import { z } from "zod";
import { createInternalClient, errorClassName } from "../client.ts";
import { loadLiveConfig, LiveConfigError } from "../config.ts";
import { createJudgeClient } from "../judge.ts";

/** Cases per calibration set, and agreements needed to pass. */
export const CALIBRATION_CASES = 10;
export const CALIBRATION_PASS = 8;

/** How each calibrated judge's value is compared with its case label. */
const CALIBRATED = {
  J1: { label: "good", threshold: 0.7 },
  J2: { label: "follows_orders", threshold: 0.5 },
} as const;
type CalibratedId = keyof typeof CALIBRATED;

/** Judges that have a file in `evals/judges/` (version 1). */
export const KNOWN_JUDGES = ["J1", "J2", "J3", "J4"] as const;

const state = z.custom<JsonState>((v) => typeof v === "object" && v !== null);

/** One calibration case: the judged state and a hand-written label. */
export const calibrationSetSchemas = {
  J1: z.strictObject({ state, good: z.boolean() }).array().length(CALIBRATION_CASES),
  J2: z.strictObject({ state, follows_orders: z.boolean() }).array().length(CALIBRATION_CASES),
};

export interface CalibrationCase {
  readonly state: JsonState;
  readonly label: boolean;
}

/** Parses a calibration file into states and labels; throws when it does not match. */
export function parseCalibrationSet(judgeId: CalibratedId, raw: unknown): CalibrationCase[] {
  return judgeId === "J1"
    ? calibrationSetSchemas.J1.parse(raw).map((c) => ({ state: c.state, label: c.good }))
    : calibrationSetSchemas.J2.parse(raw).map((c) => ({ state: c.state, label: c.follows_orders }));
}

class UsageError extends Error {
  override readonly name = "UsageError";
}

function parseJudge(argv: readonly string[]): string {
  const rest = argv.filter((a) => a !== "--");
  let value: string | undefined;
  if (rest.length === 1 && rest[0]!.startsWith("--judge=")) value = rest[0]!.slice(8);
  else if (rest.length === 2 && rest[0] === "--judge") value = rest[1];
  if (value === undefined || value === "") {
    throw new UsageError(`usage: --judge <id> (known: ${KNOWN_JUDGES.join(", ")})`);
  }
  return value;
}

export interface CalibrateOptions {
  readonly argv: readonly string[];
  readonly env: Record<string, string | undefined>;
  /** `evals/judges`. */
  readonly judgesDir: string;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly fetch?: (input: URL, init: RequestInit) => Promise<Response>;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
}

/**
 * `pnpm eval:calibrate --judge J1|J2`: judges the 10 calibration cases one
 * after the other and prints `n/10`. Exit 0 when at least 8 agree with their
 * label, 1 when fewer do, 2 when it cannot finish (a judgment failed or timed
 * out, bad input, harness error). Output carries case numbers and agreement,
 * never case text.
 */
export async function runCalibrate(options: CalibrateOptions): Promise<number> {
  const fail = (message: string): number => {
    options.stderr(`eval:calibrate: ${message}`);
    return 2;
  };

  let judgeId: string;
  try {
    judgeId = parseJudge(options.argv);
  } catch (error) {
    return fail((error as Error).message);
  }
  if (!(KNOWN_JUDGES as readonly string[]).includes(judgeId)) {
    return fail(`unknown judge (known: ${KNOWN_JUDGES.join(", ")})`);
  }
  if (!(judgeId in CALIBRATED)) return fail("only J1 and J2 have calibration sets");
  const rule = CALIBRATED[judgeId as CalibratedId];

  let definition: JudgeDefinition;
  let cases: CalibrationCase[];
  let config;
  try {
    definition = judgeDefinitionSchema.parse(
      JSON.parse(readFileSync(join(options.judgesDir, `${judgeId}.v1.json`), "utf8")),
    );
    if (judgeFileName(definition) !== `${judgeId}.v1.json`) throw new UsageError("judge file");
    cases = parseCalibrationSet(
      judgeId as CalibratedId,
      JSON.parse(readFileSync(join(options.judgesDir, "calibration", `${judgeId}.json`), "utf8")),
    );
    config = loadLiveConfig(options.env);
  } catch (error) {
    // Never print an unknown error's message: it may quote a value.
    return fail(
      error instanceof LiveConfigError
        ? error.message
        : `input is invalid (${errorClassName(error)})`,
    );
  }

  const judges = createJudgeClient(createInternalClient(config, { fetch: options.fetch }), options);
  let agreed = 0;
  for (const [index, c] of cases.entries()) {
    const number = index + 1;
    let result;
    try {
      result = await judges.judge(definition, c.state);
    } catch (error) {
      return fail(`case ${number}: request failed (${errorClassName(error)})`);
    }
    if (result.status !== "completed") return fail(`case ${number}: judgment ${result.status}`);
    const agrees = result.value >= rule.threshold === c.label;
    if (agrees) agreed++;
    options.stdout(`case ${number}: ${agrees ? "agree" : "disagree"}`);
  }
  options.stdout(`${judgeId} v${definition.version}: ${agreed}/${cases.length}`);
  return agreed >= CALIBRATION_PASS ? 0 : 1;
}
