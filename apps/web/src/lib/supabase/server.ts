import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { env, staffAuthKey } from "@/env";
import { STAFF_COOKIE_OPTIONS } from "./cookies";

/**
 * A per-request Supabase client for Server Components, Server Actions and
 * Route Handlers. It carries the signed-in user's JWT, so row-level security
 * is the control; it never uses the service role. Build a new client per
 * request and never cache it across requests (installed @supabase/ssr
 * createServerClient.d.ts).
 */
export async function createServerSupabaseClient() {
  const store = await cookies();
  return createServerClient(env.SUPABASE_URL, staffAuthKey(), {
    db: { schema: env.SUPABASE_DB_SCHEMA },
    cookieOptions: STAFF_COOKIE_OPTIONS,
    cookies: {
      getAll: () => store.getAll(),
      setAll: (cookiesToSet) => {
        try {
          for (const { name, value, options } of cookiesToSet) store.set(name, value, options);
        } catch {
          // Next 16 refuses cookie writes while rendering a Server Component
          // (installed docs/01-app/03-api-reference/04-functions/cookies.md,
          // "Setting cookies is not supported during Server Component
          // rendering"). The proxy owns the refresh on the response, so this
          // is the documented fallback, not a swallowed error.
        }
      },
    },
  });
}
