import { judgePayloadOf, type JsonState, type JudgeDefinition } from "@ai-it-support/shared";
import type { InternalClient } from "./client.ts";

export const DEFAULT_JUDGE_POLL_INTERVAL_MS = 1_000;
export const DEFAULT_JUDGE_TIMEOUT_MS = 120_000;

/** What one judgment came to. `timeout` means it did not finish inside the limit. */
export type JudgeResult =
  | { readonly status: "completed"; readonly type: "noul" | "score"; readonly value: number }
  | { readonly status: "failed" }
  | { readonly status: "timeout" };

export interface JudgeClientOptions {
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
}

export interface JudgeClient {
  /**
   * Posts the definition's `type`, `instructions` and `criteria` unchanged
   * (with `judgeId` and `version`) and `state`, then polls until the judgment
   * ends or the limit passes. A request that cannot be made or answered in the
   * expected shape throws the internal client's error.
   */
  judge(definition: JudgeDefinition, state: JsonState): Promise<JudgeResult>;
}

export function createJudgeClient(
  client: Pick<InternalClient, "startJudgment" | "judgment">,
  options: JudgeClientOptions = {},
): JudgeClient {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_JUDGE_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_JUDGE_TIMEOUT_MS;

  return {
    async judge(definition, state) {
      const deadline = now() + timeoutMs;
      const { runId } = await client.startJudgment(judgePayloadOf(definition, state));
      for (;;) {
        const result = await client.judgment(runId);
        if (result.status === "completed") {
          return { status: "completed", type: result.output.type, value: result.output.value };
        }
        if (result.status === "failed") return { status: "failed" };
        if (now() >= deadline) return { status: "timeout" };
        await sleep(pollIntervalMs);
      }
    },
  };
}
