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
