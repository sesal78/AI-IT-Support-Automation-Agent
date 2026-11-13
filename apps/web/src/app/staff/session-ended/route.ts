import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/**
 * The denial endpoint (P5-T16). `requireStaff` sends a signed-in user who is
 * not active staff here, because a Server Component cannot delete a cookie
 * (installed Next 16 cookies.md). This Route Handler clears the local session
 * and answers 403. It shows no account detail and has no `requireStaff` call
 * of its own: it is the refusal, not a staff screen.
 */
const BODY = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="robots" content="noindex" />
    <title>403 - no access</title>
  </head>
  <body>
    <main>
      <h1>403 - no access</h1>
      <p>You do not have access to the staff area.</p>
      <p><a href="/staff/login">Sign in with a staff account</a></p>
    </main>
  </body>
</html>
`;

export async function GET(): Promise<NextResponse> {
  const supabase = await createServerSupabaseClient();
  // Local scope clears the cookies without a network round trip, so the
  // session goes even when GoTrue cannot be reached.
  await supabase.auth.signOut({ scope: "local" });
  return new NextResponse(BODY, {
    status: 403,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
