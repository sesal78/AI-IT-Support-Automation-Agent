import { z } from "zod";
import { createRateLimiter } from "@/lib/intake/rate-limit";
import { clientIp } from "@/lib/intake/request";
import {
  STAFF_LOGIN_BAD_INPUT,
  STAFF_LOGIN_ERROR,
  STAFF_LOGIN_RATE_LIMITED,
} from "@/lib/staff/messages";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/**
 * Staff sign-in (plan §6.3.1 P5-T16). Sign-up, reset and magic links do not
 * exist (G7): Seun invites the user in Supabase Auth, and the `staff` row is
 * the real gate. A wrong password and an unknown email are one answer with one
 * status, so the form cannot be used to discover accounts. The per-IP limiter
 * is the intake one, so the sixth attempt in ten minutes is refused.
 */
export {
  STAFF_LOGIN_BAD_INPUT,
  STAFF_LOGIN_ERROR,
  STAFF_LOGIN_RATE_LIMITED,
} from "@/lib/staff/messages";

/** Five attempts per IP per ten minutes; the sixth is a 429. */
export const STAFF_LOGIN_LIMIT = { limit: 5, windowMs: 10 * 60 * 1000 } as const;

export const staffLoginLimiter = createRateLimiter(STAFF_LOGIN_LIMIT);

const staffLoginSchema = z.object({
  // GoTrue matches addresses case-insensitively; `staff.email` is lower-case.
  email: z.email().transform((value) => value.trim().toLowerCase()),
  password: z.string().min(1).max(4096),
});

type ServerClient = Awaited<ReturnType<typeof createServerSupabaseClient>>;
type Limiter = ReturnType<typeof createRateLimiter>;

export interface StaffLoginDeps {
  supabase: ServerClient;
  limiter: Limiter;
}

const json = (body: unknown, status: number) => Response.json(body, { status });

/**
 * Signs the user in on this response. Success only means "GoTrue accepted the
 * password"; `/staff` pages still call `requireStaff`, which is what checks the
 * active staff row.
 */
export async function handleStaffLogin(request: Request, deps: StaffLoginDeps): Promise<Response> {
  if (!deps.limiter.hit(clientIp(request.headers) ?? "unknown"))
    return json({ message: STAFF_LOGIN_RATE_LIMITED }, 429);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ message: STAFF_LOGIN_BAD_INPUT }, 400);
  }

  const parsed = staffLoginSchema.safeParse(body);
  if (!parsed.success) return json({ message: STAFF_LOGIN_BAD_INPUT }, 400);

  const { error } = await deps.supabase.auth.signInWithPassword(parsed.data);
  // The provider text is never echoed: it differs per cause and would leak
  // whether an address exists.
  if (error) return json({ message: STAFF_LOGIN_ERROR }, 401);
  return json({ ok: true }, 200);
}
