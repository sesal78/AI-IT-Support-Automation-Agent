import { BudgetExceededError, JudgeInputError, createTextJudge } from "@ai-it-support/ai";
import type { JudgeTextPayload } from "@ai-it-support/shared";
import { describe, expect, it, vi } from "vitest";
import { createJudgeTextDeps, judgeText, runJudgeText } from "./judge-text.js";

const payload: JudgeTextPayload = {
  judgeId: "J1",
  version: 1,
  question: {
    type: "score",
    instructions: "Do the `fix` steps work?",
    criteria: ["no", "partly", "mostly", "yes"],
  },
  state: { fix: "Restart the router" },
};

function harness(options: { allowed?: boolean; score?: number } = {}) {
  const systemOne = vi.fn(async () => ({
    model: "jev-1",
    answers: { judgment: { type: "score", score: options.score ?? 2.4 } },
    usage: { input_tokens: 5, output_tokens: 1 },
  }));
  const meta: unknown[] = [];
  const runtime = {
    call: vi.fn(async (m: { provider: string }, fn: () => Promise<{ output: unknown }>) => {
      meta.push(m);
      if (options.allowed === false) throw new BudgetExceededError("typesafe");
      return fn();
    }),
  };
  const judge = createTextJudge({ client: { systemOne } as never, runtime: runtime as never });
  return { deps: { judge }, systemOne, meta, runtime };
}

describe("runJudgeText", () => {
  it("returns the normalised value through 1 typesafe call of kind judge:J1", async () => {
    const { deps, meta } = harness();
    expect(await runJudgeText(payload, deps)).toEqual({ type: "score", value: 0.8 });
    expect(meta).toEqual([
      expect.objectContaining({ provider: "typesafe", kind: "judge:J1", calls: 1 }),
    ]);
    expect(meta[0]).not.toHaveProperty("ticketId");
  });

  it.each([
    ["an email", { a: [{ b: "jo.private@example.com" }] }],
    ["a phone number", { a: "call +61 491 570 156" }],
  ])("refuses a state with %s with JudgeInputError and sends nothing", async (_n, state) => {
    const { deps, systemOne, runtime } = harness();
    await expect(runJudgeText({ ...payload, state }, deps)).rejects.toBeInstanceOf(JudgeInputError);
    expect(runtime.call).not.toHaveBeenCalled();
    expect(systemOne).not.toHaveBeenCalled();
  });

  it("fails with BudgetExceededError and sends no request when the budget refuses", async () => {
    const { deps, systemOne } = harness({ allowed: false });
    await expect(runJudgeText(payload, deps)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(systemOne).not.toHaveBeenCalled();
  });
});

describe("judgeText task", () => {
  it("is registered as judge-text", () => {
    expect(judgeText.id).toBe("judge-text");
  });

  it("names a missing TYPESAFE_API_KEY when building deps", () => {
    expect(() =>
      createJudgeTextDeps({
        SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "x".repeat(20),
      }),
    ).toThrow(/TYPESAFE_API_KEY/);
  });
});
