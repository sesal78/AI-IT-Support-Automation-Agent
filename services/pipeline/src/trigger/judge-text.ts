import {
  BudgetExceededError,
  JudgeInputError,
  createAiRuntime,
  createAlertSink,
  createLangfuseSink,
  createMeter,
  createTextJudge,
  createTypeSafeClient,
} from "@ai-it-support/ai";
import { createDbClient, createRepositories, dbEnvShape } from "@ai-it-support/db";
import {
  JUDGE_TEXT_TASK_ID,
  aiBudgetEnvShape,
  e2eEnvShape,
  judgeTextPayloadSchema,
  langfuseEnvShape,
  parseEnv,
  type JudgeTextOutput,
  type JudgeTextPayload,
} from "@ai-it-support/shared";
import { logger, schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";

export type { JudgeTextOutput, JudgeTextPayload };

export interface JudgeTextDeps {
  judge: ReturnType<typeof createTextJudge>;
}

const judgeEnvShape = {
  ...dbEnvShape,
  TYPESAFE_API_KEY: z.string().min(1),
  ...aiBudgetEnvShape,
  ...langfuseEnvShape,
  ...e2eEnvShape,
};

/** Validates env and builds the real deps. Invalid variables throw, naming the variable. */
export function createJudgeTextDeps(source: Record<string, string | undefined>): JudgeTextDeps {
  const env = parseEnv(judgeEnvShape, source);
  const repos = createRepositories(createDbClient(source));
  const environment = env.E2E_MODE ? "e2e" : "staging";
  const alert = createAlertSink({
    recordSecurityEvent: repos.recordSecurityEvent,
    logger: { error: (message) => logger.error(message) },
  });
  const meter = createMeter({
    repos,
    caps: { llm: env.LLM_MONTHLY_CALL_CAP, typesafe: env.TYPESAFE_MONTHLY_CALL_CAP },
    environment,
    alert,
  });
  const runtime = createAiRuntime({
    meter,
    sink: createLangfuseSink(env),
    addEvent: repos.addEvent,
    environment,
  });
  return {
    judge: createTextJudge({ client: createTypeSafeClient(env.TYPESAFE_API_KEY), runtime }),
  };
}

/**
 * The task body, exported so tests can call it without the Trigger.dev runtime.
 * A state or question that redact() would change throws JudgeInputError and
 * nothing is metered or sent. Privacy: nothing is logged here; the judged
 * text appears only in the redacted request the runtime traces.
 */
export async function runJudgeText(
  payload: JudgeTextPayload,
  deps: JudgeTextDeps,
): Promise<JudgeTextOutput> {
  return deps.judge.judge(payload);
}

/**
 * Runs one test judge (plan §4.5). Triggered by POST /api/internal/judgments
 * (apps/web, e2e only) by id "judge-text". Unredacted input and a refused
 * budget are not retried: a retry cannot change either answer.
 */
export const judgeText = schemaTask({
  id: JUDGE_TEXT_TASK_ID,
  schema: judgeTextPayloadSchema,
  catchError: async ({ error }) =>
    error instanceof JudgeInputError || error instanceof BudgetExceededError
      ? { skipRetrying: true }
      : undefined,
  run: async (payload) => runJudgeText(payload, createJudgeTextDeps(process.env)),
});
