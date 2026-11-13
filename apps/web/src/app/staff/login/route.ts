import { handleStaffLogin, staffLoginLimiter } from "@/lib/staff/login";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/**
 * `POST /staff/login` (P5-T16). A Route Handler, not a Server Action, because
 * the sixth attempt must answer a real 429 and the refresh cookie must land on
 * this response. The proxy already answered 404 when `HELPDESK` is not builtin.
 */
export async function POST(request: Request): Promise<Response> {
  const supabase = await createServerSupabaseClient();
  return handleStaffLogin(request, { supabase, limiter: staffLoginLimiter });
}
