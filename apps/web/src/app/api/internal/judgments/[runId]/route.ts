import { JUDGE_TEXT_TASK_ID, judgeTextOutputSchema } from "@ai-it-support/shared";
import { ApiError, runs } from "@trigger.dev/sdk";
import { env } from "@/env";
import { e2eOnlyNotFound } from "@/lib/internal/e2e-only";
import { errorName, guard, json, methodNotAllowed } from "@/lib/internal/respond";

// Never prerendered: the body reflects the live run.
export const dynamic = "force-dynamic";

// Trigger.dev run ids: `run_` and lower-case letters and digits. Anything else
// (path characters, encodings) is never sent to the API.
const RUN_ID = /^run_[a-z0-9]{1,64}$/;

const notFound = () => json({ error: "not_found" }, 404);

/**
 * The state of one test judgment (e2e only): `{ status: "pending" }`,
 * `{ status: "completed", output: { type, value } }` or `{ status: "failed" }`
 * with no error detail. A run of any other task is 404 like an unknown id,
 * so this route never shows another task's output.
 */
export async function GET(request: Request, context: { params: Promise<{ runId: string }> }) {
  if (!env.E2E_MODE) return e2eOnlyNotFound(request, "judgments_disabled");
  const refusal = await guard(request);
  if (refusal) return refusal;

  const { runId } = await context.params;
  if (!RUN_ID.test(runId)) return notFound();

  let run;
  try {
    run = await runs.retrieve(runId);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return notFound();
    console.error(`[internal-api] judge run lookup failed: ${errorName(error)}`);
    return json({ error: "pipeline_unavailable" }, 502);
  }
  if (run.taskIdentifier !== JUDGE_TEXT_TASK_ID) return notFound();

  if (!run.isCompleted) return json({ status: "pending" });
  if (!run.isSuccess) return json({ status: "failed" });
  const output = judgeTextOutputSchema.safeParse(run.output);
  if (!output.success) {
    console.error("[internal-api] judge run output has an unexpected shape");
    return json({ error: "internal_error" }, 500);
  }
  return json({ status: "completed", output: output.data });
}

const notAllowed = methodNotAllowed("GET, HEAD");
const rest = async (request: Request): Promise<Response> =>
  env.E2E_MODE ? notAllowed(request) : e2eOnlyNotFound(request, "judgments_disabled");
export { rest as DELETE, rest as OPTIONS, rest as PATCH, rest as POST, rest as PUT };
