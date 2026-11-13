import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import {
  resolveStaffAccess,
  type StaffMember,
  type StaffRefusal,
  type StaffRole,
} from "./staff-access";

/**
 * The policy half of the staff guard (P5-T16). Every `/staff` page and server
 * action calls `requireStaff` itself; the proxy only refreshes the cookie.
 */
export { resolveStaffAccess } from "./staff-access";
export type { StaffAccess, StaffMember, StaffRefusal, StaffRole } from "./staff-access";

export const STAFF_LOGIN_PATH = "/staff/login";
/** The single place a refusal clears the session and answers 403. */
export const STAFF_DENIED_PATH = "/staff/session-ended";

/**
 * Server actions have no redirect target: they throw instead, and the action
 * converts the throw to a 401 (no session) or 403 (a session without access).
 */
export class StaffAccessError extends Error {
  constructor(
    readonly status: 401 | 403,
    readonly reason: StaffRefusal,
  ) {
    super(`staff access refused: ${reason}`);
    this.name = "StaffAccessError";
  }
}

/**
 * Pages: no session redirects to `/staff/login`; any other refusal redirects
 * to `/staff/session-ended`, which clears the session and answers 403 (a
 * Server Component cannot delete a cookie). Actions: throws `StaffAccessError`
 * with 401 for no session and 403 otherwise.
 */
export async function requireStaff(
  role?: StaffRole,
  mode: "page" | "action" = "page",
): Promise<{ userId: string; staff: StaffMember }> {
  const supabase = await createServerSupabaseClient();
  const access = await resolveStaffAccess(supabase, role);
  if (access.ok) return { userId: access.userId, staff: access.staff };
  if (mode === "action")
    throw new StaffAccessError(access.reason === "no_user" ? 401 : 403, access.reason);
  redirect(access.reason === "no_user" ? STAFF_LOGIN_PATH : STAFF_DENIED_PATH);
}
