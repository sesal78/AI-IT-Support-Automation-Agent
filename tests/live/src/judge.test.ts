import { judgeDefinitionSchema } from "@ai-it-support/shared";
import { describe, expect, it, vi } from "vitest";
import type { InternalClient, JudgmentState } from "./client.ts";
import { createJudgeClient } from "./judge.ts";

const definition = judgeDefinitionSchema.parse({
  id: "J2",
  version: 1,
  type: "noul",
  instructions: "Is it so?",
  criteria: { true: "yes", false: "no" },
});

function fake(states: JudgmentState[]) {
  const startJudgment = vi.fn(async () => ({ runId: "run_abc" }));
  const judgment = vi.fn(async () => states.shift() ?? { status: "pending" as const });
  return { startJudgment, judgment } satisfies Pick<InternalClient, "startJudgment" | "judgment">;
}

describe("createJudgeClient", () => {
  it("posts the definition unchanged and polls until completed", async () => {
    const client = fake([
      { status: "pending" },
      { status: "completed", output: { type: "noul", value: 0.8 } },
    ]);
    const sleep = vi.fn(async () => {});
    const result = await createJudgeClient(client, { sleep }).judge(definition, { a: "b" });
    expect(result).toEqual({ status: "completed", type: "noul", value: 0.8 });
    expect(client.startJudgment).toHaveBeenCalledWith({
      judgeId: "J2",
      version: 1,
      question: {
        type: "noul",
        instructions: "Is it so?",
        criteria: { true: "yes", false: "no" },
      },
      state: { a: "b" },
    });
    expect(client.judgment).toHaveBeenCalledWith("run_abc");
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("reports a failed judgment", async () => {
    const client = fake([{ status: "failed" }]);
    expect(await createJudgeClient(client).judge(definition, {})).toEqual({ status: "failed" });
  });

  it("reports a timeout when it does not finish inside the limit", async () => {
    let t = 0;
    const result = await createJudgeClient(fake([]), {
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      pollIntervalMs: 10,
      timeoutMs: 25,
    }).judge(definition, {});
    expect(result).toEqual({ status: "timeout" });
  });
});
