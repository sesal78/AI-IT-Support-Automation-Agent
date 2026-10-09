import { score, type ScoreQuestion, type TypeSafeClient } from "@typesafe-ai/sdk";
import { z } from "zod";
import { TriageParseError } from "./judgments.js";
import type { createAiRuntime } from "./trace.js";
import { TYPESAFE_MODEL } from "./typesafe-model.js";

/** At most this many candidates are scored; one TypeSafe call each. */
export const KB_RERANK_MAX_CANDIDATES = 5;
/** The reranked list keeps this many articles. */
export const KB_RERANK_TOP = 3;
/** Article content beyond this many characters is not sent. */
export const KB_RERANK_CONTENT_MAX_CHARS = 4000;

const RUBRIC = [
  "Not relevant: the article is about a different problem.",
  "Loosely related: the article touches the same area but does not help with this problem.",
  "Partly helpful: the article covers part of the problem or a closely related one.",
  "Directly solves the problem: following the article should resolve the ticket.",
] as const;
const TOP_LEVEL = RUBRIC.length - 1;

/** A `searchKb` result row; structural, so this package does not import `db`. */
export interface KbCandidate {
  id: string;
  slug: string;
  title: string;
  content: string;
  /** Full-text rank; higher is better. */
  rank: number;
}

export interface KbRerankInput {
  ticketId: string;
  /** Already redacted. */
  ticket: { title: string; description: string };
  candidates: readonly KbCandidate[];
}

export interface KbRerankResult {
  id: string;
  slug: string;
  /** The Score answer divided by 3, rounded to 3 decimals: 0 to 1. */
  score: number;
}

export interface KbRerankDeps {
  client: Pick<TypeSafeClient, "systemOne">;
  runtime: Pick<ReturnType<typeof createAiRuntime>, "call">;
}

const tokenCount = z.number().int().min(0);

// Only `type` and `score` are used; the legend, probabilities and confidence
// the API also returns are not checked.
const scoreAnswer = z.object({
  type: z.literal("score"),
  score: z.number().min(0).max(TOP_LEVEL),
});

function responseSchema(keys: readonly string[]) {
  return z.object({
    model: z.string().min(1),
    answers: z.strictObject(Object.fromEntries(keys.map((key) => [key, scoreAnswer]))),
    usage: z.object({ input_tokens: tokenCount, output_tokens: tokenCount }),
  });
}

function question(key: string): ScoreQuestion {
  return score(
    `How well does the knowledge base article in \`articles.${key}\` help resolve the IT support ticket in \`ticket\`?`,
    RUBRIC,
  );
}

/**
 * Reranks knowledge base candidates in one TypeSafe System One request: one
 * Score question per candidate, metered as one `typesafe` call per candidate
 * of kind `kb_rerank`. With more than 5 candidates, the 5 with the highest
 * full-text rank are scored. Returns the top 3, best first; a tie goes to the
 * higher full-text rank. Every failure (budget, API, shape) throws.
 */
export function createKbReranker(deps: KbRerankDeps) {
  const { client, runtime } = deps;

  return {
    async rerankKb(input: KbRerankInput): Promise<KbRerankResult[]> {
      const candidates = input.candidates
        .map((candidate, index) => ({ candidate, index }))
        .sort((a, b) => b.candidate.rank - a.candidate.rank || a.index - b.index)
        .slice(0, KB_RERANK_MAX_CANDIDATES)
        .map(({ candidate }) => candidate);
      if (candidates.length === 0) return [];

      const keys = candidates.map((_, index) => `a${index + 1}`);
      const request = {
        model: TYPESAFE_MODEL,
        state: {
          ticket: { title: input.ticket.title, description: input.ticket.description },
          articles: Object.fromEntries(
            candidates.map((candidate, index) => [
              keys[index]!,
              {
                title: candidate.title,
                content: candidate.content.slice(0, KB_RERANK_CONTENT_MAX_CHARS),
              },
            ]),
          ),
        },
        questions: Object.fromEntries(keys.map((key) => [key, question(key)])),
      };
      const schema = responseSchema(keys);

      const { output } = await runtime.call(
        {
          provider: "typesafe",
          kind: "kb_rerank",
          calls: candidates.length,
          ticketId: input.ticketId,
          model: TYPESAFE_MODEL,
          input: request,
        },
        async () => {
          const parsed = schema.safeParse(await client.systemOne(request));
          if (!parsed.success) {
            // Paths only: issue messages can quote the offending values.
            const paths = parsed.error.issues.map((issue) => issue.path.join(".") || "(root)");
            throw new TriageParseError([...new Set(paths)]);
          }
          const { answers, usage } = parsed.data;
          const ranked = candidates
            .map((candidate, index) => ({
              candidate,
              index,
              score: answers[keys[index]!]!.score / TOP_LEVEL,
            }))
            .sort((a, b) => b.score - a.score || a.index - b.index)
            .slice(0, KB_RERANK_TOP)
            .map(({ candidate, score: s }) => ({
              id: candidate.id,
              slug: candidate.slug,
              score: Math.round(s * 1000) / 1000,
            }));
          return { tokensIn: usage.input_tokens, tokensOut: usage.output_tokens, output: ranked };
        },
      );
      return output;
    },
  };
}
