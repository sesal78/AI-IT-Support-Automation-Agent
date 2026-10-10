import { afterEach, describe, expect, it, vi } from "vitest";
import { BudgetExceededError } from "./meter.js";
import { SENSITIVE_TOPICS } from "./sensitive.js";
import type { AiCallMeta, createAiRuntime } from "./trace.js";
import { SENSITIVE_CHECK_CALLS, createTypeSafeChecker } from "./typesafe-checker.js";
import { TYPESAFE_MODEL } from "./typesafe-model.js";

const FAKE_KEY = "test-typesafe-key";

/** A runtime that runs `fn` directly and records each call's meta. */
function passthroughRuntime() {
  const metas: AiCallMeta[] = [];
  const runtime: Pick<ReturnType<typeof createAiRuntime>, "call"> = {
    call: async (meta, fn) => {
      metas.push(meta);
      return fn();
    },
  };
  return { runtime, call: vi.spyOn(runtime, "call"), metas };
}

function checkerFor(fake: ReturnType<typeof passthroughRuntime> = passthroughRuntime()) {
  return createTypeSafeChecker({ apiKey: FAKE_KEY, runtime: fake.runtime });
}

function nouls(values: Record<string, number>) {
  return Object.fromEntries(Object.entries(values).map(([k, noul]) => [k, { type: "noul", noul }]));
}

const allScores = Object.fromEntries(SENSITIVE_TOPICS.map((t) => [t, 0.1]));

interface Captured {
  url: string;
  headers: Headers;
  body: {
    state: unknown;
    model?: string;
    questions: Record<string, { type: string; instructions: unknown; criteria?: unknown }>;
  };
}

/** Stubs global fetch (used by the TypeSafe SDK) with one JSON response. */
function stubFetch(status: number, body: unknown): Captured[] {
  const captured: Captured[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      captured.push({
        url: String(input instanceof Request ? input.url : input),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      });
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return captured;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createTypeSafeChecker", () => {
  it("sends one Noul per topic with the redacted ticket as JSON state", async () => {
    const captured = stubFetch(200, {
      model: "jev-1.13.0",
      answers: nouls({ ...allScores, security_incident: 0.8 }),
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const checker = checkerFor();

    const result = await checker.check({ title: "Odd email", description: "[REDACTED_EMAIL]" });

    expect(result).toEqual({
      scores: { ...allScores, security_incident: 0.8 },
      checker: "typesafe:jev-1.13.0",
    });
    expect(captured).toHaveLength(1);
    const [request] = captured;
    expect(request!.url).toMatch(/\/v1\/systemone$/);
    expect(request!.headers.get("authorization") ?? "").toContain(FAKE_KEY);
    expect(request!.body.state).toEqual({
      ticket: { title: "Odd email", description: "[REDACTED_EMAIL]" },
    });
    expect(Object.keys(request!.body.questions).sort()).toEqual([...SENSITIVE_TOPICS].sort());
    for (const question of Object.values(request!.body.questions)) {
      expect(question.type).toBe("noul");
      expect(typeof question.instructions).toBe("string");
      expect(question.instructions).toContain("`ticket`");
    }
  });

  it("throws when an answer is missing", async () => {
    const rest: Record<string, number> = { ...allScores };
    delete rest.legal;
    stubFetch(200, { model: "jev-1", answers: nouls(rest), usage: {} });
    const checker = checkerFor();
    await expect(checker.check({ title: "t", description: "d" })).rejects.toThrow(/legal/);
  });

  it("throws when a probability is out of range", async () => {
    stubFetch(200, { model: "jev-1", answers: nouls({ ...allScores, hr: 1.5 }), usage: {} });
    const checker = checkerFor();
    await expect(checker.check({ title: "t", description: "d" })).rejects.toThrow(/hr/);
  });

  it("does not echo ticket text in a shape error", async () => {
    stubFetch(200, { model: "jev-1", answers: nouls({ ...allScores, hr: -1 }), usage: {} });
    const checker = checkerFor();
    const error = await checker.check({ title: "t", description: "secret words" }).catch((e) => e);
    expect(String(error)).not.toContain("secret words");
  });

  it("propagates an API error", async () => {
    stubFetch(400, { detail: "bad request" });
    const checker = checkerFor();
    await expect(checker.check({ title: "t", description: "d" })).rejects.toThrow();
  });

  it("rejects an empty API key", () => {
    expect(() =>
      createTypeSafeChecker({ apiKey: "", runtime: passthroughRuntime().runtime }),
    ).toThrow(/apiKey/);
  });

  it("runs one metered call: typesafe, sensitive_check, 5 calls, the ticket ID and the sent request", async () => {
    const captured = stubFetch(200, {
      model: "jev-1.13.0",
      answers: nouls(allScores),
      usage: { input_tokens: 42, output_tokens: 7 },
    });
    const runtime = passthroughRuntime();
    const checker = checkerFor(runtime);

    await checker.check({ title: "t", description: "[REDACTED_PHONE]", ticketId: "ticket-1" });

    expect(SENSITIVE_CHECK_CALLS).toBe(5);
    expect(runtime.call).toHaveBeenCalledTimes(1);
    const meta = runtime.metas[0]!;
    expect(meta).toMatchObject({
      provider: "typesafe",
      kind: "sensitive_check",
      calls: 5,
      ticketId: "ticket-1",
      model: TYPESAFE_MODEL,
    });
    // The span input is exactly what was sent: the redacted ticket and the questions.
    expect(JSON.parse(JSON.stringify(meta.input))).toEqual(captured[0]!.body);
    expect(captured[0]!.body.model).toBe(TYPESAFE_MODEL);
    expect(captured[0]!.body.state).toEqual({
      ticket: { title: "t", description: "[REDACTED_PHONE]" },
    });
    const result = await runtime.call.mock.results[0]!.value;
    expect(result).toMatchObject({ tokensIn: 42, tokensOut: 7 });
  });

  it("sends no request when the runtime refuses the budget", async () => {
    const captured = stubFetch(200, { model: "jev-1", answers: nouls(allScores), usage: {} });
    const checker = createTypeSafeChecker({
      apiKey: FAKE_KEY,
      runtime: {
        call: async () => {
          throw new BudgetExceededError("typesafe");
        },
      },
    });

    await expect(checker.check({ title: "t", description: "d" })).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
    expect(captured).toHaveLength(0);
  });

  it("throws, naming usage, when the token usage is missing", async () => {
    stubFetch(200, { model: "jev-1", answers: nouls(allScores) });
    await expect(checkerFor().check({ title: "t", description: "d" })).rejects.toThrow(/usage/);
  });
});
