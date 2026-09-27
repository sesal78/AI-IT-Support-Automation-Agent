import { schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";

export const healthcheckPayload = z.object({
  requestedBy: z.string().min(1),
});

export type HealthcheckPayload = z.infer<typeof healthcheckPayload>;

export interface HealthcheckResult {
  ok: true;
  requestedBy: string;
  at: string;
}

/** The task body, exported so tests can call it without the Trigger.dev runtime. */
export async function runHealthcheck(payload: HealthcheckPayload): Promise<HealthcheckResult> {
  return { ok: true, requestedBy: payload.requestedBy, at: new Date().toISOString() };
}

/** Proves the pipeline is reachable: triggered by POST /api/health/pipeline in apps/web. */
export const healthcheck = schemaTask({
  id: "healthcheck",
  schema: healthcheckPayload,
  run: runHealthcheck,
});
