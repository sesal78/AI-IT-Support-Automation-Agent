import { env } from "@/env";
import { actionError, runStaffAction } from "@/lib/staff/actions";
import { requireStaff, StaffAccessError } from "@/lib/staff/auth";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (env.HELPDESK !== "builtin") return actionError(404, "Ticket not found");
  try {
    await requireStaff(undefined, "action");
  } catch (error) {
    if (error instanceof StaffAccessError) {
      return actionError(error.status, "You do not have access");
    }
    throw error;
  }

  // Cross-origin HTML forms cannot post JSON. Browser cross-origin fetches
  // require a successful preflight, and this route grants no CORS access.
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return actionError(403, "You do not have access");
  if (
    request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json"
  ) {
    return actionError(400, "Expected a JSON action");
  }
  const input: unknown = await request.json().catch(() => null);
  const client = await createServerSupabaseClient();
  return runStaffAction(client, (await params).id, input, env.E2E_MODE);
}
