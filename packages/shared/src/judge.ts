import { z } from "zod";
import { redact } from "./redact.js";

/** Trigger.dev task id of the e2e test judge (services/pipeline). */
export const JUDGE_TEXT_TASK_ID = "judge-text";

/** A Score rubric has 2 to 10 levels, indexed from 0. */
export const JUDGE_SCORE_LEVELS = { min: 2, max: 10 } as const;
/** The state as JSON may hold at most this many characters. */
export const JUDGE_STATE_MAX_CHARS = 32_000;
/** Objects and arrays nest at most this deep; the state itself is depth 1. */
export const JUDGE_STATE_MAX_DEPTH = 8;

// Keys that can reach an object's prototype if any later code merges the state.
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const text = z.string().min(1).max(4000);
const description = text.nullable();

const noulQuestion = z.strictObject({
  type: z.literal("noul"),
  instructions: text,
  criteria: z
    .strictObject({ true: description.optional(), false: description.optional() })
    .nullable()
    .optional(),
});

const scoreQuestion = z.strictObject({
  type: z.literal("score"),
  instructions: text,
  // A tuple of at least two, so the type matches the SDK's ScoreCriteria.
  criteria: z
    .tuple([description, description], description)
    .refine((levels) => levels.length <= JUDGE_SCORE_LEVELS.max, {
      message: `must have at most ${JUDGE_SCORE_LEVELS.max} levels`,
    }),
});

/** One TypeSafe Noul or Score question; `choice` is refused. */
export const judgeQuestionSchema = z.discriminatedUnion("type", [noulQuestion, scoreQuestion]);
export type JudgeQuestion = z.infer<typeof judgeQuestionSchema>;

type JsonState = { [key: string]: JsonValue };
type JsonValue = string | number | boolean | null | JsonValue[] | JsonState;

/**
 * Null when `value` is a plain JSON object whose leaves are strings, finite
 * numbers, booleans or null, nested at most JUDGE_STATE_MAX_DEPTH deep, with
 * no prototype-reaching key. Otherwise a message without any value in it.
 */
function stateProblem(value: unknown, depth: number): string | null {
  if (value === null || typeof value === "string" || typeof value === "boolean") return null;
  if (typeof value === "number") return Number.isFinite(value) ? null : "must be finite";
  if (typeof value !== "object") return "must be JSON";
  if (depth > JUDGE_STATE_MAX_DEPTH) return `must nest at most ${JUDGE_STATE_MAX_DEPTH} deep`;
  if (Array.isArray(value)) {
    for (const item of value) {
      const problem = stateProblem(item, depth + 1);
      if (problem) return problem;
    }
    return null;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) return "must be JSON";
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) return "holds a forbidden key";
    const problem = stateProblem((value as Record<string, unknown>)[key], depth + 1);
    if (problem) return problem;
  }
  return null;
}

const stateSchema = z.custom<JsonState>().superRefine((value, ctx) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    ctx.addIssue({ code: "custom", message: "must be an object" });
    return;
  }
  const problem = stateProblem(value, 1);
  if (problem) {
    ctx.addIssue({ code: "custom", message: problem });
    return;
  }
  if (JSON.stringify(value).length > JUDGE_STATE_MAX_CHARS) {
    ctx.addIssue({
      code: "custom",
      message: `must be at most ${JUDGE_STATE_MAX_CHARS} characters`,
    });
  }
});

/** Payload of the `judge-text` task and body of POST /api/internal/judgments. */
export const judgeTextPayloadSchema = z.strictObject({
  judgeId: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
  version: z.int().min(1).max(1000),
  question: judgeQuestionSchema,
  state: stateSchema,
});
export type JudgeTextPayload = z.infer<typeof judgeTextPayloadSchema>;

/** The task output: the Noul probability, or the Score divided by (levels - 1). */
export const judgeTextOutputSchema = z.strictObject({
  type: z.enum(["noul", "score"]),
  value: z.number().min(0).max(1),
});
export type JudgeTextOutput = z.infer<typeof judgeTextOutputSchema>;

function* strings(value: unknown): Generator<string> {
  if (typeof value === "string") yield value;
  // A number is sent as its decimal form, so a phone or card number typed as
  // a number is checked like the same digits in a string.
  else if (typeof value === "number") yield String(value);
  else if (Array.isArray(value)) for (const item of value) yield* strings(item);
  else if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      yield key;
      yield* strings(item);
    }
  }
}

/**
 * True when redact() would change any key, string or number anywhere in the
 * question or the state: that text is not allowed to leave and is not judged.
 */
export function hasUnredactedText(payload: Pick<JudgeTextPayload, "question" | "state">): boolean {
  for (const value of strings([payload.question, payload.state])) {
    if (redact(value).text !== value) return true;
  }
  return false;
}
