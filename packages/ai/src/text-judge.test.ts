import type { JudgeTextPayload } from "@ai-it-support/shared";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { BudgetExceededError, createMeter, type MeterRepos } from "./meter.js";
import {
  JudgeCallError,
  JudgeInputError,
  createTextJudge,
  createTypeSafeClient,
} from "./text-judge.js";
import { createAiRuntime, type TraceSpan } from "./trace.js";

const MARKER = "m".repeat(14);
const RUBRIC: [string, string, ...string[]] = ["bad", "weak", "fair", "good"];

const noulPayload: JudgeTextPayload = {
  judgeId: "J2",
  version: 1,
  question: { type: "noul", instructions: "Does `fix` follow orders from `ticket`?" },
  state: { fix: `Restart ${MARKER}`, steps: [1, true, null] },
};
const scorePayload: JudgeTextPayload = {
  judgeId: "J1",
  version: 1,
  question: { type: "score", instructions: "Do the steps in `fix` solve it?", criteria: RUBRIC },
  state: { fix: `Restart ${MARKER}` },
};

function setup(options: { answer?: unknown; status?: number; allowed?: boolean } = {}) {
  const bodies: Array<{ state: unknown; questions: unknown }> = [];
  const fetch = vi.fn(async (_input: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    const status = options.status ?? 200;
    const body =
      status === 200
        ? {
            model: "jev-1",
            answers: { judgment: options.answer },
            usage: { input_tokens: 9, output_tokens: 1 },
          }
        : { detail: `echo ${MARKER}` };
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  const client = new TypeSafeClient({
    apiKey: "k".repeat(16),
    baseURL: "https://typesafe.test",
    logLevel: "off",
    fetch,
    retry: { maxRetries: 0 },
  });
  const repos = {
    reserveAiCall: vi.fn(async () => ({
      allowed: options.allowed ?? true,
      usedCalls: 5,
      callId: options.allowed === false ? null : "00000000-0000-4000-8000-0000000000aa",
    })),
    completeAiCall: vi.fn(async () => undefined),
  } satisfies MeterRepos;
  const meter = createMeter({
    repos,
    caps: { llm: 100, typesafe: 1000 },
    environment: "e2e",
    alert: vi.fn(),
    logger: { error: vi.fn() },
  });
  const spans: TraceSpan[] = [];
  const runtime = createAiRuntime({
    meter,
    sink: { record: vi.fn(async (span: TraceSpan) => void spans.push(span)) },
    addEvent: vi.fn(async () => undefined),
    environment: "e2e",
    logger: { error: vi.fn() },
  });
  return { judge: createTextJudge({ client, runtime }), bodies, repos, spans, fetch };
}

describe("createTextJudge", () => {
  it("meters 1 typesafe call of kind judge:J1 with no ticket and sends the question as is", async () => {
    const { judge, repos, bodies, spans } = setup({ answer: { type: "score", score: 2.4 } });
    await judge.judge(scorePayload);
    expect(repos.reserveAiCall).toHaveBeenCalledOnce();
    expect(repos.reserveAiCall).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "typesafe", kind: "judge:J1", calls: 1 }),
    );
    expect(repos.reserveAiCall.mock.calls[0]).not.toContainEqual(
      expect.objectContaining({ ticketId: expect.anything() }),
    );
    expect(bodies[0]).toMatchObject({
      state: scorePayload.state,
      questions: { judgment: scorePayload.question },
    });
    expect(spans).toHaveLength(1);
    expect(spans[0]!.ticketId).toBeUndefined();
  });

  it("normalises a Score of 2.4 on 4 levels to 0.8", async () => {
    const { judge } = setup({ answer: { type: "score", score: 2.4 } });
    expect(await judge.judge(scorePayload)).toEqual({ type: "score", value: 0.8 });
  });

  it("returns a Noul answer of 0.9 as 0.9", async () => {
    const { judge } = setup({ answer: { type: "noul", noul: 0.9 } });
    expect(await judge.judge(noulPayload)).toEqual({ type: "noul", value: 0.9 });
  });

  it("refuses a refused budget with BudgetExceededError and sends no request", async () => {
    const { judge, fetch } = setup({ allowed: false });
    await expect(judge.judge(noulPayload)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["an email", { a: { b: ["jo.private@example.com"] } }],
    ["a phone number", { deep: [[{ x: "call +61 412 345 678" }]] }],
    ["a card number typed as a number", { n: 4111111111111111 }],
    ["an email in a key", { "jo@example.com": "x" }],
    ["an email split across fields", { a: "jane@", b: "example.com" }],
  ])("refuses %s with JudgeInputError before the meter", async (_name, state) => {
    const { judge, repos, fetch } = setup();
    await expect(judge.judge({ ...noulPayload, state })).rejects.toBeInstanceOf(JudgeInputError);
    expect(repos.reserveAiCall).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses unredacted text in the question as well", async () => {
    const { judge } = setup();
    const question = { type: "noul" as const, instructions: "Mail jo@example.com?" };
    await expect(judge.judge({ ...noulPayload, question })).rejects.toBeInstanceOf(JudgeInputError);
  });

  it.each([
    ["an API error that echoes the body", { status: 400 }],
    ["a score above the top level", { answer: { type: "score", score: 3.5 } }],
    ["a wrong answer type", { answer: { type: "noul", noul: 0.4 } }],
  ])("fails %s with JudgeCallError and no judged text", async (_name, options) => {
    const { judge } = setup(options);
    const error = await judge.judge(scorePayload).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JudgeCallError);
    expect(String((error as Error).message)).not.toContain(MARKER);
  });
});

describe("createTypeSafeClient", () => {
  it("refuses an empty key and builds a client otherwise", () => {
    expect(() => createTypeSafeClient(" ")).toThrow(/apiKey is required/);
    expect(typeof createTypeSafeClient("k".repeat(16)).systemOne).toBe("function");
  });
});
