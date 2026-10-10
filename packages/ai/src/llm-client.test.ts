import { delay, HttpResponse } from "msw";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createEgressRecorder } from "../../shared/test-support/egress-recorder.js";
import { FixParseError, buildFixPrompt } from "./fix-steps.js";
import { LlmError, LlmUnavailableError, createFixDrafter } from "./llm-client.js";
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

function setup(options: { reply?: Reply; timeoutMs?: number; appVersion?: string } = {}) {
  const order: string[] = [];
  const auth: (string | null)[] = [];
  const reply = options.reply ?? (() => HttpResponse.json(completion(JSON.stringify(FIX))));
  egress.mock(HOST, ({ request }) => {
    order.push("request");
    auth.push(request.headers.get("authorization"));
    return reply();
  });
  const repos = {
    reserveAiCall: vi.fn(async ({ calls, capCalls }: { calls: number; capCalls: number }) => {
      order.push("reserve");
      const allowed = calls <= capCalls;
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
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
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

  it.each([400, 401, 403, 500])(
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

  it("throws LlmError of kind network when the connection fails, after exactly 1 request", async () => {
    const { drafter } = setup({ reply: () => HttpResponse.error() });
    const error = await rejection(drafter.draft(input));
    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({ kind: "network", status: null });
    expect(egress.requests()).toHaveLength(1);
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

  it("throws FixParseError on a reply that is not valid JSON", async () => {
    const { drafter } = setup({ reply: () => HttpResponse.json(completion("Try a restart.")) });
    const error = await rejection(drafter.draft(input));
    expect(error).toBeInstanceOf(FixParseError);
    expect(String((error as Error).message)).not.toContain("Try a restart");
  });

  it("throws LlmError of kind timeout when no answer arrives in time", async () => {
    const { drafter } = setup({
      timeoutMs: 50,
      reply: async () => {
        await delay(1000);
        return HttpResponse.json(completion(JSON.stringify(FIX)));
      },
    });
    const error = await rejection(drafter.draft(input));
    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({ kind: "timeout", status: null });
    expect(egress.requests()).toHaveLength(1);
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
    expect(spans).toHaveLength(1);
    expect(seen).not.toContain(KEY_MARKER);
  });
});
