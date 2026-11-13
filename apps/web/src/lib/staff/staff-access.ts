import type { createServerSupabaseClient } from "@/lib/supabase/server";

/**
 * The staff lookup half of the guard (plan §6.3.1 P5-T16, G6). It answers one
 * question with no redirects and no cookie writes: does this session belong to
 * an active staff member, optionally of one role? `auth.ts` turns that answer
 * into a page redirect or an action error.
 *
 * A Supabase session is not access. The user must be verified by GoTrue
 * (`getUser`, never `getSession`, which reads an unverified cookie), and the
 * `itsupport.current_staff()` lookup runs with that user's own JWT, so
 * row-level security stays the control and the service role is never used.
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
  { ok: true; userId: string; staff: StaffMember } | { ok: false; reason: StaffRefusal };

/** The SSR client type, so this module never imports supabase-js directly. */
type ServerSupabaseClient = Awaited<ReturnType<typeof createServerSupabaseClient>>;

interface StaffRow {
  id: string;
  display_name: string;
  role: string;
  active: boolean;
}

const isStaffRole = (value: string): value is StaffRole => value === "agent" || value === "admin";

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
