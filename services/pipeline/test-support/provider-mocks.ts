// Canned TypeSafe, LLM and Langfuse answers and the pipeline env for the local
// REST stack. TEST CODE ONLY: never import it from `src`. Shared by the triage
// integration harness (P3-T10e/f) and the local runner (P3-T10g). It does not
// import vitest, so a non-vitest process (Playwright setup) can load it too.
import { SENSITIVE_TOPICS } from "@ai-it-support/ai";
import { ASSIGNMENT_GROUPS, CATEGORIES, PRIORITIES, URGENCIES } from "@ai-it-support/shared";
import { HttpResponse } from "msw";
import type { RestStack } from "../../../packages/db/integration/rest-stack.js";
import type { EgressRecorder } from "../../../packages/shared/test-support/egress-recorder.js";

// Public endpoints, never reached: every request to them is answered by msw.
export const LLM_BASE_URL = "https://opencode.ai/zen/go/v1";
export const LANGFUSE_BASE_URL = "https://cloud.langfuse.com";
// The SDK's own default, unless the environment points it elsewhere.
export const TYPESAFE_ORIGIN = new URL(
  process.env.TYPESAFE_BASE_URL?.trim() || "https://api.typesafe.ai",
).origin;
export const ORIGINS = {
  typesafe: new URL(TYPESAFE_ORIGIN).host,
  llm: new URL(LLM_BASE_URL).host,
  langfuse: new URL(LANGFUSE_BASE_URL).host,
};
const MODEL = "jev-1.13.0";
const TOKENS = { input_tokens: 40, output_tokens: 6 };

const probabilities = <L extends string>(labels: readonly L[], pick: L) =>
  Object.fromEntries(
    labels.map((label) => [label, label === pick ? 0.9 : 0.1 / (labels.length - 1)]),
  );
const choiceAnswer = <L extends string>(labels: readonly L[], pick: L) => ({
  type: "choice",
  choice: pick,
  confidence: 0.9,
  probabilities: probabilities(labels, pick),
});

/** One System One answer per request kind, told apart by the question keys. */
function typesafeAnswer(questions: string[]): Record<string, unknown> {
  if (questions.includes("legal")) {
    return Object.fromEntries(
      SENSITIVE_TOPICS.map((topic) => [topic, { type: "noul", noul: 0.02 }]),
    );
  }
  if (questions.includes("category")) {
    return {
      category: choiceAnswer(CATEGORIES, "network"),
      priority: choiceAnswer(PRIORITIES, "P3"),
      urgency: choiceAnswer(URGENCIES, "medium"),
      assignment_group: choiceAnswer(ASSIGNMENT_GROUPS, "Network"),
      outage_or_duplicate: { type: "noul", noul: 0.05 },
      injection: { type: "noul", noul: 0.02 },
      actionable: { type: "noul", noul: 0.95 },
    };
  }
  if (questions.includes("grounded")) return { grounded: { type: "score", score: 3 } };
  // KB rerank: a1 is the best match, the rest loosely related.
  return Object.fromEntries(
    questions.map((key) => [key, { type: "score", score: key === "a1" ? 3 : 1 }]),
  );
}

export const questionKeys = (body: string): string[] =>
  Object.keys((JSON.parse(body) as { questions?: Record<string, unknown> }).questions ?? {});

/** A 200 System One reply for a TypeSafe request body. */
export const typesafeReply = (body: string) =>
  HttpResponse.json({ model: MODEL, answers: typesafeAnswer(questionKeys(body)), usage: TOKENS });

/** A 200 chat completion whose message content is `content`. */
export const llmReply = (content: string) =>
  HttpResponse.json({
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1_790_000_000,
    model: "test-llm",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
  });

export const FIX_REPLY = JSON.stringify({
  steps: ["Restart the VPN client.", "Sign in to the VPN again."],
  caveats: [],
});

/** The default mocks; a test registers its own after them to override one host. */
export function mockProviders(recorder: EgressRecorder): void {
  recorder.mock(TYPESAFE_ORIGIN, async ({ request }) => typesafeReply(await request.text()));
  recorder.mock(LLM_BASE_URL, () => llmReply(FIX_REPLY));
  recorder.mock(LANGFUSE_BASE_URL, () => HttpResponse.json({}));
}

/** The pipeline env for the local REST stack, with test-only provider keys. */
export function pipelineEnv(stack: RestStack, e2eMode = false): Record<string, string> {
  return {
    SUPABASE_URL: stack.url,
    SUPABASE_SERVICE_ROLE_KEY: stack.serviceRoleKey,
    SUPABASE_DB_SCHEMA: "itsupport",
    TYPESAFE_API_KEY: "x".repeat(32),
    LLM_API_KEY: "x".repeat(32),
    LLM_BASE_URL,
    LLM_MODEL: "test-llm",
    LANGFUSE_PUBLIC_KEY: "x".repeat(16),
    LANGFUSE_SECRET_KEY: "x".repeat(24),
    LANGFUSE_BASE_URL,
    E2E_MODE: e2eMode ? "true" : "false",
  };
}
