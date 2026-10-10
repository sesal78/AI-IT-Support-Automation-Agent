import {
  JUDGE_TEXT_TASK_ID,
  hasUnredactedText,
  judgeTextPayloadSchema,
  type JudgeTextOutput,
  type JudgeTextPayload,
} from "@ai-it-support/shared";
import { tasks, type Task } from "@trigger.dev/sdk";
import { z } from "zod";
import { env } from "@/env";
import { e2eOnlyNotFound } from "@/lib/internal/e2e-only";
import { errorName, guard, json, methodNotAllowed } from "@/lib/internal/respond";

// Never prerendered: the answer depends on the server's mode.
export const dynamic = "force-dynamic";

/** The raw body is refused above this many characters, before it is parsed. */
const MAX_BODY_CHARS = 64_000;

// The task lives in services/pipeline (P3-T11d); triggered by id with the shared payload type.
type JudgeTextTask = Task<typeof JUDGE_TEXT_TASK_ID, JudgeTextPayload, JudgeTextOutput>;

/**
 * Starts one test judgment (e2e only): 202 `{ runId }`. A body the schema
 * refuses is 400 with field errors; a question or state that redact() would
 * change is 422 `unredacted_input` and nothing is triggered. Neither the body
 * nor the judged text is ever logged or echoed.
 */
export async function POST(request: Request) {
  if (!env.E2E_MODE) return e2eOnlyNotFound(request, "judgments_disabled");
  const refusal = await guard(request);
  if (refusal) return refusal;

  let body: unknown;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_CHARS) return json({ error: "too_large" }, 413);
    body = JSON.parse(raw);
  } catch {
    return json({ error: "invalid_body", fieldErrors: {} }, 400);
  }
  const parsed = judgeTextPayloadSchema.safeParse(body);
  if (!parsed.success) {
    return json(
      { error: "invalid_body", fieldErrors: z.flattenError(parsed.error).fieldErrors },
      400,
    );
  }
  if (hasUnredactedText(parsed.data)) return json({ error: "unredacted_input" }, 422);

  try {
    const handle = await tasks.trigger<JudgeTextTask>(JUDGE_TEXT_TASK_ID, parsed.data);
    return json({ runId: handle.id }, 202);
  } catch (error) {
    console.error(`[internal-api] judge trigger failed: ${errorName(error)}`);
    return json({ error: "pipeline_unavailable" }, 502);
  }
}

/** Disabled: 404 for every method. Enabled: the guard, then 405. */
const notAllowed = methodNotAllowed("POST");
const rest = async (request: Request): Promise<Response> =>
  env.E2E_MODE ? notAllowed(request) : e2eOnlyNotFound(request, "judgments_disabled");
export { rest as DELETE, rest as GET, rest as HEAD, rest as OPTIONS, rest as PATCH, rest as PUT };
