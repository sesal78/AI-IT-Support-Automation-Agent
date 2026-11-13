import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/**
 * The staff guard (plan §6.3.1 P5-T16, G6). A Supabase session is not access:
 * access needs a GoTrue-verified user (`getUser`, never `getSession`, which
 * reads an unverified cookie) AND an active `itsupport.staff` row found with
 * that user's own JWT. The service role is never used here, so row-level
 * security stays the control.
 */
export type StaffRole = "agent" | "admin";

export interface StaffMember {
  id: string;
  displayName: string;
  role: StaffRole;
  active: boolean;
}

export type StaffRefusal = "no_user" | "unconfirmed" | "no_staff" | "wrong_role";

export type StaffAccess =
  | { ok: true; userId: string; staff: StaffMember }
  | { ok: false; reason: StaffRefusal };

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

interface StaffRow {
  id: string;
  display_name: string;
  role: string;
  active: boolean;
}

/** The SSR client, so this module never imports supabase-js directly. */
type ServerSupabaseClient = Awaited<ReturnType<typeof createServerSupabaseClient>>;

const isStaffRole = (value: string): value is StaffRole => value === "agent" || value === "admin";

/**
 * The decision table, with no redirects and no cookie writes, so both the page
 * guard and the action guard (and the integration run) share one path.
 */
export async function resolveStaffAccess(
  supabase: ServerSupabaseClient,
  role?: StaffRole,
): Promise<StaffAccess> {
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) return { ok: false, reason: "no_user" };
  if (!user.email_confirmed_at) return { ok: false, reason: "unconfirmed" };

  const staffId = await currentStaffId(supabase);
  if (!staffId) return { ok: false, reason: "no_staff" };

  const { data, error: readError } = await supabase
    .from("staff")
    .select("id, display_name, role, active")
    .eq("id", staffId)
    .maybeSingle();
  if (readError) throw new Error(`staff lookup failed: ${readError.message}`);
  const row = data as StaffRow | null;
  if (!row || !row.active || !isStaffRole(row.role)) return { ok: false, reason: "no_staff" };
  if (role !== undefined && row.role !== role) return { ok: false, reason: "wrong_role" };

  return {
    ok: true,
    userId: user.id,
    staff: {
      id: row.id,
      displayName: row.display_name,
      role: row.role,
      active: row.active,
    },
  };
}

/** `itsupport.current_staff()` returns the caller's active staff id, or null. */
async function currentStaffId(supabase: ServerSupabaseClient): Promise<string | null> {
  const { data, error } = await supabase.rpc("current_staff");
  if (error) throw new Error(`staff lookup failed: ${error.message}`);
  return typeof data === "string" && data !== "" ? data : null;
}

/**
 * The guard every `/staff` page and server action calls itself (the proxy only
 * refreshes the cookie). Optionally require a role: `requireStaff("admin")`.
 *
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
