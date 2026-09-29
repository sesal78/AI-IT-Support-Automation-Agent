import { parseEnv, phase1EnvShape } from "@ai-it-support/shared";
import { createClient } from "@supabase/supabase-js";

// Server-only guard. The client holds the service_role key, which bypasses
// RLS, so this module must never load in a browser bundle. An explicit check
// is used instead of the `server-only` package: that package throws on every
// import outside a React Server Components bundler, which would break
// services/pipeline (plain Node) and Vitest.
// (`window` is checked via globalThis: this package compiles without DOM types.)
if ("window" in globalThis) {
  throw new Error("@ai-it-support/db is server-only: it must not be imported in browser code");
}

/** The env subset this package needs, validated by the shared helper. */
export const dbEnvShape = {
  SUPABASE_URL: phase1EnvShape.SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: phase1EnvShape.SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_DB_SCHEMA: phase1EnvShape.SUPABASE_DB_SCHEMA,
};

/**
 * Creates a supabase-js client for the `SUPABASE_DB_SCHEMA` schema, using the
 * service_role key. Pass `process.env` (or any env record); invalid variables
 * throw, naming the variable but never its value.
 */
export function createDbClient(source: Record<string, string | undefined>) {
  const env = parseEnv(dbEnvShape, source);
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    db: { schema: env.SUPABASE_DB_SCHEMA },
    // Server-side key: no user session to store or refresh.
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export type DbClient = ReturnType<typeof createDbClient>;
