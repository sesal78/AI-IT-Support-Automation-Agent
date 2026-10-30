import { logger, schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";

export const healthcheckPayload = z.object({
  requestedBy: z.string().min(1),
});

export type HealthcheckPayload = z.infer<typeof healthcheckPayload>;

// Feature → the env names it needs. Names only: nothing here ever holds a value.
const FEATURE_ENV_NAMES = {
  supabase: ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_DB_SCHEMA"],
  typesafe: ["TYPESAFE_API_KEY"],
  llm: ["LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL"],
  langfuse: ["LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_BASE_URL"],
  caps: ["LLM_MONTHLY_CALL_CAP", "TYPESAFE_MONTHLY_CALL_CAP"],
  slack: ["SLACK_BOT_TOKEN", "SLACK_CHANNEL_ID"],
} as const;

type Feature = keyof typeof FEATURE_ENV_NAMES;

export type HealthcheckConfigured = Record<Feature | "e2eMode", boolean>;

export interface HealthcheckResult {
  ok: true;
  requestedBy: string;
  at: string;
  configured: HealthcheckConfigured;
}

type EnvSource = Record<string, string | undefined>;

const isSet = (value: string | undefined) => value !== undefined && value.trim() !== "";

/**
 * Which features have all their env names set. Presence only: a wrong value
 * still shows `true`, and the first real run of a task finds it.
 *
 * Privacy: env values are only ever reduced to booleans. No value, length or
 * prefix of a value is returned or logged.
 */
function readConfigured(env: EnvSource): HealthcheckConfigured {
  const feature = (name: Feature) => FEATURE_ENV_NAMES[name].every((key) => isSet(env[key]));
  return {
    supabase: feature("supabase"),
    typesafe: feature("typesafe"),
    llm: feature("llm"),
    langfuse: feature("langfuse"),
    caps: feature("caps"),
    slack: feature("slack"),
    e2eMode: env.E2E_MODE === "true",
  };
}

/** The task body, exported so tests can call it without the Trigger.dev runtime. */
export async function runHealthcheck(
  payload: HealthcheckPayload,
  env: EnvSource = process.env,
): Promise<HealthcheckResult> {
  const configured = readConfigured(env);
  logger.info("healthcheck: configured", { requestedBy: payload.requestedBy, configured });
  return { ok: true, requestedBy: payload.requestedBy, at: new Date().toISOString(), configured };
}

/**
 * Proves the pipeline is reachable and reports its readiness: triggered by
 * POST /api/health/pipeline in apps/web, or directly for the preflight.
 */
export const healthcheck = schemaTask({
  id: "healthcheck",
  schema: healthcheckPayload,
  // Not `run: runHealthcheck`: the runtime's second argument is the run context, not an env record.
  run: (payload) => runHealthcheck(payload),
});
