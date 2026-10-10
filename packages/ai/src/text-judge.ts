import {
  hasUnredactedText,
  type JudgeTextOutput,
  type JudgeTextPayload,
} from "@ai-it-support/shared";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { z } from "zod";
import { BudgetExceededError } from "./meter.js";
import { errorClassName, type createAiRuntime } from "./trace.js";
import { TYPESAFE_MODEL } from "./typesafe-model.js";

/** The state or question holds text that redact() would change. No request was sent. */
export class JudgeInputError extends Error {
  constructor() {
    super("judge input holds unredacted text");
    this.name = "JudgeInputError";
  }
}

/** The judge call failed. The message holds an error class name or field paths only. */
export class JudgeCallError extends Error {
  constructor(reason: string) {
    super(`judge call failed: ${reason}`);
    this.name = "JudgeCallError";
  }
}

/**
 * A TypeSafe client for server-side judges. logLevel is pinned: the SDK logs
 * request bodies at "debug", and TYPESAFE_LOG_LEVEL must not turn that on.
 */
export function createTypeSafeClient(apiKey: string): Pick<TypeSafeClient, "systemOne"> {
  if (apiKey.trim() === "") throw new Error("createTypeSafeClient: apiKey is required");
  return new TypeSafeClient({ apiKey, logLevel: "warn" });
}

export interface TextJudgeDeps {
  client: Pick<TypeSafeClient, "systemOne">;
  runtime: Pick<ReturnType<typeof createAiRuntime>, "call">;
}

const tokenCount = z.number().int().min(0);
const usageSchema = z.object({ input_tokens: tokenCount, output_tokens: tokenCount });

function responseSchema(answer: z.ZodType) {
  return z.object({
    model: z.string().min(1),
    answers: z.strictObject({ judgment: answer }),
    usage: usageSchema,
  });
}

/**
 * One TypeSafe Noul or Score question over a redacted state, metered as one
 * `typesafe` call of kind `judge:<judgeId>` with no ticket. A Score answer is
 * divided by (levels - 1) and rounded to 3 decimals, so the value is 0 to 1.
 * Refuses unredacted input with JudgeInputError before the meter is asked; a
 * refused budget throws BudgetExceededError and sends nothing. Any other
 * failure throws JudgeCallError, whose message never holds judged text.
 */
export function createTextJudge(deps: TextJudgeDeps) {
  const { client, runtime } = deps;

  return {
    async judge(payload: JudgeTextPayload): Promise<JudgeTextOutput> {
      if (hasUnredactedText(payload)) throw new JudgeInputError();
      const { question } = payload;
      const top = question.type === "score" ? question.criteria.length - 1 : 1;
      const schema = responseSchema(
        question.type === "score"
          ? z.object({ type: z.literal("score"), score: z.number().min(0).max(top) })
          : z.object({ type: z.literal("noul"), noul: z.number().min(0).max(1) }),
      );
      const request = {
        model: TYPESAFE_MODEL,
        state: payload.state,
        questions: { judgment: question },
      };

      try {
        const { output } = await runtime.call(
          {
            provider: "typesafe",
            kind: `judge:${payload.judgeId}`,
            calls: 1,
            model: TYPESAFE_MODEL,
            input: request,
          },
          async () => {
            const parsed = schema.safeParse(await client.systemOne(request));
            if (!parsed.success) {
              // Paths only: issue messages can quote the offending values.
              const paths = parsed.error.issues.map((issue) => issue.path.join(".") || "(root)");
              throw new JudgeCallError(
                `unexpected answer shape at ${[...new Set(paths)].join(", ")}`,
              );
            }
            const { answers, usage } = parsed.data;
            const answer = answers.judgment as { score: number } | { noul: number };
            const value =
              "score" in answer ? Math.round((answer.score / top) * 1000) / 1000 : answer.noul;
            return {
              tokensIn: usage.input_tokens,
              tokensOut: usage.output_tokens,
              output: { type: question.type, value },
            };
          },
        );
        return output;
      } catch (error) {
        // SDK error messages can echo the request body, so only the class name goes on.
        if (error instanceof BudgetExceededError || error instanceof JudgeCallError) throw error;
        throw new JudgeCallError(errorClassName(error));
      }
    },
  };
}
