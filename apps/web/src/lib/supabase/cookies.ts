import type { CookieOptions } from "@supabase/ssr";

/**
 * One policy for every auth cookie chunk (P5-T16): the session is never
 * readable from client JavaScript (`httpOnly`), never crosses the wire in
 * clear text (`secure`), and never rides on a cross-site request
 * (`sameSite=lax`). `secure` stays on locally too, so local proof needs HTTPS
 * (the e2e stack) or a cookie-aware harness; it is never weakened for
 * localhost.
 */
export const STAFF_COOKIE_OPTIONS: CookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  path: "/",
};
