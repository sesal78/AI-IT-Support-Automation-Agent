import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/env";
import { STAFF_COOKIE_OPTIONS } from "./cookies";

/**
 * Refreshes the staff session cookie before the app renders (P5-T16, Next 16
 * `proxy.ts`). `getUser()` asks GoTrue to verify the token; refreshed chunks
 * go back on the response with the same policy, together with the no-store
 * headers the library pairs with them (installed @supabase/ssr types.d.ts).
 * Pages and actions still call `requireStaff` themselves: this only keeps the
 * cookie fresh.
 */
export async function refreshStaffSession(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });
  const supabase = createServerClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    cookieOptions: STAFF_COOKIE_OPTIONS,
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet, headers) => {
        // Forward the refreshed values to the app, then rebuild the response so
        // every chunk (and its policy) lands on the outgoing headers.
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet)
          response.cookies.set(name, value, options);
        for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
      },
    },
  });
  await supabase.auth.getUser();
  return response;
}
