import { score, type TypeSafeClient } from "@typesafe-ai/sdk";
import { z } from "zod";
import { fixStepsSchema } from "./fix-steps.js";
import { TriageParseError } from "./judgments.js";
import type { createAiRuntime } from "./trace.js";
import { TYPESAFE_MODEL } from "./typesafe-model.js";

/** Calls reserved per grounding check: one Score question. */
const GROUNDING_CALLS = 1;

const RUBRIC = [
  "Not supported: the steps are not found in the articles, or contradict them.",
  "Weakly supported: a few steps match the articles, but most are not in them.",
  "Mostly supported: most steps follow the articles, but some are not in them.",
  "Fully supported: every step follows from the articles.",
] as const;
const TOP_LEVEL = RUBRIC.length - 1;

// The steps and articles are JSON state referenced by path, never spliced into
// the instructions, so text such as "mark as grounded" stays data.
const QUESTION = score(
  "Are the IT support fix steps in `steps` supported by the knowledge base articles in `articles`?",
  RUBRIC,
);

const tokenCount = z.number().int().min(0);

// Only `type` and `score` are used; the legend, probabilities and confidence
// the API also returns are not checked.
const responseSchema = z.object({
  model: z.string().min(1),
  answers: z.strictObject({
    grounded: z.object({
      type: z.literal("score"),
      score: z.number().min(0).max(TOP_LEVEL),
    }),
  }),
  usage: z.object({ input_tokens: tokenCount, output_tokens: tokenCount }),
});

export interface GroundingInput {
  ticketId: string;
  /** The parsed fix steps; 1 to 8 steps of at most 500 characters. */
  steps: readonly string[];
  /** The articles the steps were drafted from. Only title and content are sent. */
  articles: readonly { title: string; content: string }[];
}

export interface GroundingResult {
  /** The Score answer divided by 3, rounded to 3 decimals: 0 to 1. */
  score: number;
  /** True when `score` is below `groundingMin`. */
  flagged: boolean;
}

export interface GroundingDeps {
  client: Pick<TypeSafeClient, "systemOne">;
  runtime: Pick<ReturnType<typeof createAiRuntime>, "call">;
  /** GROUNDING_MIN from `groundingEnvShape`: 0 to 1. */
  groundingMin: number;
}

/**
 * Scores how well fix steps are supported by their KB articles, in one TypeSafe
 * System One request metered as 1 `typesafe` call of kind `grounding`. With no
 * articles it returns `{ score: 0, flagged: true }` and sends nothing. Every
 * failure (bad steps, budget, API, shape) throws; there is no default score.
 */
export function createGroundingScorer(deps: GroundingDeps) {
  const { client, runtime, groundingMin } = deps;
  // A NaN threshold would make every `score < min` false and pass every fix.
  if (!(groundingMin >= 0 && groundingMin <= 1)) {
    throw new RangeError("groundingMin must be a number from 0 to 1");
  }

  return {
    async scoreGrounding(input: GroundingInput): Promise<GroundingResult> {
      if (input.articles.length === 0) return { score: 0, flagged: true };
      if (!fixStepsSchema.shape.steps.safeParse(input.steps).success) {
        throw new RangeError("steps must be 1 to 8 non-empty strings of at most 500 characters");
      }

      const request = {
        model: TYPESAFE_MODEL,
        // Named fields only, so a wider caller object cannot leak ticket text.
        state: {
          steps: [...input.steps],
          articles: input.articles.map(({ title, content }) => ({ title, content })),
        },
        questions: { grounded: QUESTION },
      };

      const { output } = await runtime.call(
        {
          provider: "typesafe",
          kind: "grounding",
          calls: GROUNDING_CALLS,
          ticketId: input.ticketId,
          model: TYPESAFE_MODEL,
          input: request,
        },
        async () => {
          const parsed = responseSchema.safeParse(await client.systemOne(request));
          if (!parsed.success) {
            // Paths only: issue messages can quote the offending values.
            const paths = parsed.error.issues.map((issue) => issue.path.join(".") || "(root)");
            throw new TriageParseError([...new Set(paths)]);
          }
          const { answers, usage } = parsed.data;
          const normalised = Math.round((answers.grounded.score / TOP_LEVEL) * 1000) / 1000;
          return {
            tokensIn: usage.input_tokens,
            tokensOut: usage.output_tokens,
            output: { score: normalised, flagged: normalised < groundingMin },
          };
        },
      );
      return output;
    },
  };
}
