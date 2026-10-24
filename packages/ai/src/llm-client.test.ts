import { HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createEgressRecorder } from "../../shared/test-support/egress-recorder.js";
import { FixParseError, buildFixPrompt } from "./fix-steps.js";
import {
  LLM_DRAFT_TIMEOUT_MS,
  LLM_HEDGE_DELAY_MS,
  LLM_MAX_REQUESTS,
  LlmError,
  LlmUnavailableError,
  createFixDrafter,
  isTransientLlmError,
} from "./llm-client.js";
import { BudgetExceededError, createMeter, type MeterRepos } from "./meter.js";
import { createAiRuntime, type TraceSpan } from "./trace.js";

const HOST = "https://llm.test.invalid";
const BASE_URL = `${HOST}/zen/go/v1`;
const MODEL = "deepseek-v4.1-flash";
const KEY_MARKER = "x".repeat(24);
const TICKET = "00000000-0000-4000-8000-000000000001";
const CALL_ID = "00000000-0000-4000-8000-0000000000aa";
const FIX = { steps: ["Restart the VPN client.", "Sign in again."], caveats: ["Needs admin."] };

const input = {
  ticketId: TICKET,
  ticket: { title: "VPN drops", description: "The VPN disconnects every hour." },
  articles: [{ slug: "vpn-reset", title: "Reset the VPN", content: "Restart the client." }],
};

function completion(content: string, usage = { prompt_tokens: 120, completion_tokens: 45 }) {
  return {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1_790_000_000,
    model: MODEL,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens },
  };
}

const egress = createEgressRecorder();
beforeAll(() => egress.start());
afterAll(() => egress.stop());
beforeEach(() => egress.reset());

type Reply = () => Response | Promise<Response>;

interface SetupOptions {
  reply?: Reply;
  appVersion?: string;
  /** Reservations allowed before the budget refuses; default unlimited. */
  allowedReservations?: number;
  /** Awaited inside the n-th reservation (from 1) before it answers. */
  reserveGate?: (n: number) => Promise<void>;
}

