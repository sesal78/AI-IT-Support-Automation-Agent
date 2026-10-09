import { z } from "zod";

/** Phase 1 server environment variables, shared by apps/web and services/pipeline. */
export const phase1EnvShape = {
  SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_DB_SCHEMA: z.string().min(1).default("itsupport"),
  TRIGGER_SECRET_KEY: z.string().min(1),
  SHADOW_MODE: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  ADMIN_HEALTH_TOKEN: z.string().min(16),
  APP_VERSION: z.string().min(1),
};

/** Phase 2 intake variables (apps/web only): Cloudflare Turnstile keys. */
export const intakeEnvShape = {
  TURNSTILE_SECRET_KEY: z.string().min(1),
  // Public site key, read at run time by the form's server component (P2-T5).
  TURNSTILE_SITE_KEY: z.string().min(1),
};

/**
 * Internal API bearer token (apps/web only). Letters and digits only, 32 or
 * more: a generated app token must survive env files and URL-free headers.
 */
export const internalEnvShape = {
  INTERNAL_API_TOKEN: z
    .string()
    .regex(/^[A-Za-z0-9]{32,}$/, "must be at least 32 letters or digits"),
};

/**
 * End-to-end test mode flag (apps/web). Only the exact strings `true` and
 * `false` are accepted, so a typo such as `TRUE` or `1` fails at boot.
 */
export const e2eEnvShape = {
  E2E_MODE: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
};

/**
 * Sensitive-topic check env for the intake-ticket task (services/pipeline).
 * SENSITIVE_THRESHOLD is the TypeSafe Noul probability at or above which a
 * topic is flagged; phase 3 evals tune the 0.5 starting value.
 */
export const sensitiveCheckEnvShape = {
  TYPESAFE_API_KEY: z.string().min(1),
  SENSITIVE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.5),
};

const unitThreshold = (fallback: number) => z.coerce.number().min(0).max(1).default(fallback);

/**
 * Policy engine thresholds (services/pipeline). Each is a number from 0 to 1.
 * Injection, needs-info and outage rules fire at or above their threshold;
 * low confidence fires below TRIAGE_CONFIDENCE_MIN. Phase 3 evals tune these.
 */
export const policyEnvShape = {
  TRIAGE_CONFIDENCE_MIN: unitThreshold(0.7),
  INJECTION_THRESHOLD: unitThreshold(0.5),
  NEEDS_INFO_THRESHOLD: unitThreshold(0.5),
  OUTAGE_THRESHOLD: unitThreshold(0.5),
};

/**
 * A monthly AI call cap: plain decimal digits only, 0 to 1,000,000,000. A
 * typo such as `abc`, `-1`, `1e3`, `1.5` or ` 5` fails at boot rather than
 * becoming a wrong cap (spend control fails closed). `0` is valid and refuses
 * every call. An unset or empty variable takes the default.
 */
const callCap = (fallback: number) =>
  z
    .string()
    .regex(/^[0-9]{1,10}$/, "must be a whole number of calls, digits only")
    .transform(Number)
    .pipe(z.number().max(1_000_000_000, "must be at most 1000000000"))
    .default(fallback);

/** Monthly AI call caps for the metered wrapper (packages/ai meter, services/pipeline). */
export const aiBudgetEnvShape = {
  LLM_MONTHLY_CALL_CAP: callCap(2000),
  TYPESAFE_MONTHLY_CALL_CAP: callCap(20000),
};

/**
 * Deploy-time variable for services/pipeline: the Trigger.dev project that
 * `trigger.config.ts` targets. Optional; unset means the main project.
 * `services/pipeline/src/project-ref.ts` applies the same rule without zod.
 */
export const triggerProjectEnvShape = {
  TRIGGER_PROJECT_REF: z
    .string()
    .regex(/^proj_[a-z0-9]+$/, "must be proj_ followed by lower-case letters and digits")
    .optional(),
};

/**
 * Langfuse Cloud trace export (services/pipeline). The base URL must be https
 * and carry no credentials; `parseEnv` never echoes the secret key.
 */
export const langfuseEnvShape = {
  LANGFUSE_PUBLIC_KEY: z.string().min(1),
  LANGFUSE_SECRET_KEY: z.string().min(1),
  LANGFUSE_BASE_URL: z.url().refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.username === "" && url.password === "";
    } catch {
      return false;
    }
  }, "must be an https URL without credentials"),
};

type PathSegment = PropertyKey | { key: PropertyKey };

export interface EnvIssue {
  readonly path?: ReadonlyArray<PathSegment> | undefined;
  readonly message: string;
}

/** Builds an error message that names each invalid variable but never echoes its value. */
export function formatEnvIssues(issues: ReadonlyArray<EnvIssue>): string {
  const lines = issues.map((issue) => {
    const name =
      issue.path
        ?.map((segment) => String(typeof segment === "object" ? segment.key : segment))
        .join(".") || "(root)";
    return `  ${name}: ${issue.message}`;
  });
  return `Invalid environment variables:\n${lines.join("\n")}`;
}

/**
 * Validates `source` against `shape`. Empty strings count as unset.
 * Throws an Error naming every invalid variable.
 */
export function parseEnv<T extends z.ZodRawShape>(
  shape: T,
  source: Record<string, string | undefined>,
): z.output<z.ZodObject<T>> {
  const input = Object.fromEntries(
    Object.keys(shape).map((key) => [key, source[key] === "" ? undefined : source[key]]),
  );
  const result = z.object(shape).safeParse(input);
  if (!result.success) {
    throw new Error(formatEnvIssues(result.error.issues));
  }
  return result.data;
}
