import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/**
 * `POST /staff/logout` (P5-T16). Sign-out must work for a stale or non-staff
 * session, so it does not call `requireStaff`: the guard would refuse the very
 * user who needs out. It revokes the session when GoTrue answers, always
 * clears the local cookies, and sends the browser to the sign-in screen.
 * POST only — a link must not sign anyone out.
 */
export async function POST(): Promise<NextResponse> {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.auth.signOut();
  // A failed revoke still ends the local session, so the browser leaves with
  // no usable cookie.
  if (error) await supabase.auth.signOut({ scope: "local" });

  return new NextResponse(null, {
    status: 303,
    headers: { location: "/staff/login", "cache-control": "no-store" },
  });
}