function setup(options: SetupOptions = {}) {
  const order: string[] = [];
  const auth: (string | null)[] = [];
  const reply = options.reply ?? (() => HttpResponse.json(completion(JSON.stringify(FIX))));
  egress.mock(HOST, ({ request }) => {
    order.push("request");
    auth.push(request.headers.get("authorization"));
    return reply();
  });
  let reservations = 0;
  const repos = {
    reserveAiCall: vi.fn(async ({ calls, capCalls }: { calls: number; capCalls: number }) => {
      order.push("reserve");
      reservations += 1;
      await options.reserveGate?.(reservations);
      const allowed =
        calls <= capCalls && reservations <= (options.allowedReservations ?? Infinity);
      return { allowed, usedCalls: calls, callId: allowed ? CALL_ID : null };
    }),
    completeAiCall: vi.fn(async () => undefined),
  } satisfies MeterRepos;
  const logs: string[] = [];
  const logger = { error: (message: string) => void logs.push(message) };
  const meter = createMeter({
    repos,
    caps: { llm: 100, typesafe: 1000 },
    environment: "e2e",
    alert: vi.fn(),
    logger,
  });
  const spans: TraceSpan[] = [];
  const runtime = createAiRuntime({
    meter,
    sink: { record: async (span) => void spans.push(span) },
    addEvent: vi.fn(async () => undefined),
    environment: "e2e",
    logger,
  });
  const drafter = createFixDrafter({
    apiKey: KEY_MARKER,
    baseUrl: BASE_URL,
    model: MODEL,
    runtime,
    appVersion: options.appVersion ?? "1.2.3",
  });
  return { drafter, order, auth, repos, spans, logs };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

function sentBody(): Record<string, unknown> {
  return JSON.parse(egress.requests()[0]?.body ?? "") as Record<string, unknown>;
}

describe("createFixDrafter", () => {
  it("posts to <base>/chat/completions with the model, bearer key, prompt and no tools", async () => {
    const { drafter, auth } = setup();
    const result = await drafter.draft(input);

    expect(result).toEqual({ ...FIX, model: MODEL, usage: { tokensIn: 120, tokensOut: 45 } });
    const requests = egress.requests();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: "POST", path: "/zen/go/v1/chat/completions" });
    expect(auth).toEqual([`Bearer ${KEY_MARKER}`]);
    const body = sentBody();
    const { system, user } = buildFixPrompt(input);
    expect(body.model).toBe(MODEL);
    expect(body.messages).toEqual([
      { role: "system", content: system },
      { role: "user", content: user },
    ]);
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
    expect(body).not.toHaveProperty("stream", true);
  });

  it("records usage tokens in the ai_calls completion and in the span", async () => {
    const { drafter, repos, spans } = setup();
    await drafter.draft(input);
    expect(repos.completeAiCall).toHaveBeenCalledWith(CALL_ID, { tokensIn: 120, tokensOut: 45 });
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      provider: "llm",
      kind: "fix_steps",
      model: MODEL,
      ticketId: TICKET,
      tokensIn: 120,
      tokensOut: 45,
    });
  });

  it("meters 1 llm call of kind fix_steps", async () => {
    const { drafter, repos } = setup();
    await drafter.draft(input);
    expect(repos.reserveAiCall).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "llm", kind: "fix_steps", calls: 1, ticketId: TICKET }),
    );
  });

  it("throws LlmUnavailableError on 429 after exactly 1 request", async () => {
    const { drafter } = setup({ reply: () => HttpResponse.json({}, { status: 429 }) });
    const error = await rejection(drafter.draft(input));
    expect(error).toBeInstanceOf(LlmUnavailableError);
    expect(egress.requests()).toHaveLength(1);
  });

  it.each([400, 401, 403])(
    "throws LlmError with status %i, never LlmUnavailableError, after exactly 1 request",
    async (status) => {
      const { drafter } = setup({ reply: () => HttpResponse.json({}, { status }) });
      const error = await rejection(drafter.draft(input));
      expect(error).toBeInstanceOf(LlmError);
      expect(error).not.toBeInstanceOf(LlmUnavailableError);
      expect(error).toMatchObject({ kind: "http", status });
      expect(egress.requests()).toHaveLength(1);
    },
  );

  it.each([500, 502, 503, 408])(
    "retries a %i, then throws LlmError with that status after exactly 3 requests",
    async (status) => {
      const { drafter, repos, spans } = setup({ reply: () => HttpResponse.json({}, { status }) });
      const error = await rejection(drafter.draft(input));
      expect(error).toBeInstanceOf(LlmError);
      expect(error).not.toBeInstanceOf(LlmUnavailableError);
      expect(error).toMatchObject({ kind: "http", status });
      expect(egress.requests()).toHaveLength(3);
      // Each request is metered and traced on its own.
      expect(repos.reserveAiCall).toHaveBeenCalledTimes(3);
      expect(spans.map((span) => span.error)).toEqual(["LlmError", "LlmError", "LlmError"]);
    },
  );

  it("throws LlmError of kind network when the connection fails 3 times, after exactly 3 requests", async () => {
    const { drafter } = setup({ reply: () => HttpResponse.error() });
    const error = await rejection(drafter.draft(input));
    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({ kind: "network", status: null });
    expect(egress.requests()).toHaveLength(3);
  });

  it("sends exactly User-Agent ai-it-support-agent/<APP_VERSION>", async () => {
    const { drafter } = setup({ appVersion: "1.2.3" });
    await drafter.draft(input);
    const userAgent = egress.requests()[0]?.headers["user-agent"];
    expect(userAgent).toBe("ai-it-support-agent/1.2.3");
    expect(userAgent).not.toMatch(/ai-sdk|ai\/|openai|node|undici|runtime/i);
  });

  it("sends ai-it-support-agent/unknown when APP_VERSION is unset", async () => {
    const { drafter } = setup({ appVersion: "" });
    await drafter.draft(input);
    expect(egress.requests()[0]?.headers["user-agent"]).toBe("ai-it-support-agent/unknown");
  });

  it("throws FixParseError when all 3 replies are not valid JSON", async () => {
    const { drafter } = setup({ reply: () => HttpResponse.json(completion("Try a restart.")) });
    const error = await rejection(drafter.draft(input));
    expect(error).toBeInstanceOf(FixParseError);
    expect(String((error as Error).message)).not.toContain("Try a restart");
    expect(egress.requests()).toHaveLength(3);
  });

  describe("with the recorded live completion envelope (P3-T10i)", () => {
    // Field set recorded from the live router on 2026-10-20; content fictional.
    function liveCompletion(content: string) {
      return {
        id: "gen-1",
        object: "chat.completion",
        created: 1_790_000_000,
        model: "deepseek/deepseek-v4.1-flash",
        provider: "ExampleHost",
        system_fingerprint: null,
        service_tier: null,
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content,
              refusal: null,
              reasoning: "REASONING-MARKER: the article says to restart the client.",
              reasoning_details: [
                { type: "reasoning.text", text: "REASONING-MARKER", format: "unknown", index: 0 },
              ],
            },
          },
        ],
        usage: {
          prompt_tokens: 570,
          completion_tokens: 249,
          total_tokens: 819,
          completion_tokens_details: { reasoning_tokens: 133 },
        },
      };
    }

    it("returns the steps from content only, never the reasoning", async () => {
      const content =
        '{"steps": ["Close the VPN client completely and open it again."], "caveats": []}';
      const { drafter } = setup({ reply: () => HttpResponse.json(liveCompletion(content)) });
      const result = await drafter.draft(input);
      expect(result).toEqual({
        steps: ["Close the VPN client completely and open it again."],
        caveats: [],
        model: "deepseek/deepseek-v4.1-flash",
        usage: { tokensIn: 570, tokensOut: 249 },
      });
      expect(JSON.stringify(result)).not.toContain("REASONING-MARKER");
    });

    it("throws FixParseError for the recorded 0-step no-article reply, after the retries", async () => {
      const content = '{"steps": [], "caveats": ["No knowledge-base articles were provided."]}';
      const { drafter } = setup({ reply: () => HttpResponse.json(liveCompletion(content)) });
      const error = await rejection(drafter.draft(input));
      expect(error).toBeInstanceOf(FixParseError);
      expect((error as Error).message).toBe("Fix-step reply rejected: unexpected shape at steps");
      expect(egress.requests()).toHaveLength(3);
    });
  });

  it("hedges after 5 s, sends 3 requests at most and ends a draft within 15 s", () => {
    expect(LLM_HEDGE_DELAY_MS).toBe(5_000);
    expect(LLM_MAX_REQUESTS).toBe(3);
    expect(LLM_DRAFT_TIMEOUT_MS).toBe(15_000);
    // The last request starts by 2 hedge delays and still has 5 s.
    expect(LLM_DRAFT_TIMEOUT_MS - (LLM_MAX_REQUESTS - 1) * LLM_HEDGE_DELAY_MS).toBe(5_000);
  });

  describe("retry inside the draft (P3-T10k)", () => {
    /** Replies with `first` to the first request and a valid fix to every later one. */
    function firstThen(first: Reply): Reply {
      let count = 0;
      return () => {
        count += 1;
        return count === 1 ? first() : HttpResponse.json(completion(JSON.stringify(FIX)));
      };
    }

    it.each<[string, Reply]>([
      ["a network error", () => HttpResponse.error()],
      ["a 500", () => HttpResponse.json({}, { status: 500 })],
      ["a 200 body the SDK cannot read", () => new HttpResponse("not json", { status: 200 })],
      ["a reply that is not valid JSON", () => HttpResponse.json(completion("Try a restart."))],
    ])("returns the second reply after %s", async (_label, first) => {
      const { drafter, order, repos, spans } = setup({ reply: firstThen(first) });
      const result = await drafter.draft(input);
      expect(result).toEqual({ ...FIX, model: MODEL, usage: { tokensIn: 120, tokensOut: 45 } });
      // A reservation before each request: the retry counts toward the cap.
      expect(order).toEqual(["reserve", "request", "reserve", "request"]);
      expect(repos.reserveAiCall).toHaveBeenCalledTimes(2);
      expect(repos.completeAiCall).toHaveBeenCalledTimes(1);
      // One span per request: the failed one carries the error class only.
      expect(spans).toHaveLength(2);
      expect(spans[0]).toMatchObject({ kind: "fix_steps", tokensIn: null, tokensOut: null });
      expect(spans[0]?.error).toMatch(/^(LlmError|FixParseError)$/);
      expect(spans[1]).toMatchObject({ kind: "fix_steps", tokensIn: 120, tokensOut: 45 });
      expect(spans[1]?.error).toBeUndefined();
      // The retry sends the same request again.
      const bodies = egress.requests().map((request) => request.body);
      expect(bodies).toHaveLength(2);
      expect(bodies[1]).toBe(bodies[0]);
    });

    it("throws LlmUnavailableError when the retry gets a 429, after 2 requests", async () => {
      let count = 0;
      const { drafter } = setup({
        reply: () => {
          count += 1;
          return HttpResponse.json({}, { status: count === 1 ? 500 : 429 });
        },
      });
      const error = await rejection(drafter.draft(input));
      expect(error).toBeInstanceOf(LlmUnavailableError);
      expect(egress.requests()).toHaveLength(2);
    });

    it("never retries a 429: exactly 1 reservation and 1 request", async () => {
      const { drafter, repos } = setup({ reply: () => HttpResponse.json({}, { status: 429 }) });
      await rejection(drafter.draft(input));
      expect(repos.reserveAiCall).toHaveBeenCalledTimes(1);
      expect(egress.requests()).toHaveLength(1);
    });

    it("throws BudgetExceededError, and sends no second request, when the cap refuses the retry", async () => {
      const { drafter, order } = setup({
        allowedReservations: 1,
        reply: () => HttpResponse.json({}, { status: 500 }),
      });
      const error = await rejection(drafter.draft(input));
      expect(error).toBeInstanceOf(BudgetExceededError);
      expect(order).toEqual(["reserve", "request", "reserve"]);
      expect(egress.requests()).toHaveLength(1);
    });
  });

  it("reserves the budget before the HTTP request", async () => {
    const { drafter, order } = setup();
    await drafter.draft(input);
    expect(order).toEqual(["reserve", "request"]);
  });

  it("throws BudgetExceededError with capOverride 0 and sends no request", async () => {
    const { drafter, order } = setup();
    const error = await rejection(drafter.draft({ ...input, capOverride: 0 }));
    expect(error).toBeInstanceOf(BudgetExceededError);
    expect(order).toEqual(["reserve"]);
    expect(egress.requests()).toHaveLength(0);
  });

  it.each<[string, Reply]>([
    ["200", () => HttpResponse.json(completion(JSON.stringify(FIX)))],
    ["429", () => HttpResponse.json({ error: KEY_MARKER }, { status: 429 })],
    ["401", () => HttpResponse.json({ error: KEY_MARKER }, { status: 401 })],
    ["500", () => HttpResponse.json({ error: KEY_MARKER }, { status: 500 })],
    ["bad JSON", () => HttpResponse.json(completion(`not json ${KEY_MARKER}`))],
  ])("never puts the API key into a log line, error or span (%s)", async (_label, reply) => {
    const { drafter, spans, logs } = setup({ reply });
    const error = await drafter.draft(input).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    const seen = [
      ...logs,
      JSON.stringify(spans),
      error instanceof Error ? `${error.message} ${error.stack ?? ""}` : "",
      JSON.stringify(error ?? null),
    ].join("\n");
    // The 200 and the 4xx are not retried; the 500 and the bad JSON are, up to 3 requests.
    expect(spans).toHaveLength(["500", "bad JSON"].includes(_label) ? 3 : 1);
    expect(seen).not.toContain(KEY_MARKER);
  });
});

