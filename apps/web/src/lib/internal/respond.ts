import { createDbClient, createRepositories, type Repositories } from "@ai-it-support/db";
import { env } from "@/env";
import { requireInternalAuth } from "@/lib/internal/auth";

let repositories: Repositories | undefined;
export function repos(): Repositories {
  repositories ??= createRepositories(
    createDbClient({
      SUPABASE_URL: env.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
      SUPABASE_DB_SCHEMA: env.SUPABASE_DB_SCHEMA,
    }),
  );
  return repositories;
}

const NO_STORE = { "Cache-Control": "no-store" };

/** JSON response that no cache may keep. */
export const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: NO_STORE });

// Error class name only: messages and stacks can carry row values.
export const errorName = (error: unknown) => (error instanceof Error ? error.name : "unknown");

/** The guard's 401, marked no-store. Null when the request may go on. */
export async function guard(request: Request): Promise<Response | null> {
  const refusal = await requireInternalAuth(request);
  refusal?.headers.set("Cache-Control", "no-store");
  return refusal;
}

/**
 * Handler for every method the route does not serve. The guard runs first,
 * so an unauthenticated caller gets 401 whatever the method.
 */
export function methodNotAllowed(allow: string) {
  return async (request: Request): Promise<Response> =>
    (await guard(request)) ??
    new Response(null, { status: 405, headers: { ...NO_STORE, Allow: allow } });
}
