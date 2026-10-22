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
 * Time a request may go unanswered before `draft` sends the same request
 * again (a hedge). A normal fix-step reply takes 2 to 3 s (P3-T10l).
 */
export const LLM_HEDGE_DELAY_MS = 4_000;
/**
 * Whole-draft limit: every request still open then is aborted as a timeout.
 * The last request starts at most 2 hedge delays (8 s) in, so it still has
 * 7 s, more than twice a normal reply.
 */
export const LLM_DRAFT_TIMEOUT_MS = 15_000;
/** Requests per draft at most: the first, plus two hedges or retries. */
export const LLM_MAX_REQUESTS = 3;
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

/**
 * A request `draft` aborted because another one already gave a valid reply.
 * It never leaves `draft`; its span carries this class name (level ERROR).
 */
export class LlmCancelledError extends Error {
  constructor() {
    super("LLM request cancelled: another request answered");
    this.name = "LlmCancelledError";
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

/**
 * Maps a generateText failure that is not `draft`'s own abort (`abortedError`)
 * to LlmUnavailableError or LlmError; drops the original.
 */
function toLlmError(error: unknown): Error {
  const last = RetryError.isInstance(error) ? error.lastError : error;
  if (APICallError.isInstance(last)) {
    if (last.statusCode === 429) return new LlmUnavailableError();
    if (last.statusCode !== undefined) return new LlmError("http", last.statusCode);
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

/** Abort reasons `draft` gives its own requests. */
const TIMED_OUT = Symbol("timed out");
const CANCELLED = Symbol("cancelled");

/** The failure of a request `draft` aborted, from the abort reason. */
function abortedError(signal: AbortSignal): Error {
  return signal.reason === CANCELLED ? new LlmCancelledError() : new LlmError("timeout");
}

/**
 * Sends hedged requests and settles with the first valid reply.
 *
 * `send(signal, onValid)` makes one metered, traced request; it calls
 * `onValid` with the reply the moment the reply passes the parse, before its
 * span is exported, so the others are aborted at once.
 *
 * - A new request starts when no open request is younger than
 *   `LLM_HEDGE_DELAY_MS`: after 4 s without an answer (the hedge), or at once
 *   when the only young request failed transiently. At most
 *   `LLM_MAX_REQUESTS` start, so the last one starts within 8 s.
 * - A failure never cancels another request. After a failure that is not
 *   transient (a 429, another 4xx, a refused budget, any other error) no new
 *   request starts; the open ones are still awaited.
 * - At `LLM_DRAFT_TIMEOUT_MS` every open request is aborted (`LlmError`
 *   timeout).
 * - It settles only when every request has settled, so each span is exported
 *   before `draft` returns and no timer is left. With no valid reply it
 *   rejects with the first failure that is not transient, else the last one.
 */
function hedge(
  send: (signal: AbortSignal, onValid: (draft: FixDraft) => void) => Promise<unknown>,
): Promise<FixDraft> {
  return new Promise((resolve, reject) => {
    const requests: { controller: AbortController; young: boolean; open: boolean }[] = [];
    const timers: ReturnType<typeof setTimeout>[] = [];
    let winner: FixDraft | undefined;
    let stop: { error: unknown } | undefined;
    let lastError: unknown;

    function next(): void {
      if (winner !== undefined || stop !== undefined) return;
      if (requests.length >= LLM_MAX_REQUESTS) return;
      if (requests.some((request) => request.open && request.young)) return;
      const request = { controller: new AbortController(), young: true, open: true };
      requests.push(request);
      timers.push(
        setTimeout(() => {
          request.young = false;
          next();
        }, LLM_HEDGE_DELAY_MS),
      );
      const onValid = (draft: FixDraft) => {
        if (winner !== undefined) return;
        winner = draft;
        for (const other of requests) if (other !== request) other.controller.abort(CANCELLED);
      };
      send(request.controller.signal, onValid).then(
        () => {
          request.open = false;
          settle();
        },
        (error: unknown) => {
          request.open = false;
          lastError = error;
          if (!isTransientLlmError(error)) stop ??= { error };
          next();
          settle();
        },
      );
    }

    function settle(): void {
      if (requests.some((request) => request.open)) return;
      for (const timer of timers) clearTimeout(timer);
      if (winner !== undefined) resolve(winner);
      else reject(stop === undefined ? lastError : stop.error);
    }

    timers.push(
      setTimeout(() => {
        for (const request of requests) request.controller.abort(TIMED_OUT);
      }, LLM_DRAFT_TIMEOUT_MS),
    );
    next();
  });
}

/**
 * Fix-step drafts from an OpenAI-compatible chat model (OpenCode Go). Plain
 * text, no tools, SDK retries off. Every request has its own `runtime.call`
 * (provider `llm`, kind `fix_steps`), so the budget is reserved before every
 * request, a hedge included, and every request counts toward the cap and
 * gets exactly one span; a request aborted because another answered gets an
 * `LlmCancelledError` span. A request unanswered after `LLM_HEDGE_DELAY_MS`
 * is hedged, and a transient failure (`isTransientLlmError`) is retried,
 * within `LLM_MAX_REQUESTS` requests and `LLM_DRAFT_TIMEOUT_MS` (see
 * `hedge`), so one stalled or broken reply does not fail the triage run. A
 * 429 (`LlmUnavailableError`), another 4xx and a refused budget
 * (`BudgetExceededError`) start no new request. The reply must pass
 * `parseFixSteps`; there is no repair.
 */
export function createFixDrafter(deps: FixDrafterDeps) {
  const { apiKey, baseUrl, model, runtime } = deps;
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
  async function request(
    input: FixDraftInput,
    system: string,
    user: string,
    signal: AbortSignal,
    onValid: (draft: FixDraft) => void,
  ): Promise<void> {
    await runtime.call(
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
        // Aborted while the budget was being reserved: no HTTP request.
        if (signal.aborted) throw abortedError(signal);
        let result: Awaited<ReturnType<typeof generateText>>;
        try {
          result = await generateText({
            model: chatModel,
            system,
            prompt: user,
            maxRetries: 0,
            abortSignal: signal,
          });
        } catch (error) {
          throw signal.aborted ? abortedError(signal) : toLlmError(error);
        }
        const fix = parseFixSteps(result.text);
        const usage = {
          tokensIn: result.usage.inputTokens ?? 0,
          tokensOut: result.usage.outputTokens ?? 0,
        };
        const output: FixDraft = {
          steps: fix.steps,
          caveats: fix.caveats,
          model: result.response.modelId,
          usage,
        };
        onValid(output);
        return { ...usage, output };
      },
    );
  }

  return {
    async draft(input: FixDraftInput): Promise<FixDraft> {
      const { system, user } = buildFixPrompt({ ticket: input.ticket, articles: input.articles });
      return hedge((signal, onValid) => request(input, system, user, signal, onValid));
    },
  };
}