describe("hedged requests (P3-T10l)", () => {
  /** One fetch the drafter made; it settles only when the test says so. */
  interface Call {
    body: string;
    signal: AbortSignal;
    answer(response: Response): void;
  }

  let calls: Call[];
  let unhandled: unknown[];
  const onUnhandled = (reason: unknown) => void unhandled.push(reason);

  // Fake timers drive the hedge delay and the draft limit; the fake fetch
  // rejects with the abort reason, as the real fetch does.
  beforeEach(() => {
    vi.useFakeTimers();
    calls = [];
    unhandled = [];
    process.on("unhandledRejection", onUnhandled);
    vi.stubGlobal("fetch", (_url: unknown, init: RequestInit) => {
      const signal = init.signal as AbortSignal;
      return new Promise<Response>((resolve, reject) => {
        calls.push({ body: String(init.body), signal, answer: resolve });
        signal.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
      });
    });
  });

  afterEach(async () => {
    // Let any stray rejection surface before the check.
    await vi.advanceTimersByTimeAsync(0);
    process.off("unhandledRejection", onUnhandled);
    vi.unstubAllGlobals();
    vi.useRealTimers();
    expect(unhandled).toEqual([]);
  });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const valid = () => json(completion(JSON.stringify(FIX)));
  const RESULT = { ...FIX, model: MODEL, usage: { tokensIn: 120, tokensOut: 45 } };

  /** Starts a draft; `state()` reports whether it is still pending. */
  function start(drafter: ReturnType<typeof setup>["drafter"]) {
    let state: "pending" | "resolved" | "rejected" = "pending";
    const promise = drafter.draft(input);
    promise.then(
      () => (state = "resolved"),
      () => (state = "rejected"),
    );
    return { promise, state: () => state };
  }

  /** Moves the clock to `ms` after the draft started. */
  let now = 0;
  beforeEach(() => void (now = 0));
  async function at(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms - now);
    now = ms;
  }

  it("sends no hedge when the first request answers in time", async () => {
    const { drafter, repos, spans } = setup();
    const draft = start(drafter);
    await at(2_000);
    expect(calls).toHaveLength(1);
    calls[0]!.answer(valid());
    await expect(draft.promise).resolves.toEqual(RESULT);
    expect(vi.getTimerCount()).toBe(0);
    await at(30_000);
    expect(calls).toHaveLength(1);
    expect(repos.reserveAiCall).toHaveBeenCalledTimes(1);
    expect(spans).toHaveLength(1);
    expect(calls[0]!.signal.aborted).toBe(false);
  });

  it("hedges a stalled first request after 5 s, returns the hedge and aborts the first", async () => {
    const { drafter, repos, spans } = setup();
    const draft = start(drafter);
    await at(LLM_HEDGE_DELAY_MS - 1);
    expect(calls).toHaveLength(1);
    await at(LLM_HEDGE_DELAY_MS);
    expect(calls).toHaveLength(2);
    // The hedge is the same request.
    expect(calls[1]!.body).toBe(calls[0]!.body);
    await at(6_500);
    calls[1]!.answer(valid());
    await expect(draft.promise).resolves.toEqual(RESULT);
    expect(calls[0]!.signal.aborted).toBe(true);
    expect(calls[1]!.signal.aborted).toBe(false);
    // Both requests are metered and traced exactly once.
    expect(repos.reserveAiCall).toHaveBeenCalledTimes(2);
    expect(repos.completeAiCall).toHaveBeenCalledTimes(1);
    expect(spans).toHaveLength(2);
    const cancelled = spans.find((span) => span.error !== undefined);
    expect(cancelled).toMatchObject({
      error: "LlmCancelledError",
      kind: "fix_steps",
      tokensIn: null,
      tokensOut: null,
    });
    expect(spans.find((span) => span.error === undefined)).toMatchObject({
      tokensIn: 120,
      tokensOut: 45,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries a transient failure at once, without waiting for the hedge delay", async () => {
    const { drafter } = setup();
    const draft = start(drafter);
    await at(1_000);
    calls[0]!.answer(json({}, 503));
    await at(1_001);
    expect(calls).toHaveLength(2);
    calls[1]!.answer(valid());
    await expect(draft.promise).resolves.toEqual(RESULT);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns the first valid reply when both arrive together; both count as completed calls", async () => {
    const { drafter, repos, spans } = setup();
    const draft = start(drafter);
    await at(LLM_HEDGE_DELAY_MS);
    const hedgeFix = { steps: ["Reinstall the VPN client."], caveats: [] };
    calls[1]!.answer(json(completion(JSON.stringify(hedgeFix))));
    calls[0]!.answer(valid());
    await expect(draft.promise).resolves.toEqual({ ...RESULT, ...hedgeFix });
    expect(repos.completeAiCall).toHaveBeenCalledTimes(2);
    expect(spans.map((span) => span.error)).toEqual([undefined, undefined]);
  });

  it("keeps waiting for the hedge when the first fails transiently, with no third request", async () => {
    const { drafter } = setup();
    const draft = start(drafter);
    await at(LLM_HEDGE_DELAY_MS);
    expect(calls).toHaveLength(2);
    await at(6_000);
    calls[0]!.answer(json({}, 500));
    await at(7_000);
    expect(calls).toHaveLength(2);
    calls[1]!.answer(valid());
    await expect(draft.promise).resolves.toEqual(RESULT);
    expect(calls).toHaveLength(2);
  });

  it("starts a third request at once when the hedge fails and the first is still stalled", async () => {
    const { drafter, spans } = setup();
    const draft = start(drafter);
    await at(LLM_HEDGE_DELAY_MS);
    await at(5_500);
    calls[1]!.answer(json({}, 502));
    await at(5_501);
    expect(calls).toHaveLength(3);
    calls[2]!.answer(valid());
    await expect(draft.promise).resolves.toEqual(RESULT);
    expect(calls[0]!.signal.aborted).toBe(true);
    expect(spans.map((span) => span.error ?? "ok").sort()).toEqual([
      "LlmCancelledError",
      "LlmError",
      "ok",
    ]);
  });

  it("hedges every 5 s up to 3 requests, then fails with a timeout at 15 s", async () => {
    const { drafter, repos, spans } = setup();
    const draft = start(drafter);
    const failure = rejection(draft.promise);
    await at(LLM_HEDGE_DELAY_MS);
    expect(calls).toHaveLength(2);
    await at(2 * LLM_HEDGE_DELAY_MS);
    expect(calls).toHaveLength(3);
    await at(LLM_DRAFT_TIMEOUT_MS - 1);
    expect(calls).toHaveLength(3);
    expect(draft.state()).toBe("pending");
    await at(LLM_DRAFT_TIMEOUT_MS);
    const error = await failure;
    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({ kind: "timeout", status: null });
    expect(calls.every((call) => call.signal.aborted)).toBe(true);
    expect(repos.reserveAiCall).toHaveBeenCalledTimes(3);
    expect(spans.map((span) => span.error)).toEqual(["LlmError", "LlmError", "LlmError"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never hedges a 429: 1 request, LlmUnavailableError", async () => {
    const { drafter, repos } = setup();
    const draft = start(drafter);
    const failure = rejection(draft.promise);
    await at(1_000);
    calls[0]!.answer(json({}, 429));
    expect(await failure).toBeInstanceOf(LlmUnavailableError);
    await at(30_000);
    expect(calls).toHaveLength(1);
    expect(repos.reserveAiCall).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts no new request after a 429 and throws it when the open hedge fails", async () => {
    const { drafter } = setup();
    const draft = start(drafter);
    const failure = rejection(draft.promise);
    await at(LLM_HEDGE_DELAY_MS);
    await at(6_000);
    calls[0]!.answer(json({}, 429));
    // The hedge is younger than the hedge delay at 6 s, older at 11 s.
    await at(11_000);
    expect(calls).toHaveLength(2);
    calls[1]!.answer(json({}, 500));
    expect(await failure).toBeInstanceOf(LlmUnavailableError);
    expect(calls).toHaveLength(2);
  });

  it("keeps waiting on the first when the budget refuses the hedge", async () => {
    const { drafter, order, repos, spans } = setup({ allowedReservations: 1 });
    const draft = start(drafter);
    await at(LLM_HEDGE_DELAY_MS);
    expect(order).toEqual(["reserve", "reserve"]);
    expect(calls).toHaveLength(1);
    await at(7_000);
    calls[0]!.answer(valid());
    await expect(draft.promise).resolves.toEqual(RESULT);
    expect(calls).toHaveLength(1);
    expect(repos.reserveAiCall).toHaveBeenCalledTimes(2);
    // A refused reservation runs nothing and records no span.
    expect(spans).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("throws BudgetExceededError when the budget refused the hedge and the first fails", async () => {
    const { drafter } = setup({ allowedReservations: 1 });
    const draft = start(drafter);
    const failure = rejection(draft.promise);
    await at(7_000);
    calls[0]!.answer(json({}, 500));
    expect(await failure).toBeInstanceOf(BudgetExceededError);
    await at(30_000);
    expect(calls).toHaveLength(1);
  });

  it("cancels a hedge still reserving its budget: no request, one LlmCancelledError span", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { drafter, repos, spans } = setup({
      reserveGate: (n) => (n === 2 ? gate : Promise.resolve()),
    });
    const draft = start(drafter);
    await at(LLM_HEDGE_DELAY_MS);
    expect(repos.reserveAiCall).toHaveBeenCalledTimes(2);
    await at(6_000);
    calls[0]!.answer(valid());
    await at(6_001);
    // The draft waits for the hedge, so its span is exported before it returns.
    expect(draft.state()).toBe("pending");
    release();
    await expect(draft.promise).resolves.toEqual(RESULT);
    expect(calls).toHaveLength(1);
    expect(spans.map((span) => span.error ?? "ok").sort()).toEqual(["LlmCancelledError", "ok"]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("isTransientLlmError", () => {
  it.each<[string, unknown]>([
    ["a timeout", new LlmError("timeout")],
    ["a network error", new LlmError("network")],
    ["an HTTP 500", new LlmError("http", 500)],
    ["an HTTP 503", new LlmError("http", 503)],
    ["an HTTP 408", new LlmError("http", 408)],
    ["an unreadable 200 body", new LlmError("http", 200)],
    ["an HTTP error with no status", new LlmError("http")],
    ["a reply that fails parseFixSteps", new FixParseError("not valid JSON")],
  ])("is true for %s", (_label, error) => {
    expect(isTransientLlmError(error)).toBe(true);
  });

  it.each<[string, unknown]>([
    ["a 429", new LlmUnavailableError()],
    ["an HTTP 400", new LlmError("http", 400)],
    ["an HTTP 401", new LlmError("http", 401)],
    ["an HTTP 403", new LlmError("http", 403)],
    ["an HTTP 404", new LlmError("http", 404)],
    ["an HTTP 499", new LlmError("http", 499)],
    ["a refused budget", new BudgetExceededError("llm")],
    ["a plain Error", new Error("boom")],
    ["a non-Error value", "boom"],
  ])("is false for %s", (_label, error) => {
    expect(isTransientLlmError(error)).toBe(false);
  });
});
