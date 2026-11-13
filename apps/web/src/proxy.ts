import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/env";
import { refreshStaffSession } from "@/lib/supabase/session";

/**
 * `/staff/*` exists only for the built-in helpdesk (plan §6.3.1 G11, P5-T16).
 * With `HELPDESK=servicenow` every staff route — login and logout included —
 * is a 404, so a ServiceNow deployment exposes no staff surface at all. The
 * check runs before any auth work.
 *
 * For `builtin`, the proxy only refreshes the session cookie. Every page and
 * every server action under `/staff` calls `requireStaff` itself, because a
 * matcher change must not become an auth bypass (installed docs
 * 01-app/03-api-reference/03-file-conventions/proxy.md, "Execution order").
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  if (!request.nextUrl.pathname.startsWith("/staff")) return NextResponse.next({ request });
  if (env.HELPDESK !== "builtin") return new NextResponse(null, { status: 404 });
  return refreshStaffSession(request);
}

export const config = {
  matcher: ["/staff/:path*"],
};
