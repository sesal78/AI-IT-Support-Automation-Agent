/**
 * The exact staff sign-in messages (P5-T16). Kept in their own module because
 * the client form needs them: it must not import `login.ts`, which pulls in
 * the server Supabase client.
 */
export const STAFF_LOGIN_ERROR = "Email or password is wrong";
export const STAFF_LOGIN_BAD_INPUT = "Enter an email address and a password.";
export const STAFF_LOGIN_RATE_LIMITED = "Too many attempts. Try again later.";
export const STAFF_LOGIN_UNAVAILABLE = "Sign in is unavailable. Try again.";
