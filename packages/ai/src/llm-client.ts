import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { APICallError, RetryError, generateText } from "ai";
import {
  FixParseError,
  buildFixPrompt,
  parseFixSteps,
  type FixPromptInput,
  type FixSteps,
} from "./fix-steps.js";
import type { createAiRuntime } from "./trace.js";

/**
 * Whole-request limit for one fix-step request. With one retry a draft still
 * ends within about 20 s, the single-request limit before P3-T10k.
 */
export const LLM_TIMEOUT_MS = 10_000;
/** Requests per draft at most: the first, and one retry after a transient failure. */
export const LLM_MAX_ATTEMPTS = 2;
/** Calls reserved per request: one chat completion. */
const FIX_STEPS_CALLS = 1;

/** The provider refused the call for quota or rate reasons (HTTP 429). */
export class LlmUnavailableError extends Error {
  readonly status = 429;

  constructor() {
    super("LLM unavailable: HTTP 429");
    this.name = "LlmUnavailableError";
  }
}

export type LlmErrorKind = "http" | "timeout" | "network";

/**
 * The LLM call failed. The message holds the kind and the status only, never
 * a request or response body, a header or the key; there is no `cause`.
 */
export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  /** The HTTP status, or null when no response arrived. */
  readonly status: number | null;

  constructor(kind: LlmErrorKind, status: number | null = null) {
    super(status === null ? `LLM call failed: ${kind}` : `LLM call failed: ${kind} ${status}`);
    this.name = "LlmError";
    this.kind = kind;
    this.status = status;
  }
}

export interface FixDrafterDeps {
  apiKey: string;
  /** OpenAI-compatible base URL, e.g. `https://opencode.ai/zen/go/v1`. */
  baseUrl: string;
  model: string;
  runtime: Pick<ReturnType<typeof createAiRuntime>, "call">;
  /** APP_VERSION from the pipeline env; `unknown` when unset. */
  appVersion?: string | undefined;
  /** Default LLM_TIMEOUT_MS. */
  timeoutMs?: number;
}

export interface FixDraftInput extends FixPromptInput {
  ticketId: string;
  /** Replaces the env cap for this call. 0 refuses the call. */
  capOverride?: number;
}

export interface FixDraft extends FixSteps {
  /** The model the API reports. */
  model: string;
  usage: { tokensIn: number; tokensOut: number };
}

/** Maps any generateText failure to LlmUnavailableError or LlmError; drops the original. */
function toLlmError(error: unknown): Error {
  const last = RetryError.isInstance(error) ? error.lastError : error;
  if (APICallError.isInstance(last)) {
    if (last.statusCode === 429) return new LlmUnavailableError();
    if (last.statusCode !== undefined) return new LlmError("http", last.statusCode);
    return new LlmError("network");
  }
  if (last instanceof Error && (last.name === "TimeoutError" || last.name === "AbortError")) {
    return new LlmError("timeout");
  }
  return new LlmError("network");
}

/**
 * A failure that a second request may not repeat: a timeout, a network error,
 * an HTTP 408 or 5xx, a 2xx body the SDK could not read, or a reply that fails
 * `parseFixSteps`. Never a 429 (`LlmUnavailableError`), another 4xx, or a
 * refused budget (`BudgetExceededError`).
 */
export function isTransientLlmError(error: unknown): boolean {
  if (error instanceof FixParseError) return true;
  if (!(error instanceof LlmError)) return false;
  if (error.kind !== "http" || error.status === null) return true;
  return error.status === 408 || error.status < 400 || error.status >= 500;
}

/**
 * Fix-step drafts from an OpenAI-compatible chat model (OpenCode Go). Plain
 * text, no tools, SDK retries off. Each request has its own `LLM_TIMEOUT_MS`
 * limit and its own `runtime.call` (provider `llm`, kind `fix_steps`), so the
 * budget is reserved before every request and every request counts toward
 * the cap and gets its own span. A transient failure (`isTransientLlmError`)
 * is retried once inside the draft, so one slow or broken reply does not fail
 * the whole triage run; any other failure, and a second failure, is thrown.
 * The reply must pass `parseFixSteps`; there is no repair.
 */
export function createFixDrafter(deps: FixDrafterDeps) {
  const { apiKey, baseUrl, model, runtime } = deps;
  const timeoutMs = deps.timeoutMs ?? LLM_TIMEOUT_MS;
  // Honest client name only: the SDK appends its own User-Agent parts, so the
  // header is set here, last, to exactly this value.
  const userAgent = `ai-it-support-agent/${deps.appVersion || "unknown"}`;
  const provider = createOpenAICompatible({
    name: "opencode-go",
    apiKey,
    baseURL: baseUrl,
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("user-agent", userAgent);
      return globalThis.fetch(input, { ...init, headers });
    },
  });
  const chatModel = provider.chatModel(model);

  /** One metered, traced request. */
  async function request(input: FixDraftInput, system: string, user: string): Promise<FixDraft> {
    const { output } = await runtime.call(
      {
        provider: "llm",
        kind: "fix_steps",
        calls: FIX_STEPS_CALLS,
        ticketId: input.ticketId,
        ...(input.capOverride === undefined ? {} : { capOverride: input.capOverride }),
        model,
        input: { model, system, user },
      },
      async () => {
        let result: Awaited<ReturnType<typeof generateText>>;
        try {
          result = await generateText({
            model: chatModel,
            system,
            prompt: user,
            maxRetries: 0,
            timeout: timeoutMs,
          });
        } catch (error) {
          throw toLlmError(error);
        }
        const fix = parseFixSteps(result.text);
        const usage = {
          tokensIn: result.usage.inputTokens ?? 0,
          tokensOut: result.usage.outputTokens ?? 0,
        };
        return {
          ...usage,
          output: {
            steps: fix.steps,
            caveats: fix.caveats,
            model: result.response.modelId,
            usage,
          },
        };
      },
    );
    return output;
  }

  return {
    async draft(input: FixDraftInput): Promise<FixDraft> {
      const { system, user } = buildFixPrompt({ ticket: input.ticket, articles: input.articles });
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await request(input, system, user);
        } catch (error) {
          if (attempt >= LLM_MAX_ATTEMPTS || !isTransientLlmError(error)) throw error;
        }
      }
    },
  };
}
