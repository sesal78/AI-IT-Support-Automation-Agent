import { createServerClient } from "@supabase/ssr";
import { createRateLimiter } from "@/lib/intake/rate-limit";
import { handleStaffLogin } from "@/lib/staff/login";
import {
  mintJwt,
  removeRestStack,
  startRestStack,
  type RestStack,
} from "../../../packages/db/integration/rest-stack.js";

// Shared harness for the staff auth integration suites (P5-T16): a private
// GoTrue/PostgREST stack, an SSR cookie store that behaves like next/headers
// inside a Route Handler, and a sign-in through the real route handler. Every
// value is generated per run and never printed.

export const POLICY = { httpOnly: true, secure: true, sameSite: "lax", path: "/" } as const;

/** An SSR cookie store; `maxAge: 0` removes, as the browser would. */
export class Jar {
  private readonly cookies = new Map<string, { value: string; options: Record<string, unknown> }>();

  getAll = () => [...this.cookies].map(([name, cookie]) => ({ name, value: cookie.value }));

  setAll = (list: { name: string; value: string; options: Record<string, unknown> }[]) => {
    for (const { name, value, options } of list) {
      if (options.maxAge === 0) this.cookies.delete(name);
      else this.cookies.set(name, { value, options });
    }
  };

  keys = () => [...this.cookies.keys()];

  options(name: string) {
    return this.cookies.get(name)?.options ?? {};
  }

  /** A session cookie value is `base64-` + base64url(JSON). */
  readSession(): Record<string, unknown> {
    const key = this.authCookieKey();
    const raw = this.cookies.get(key)!.value.slice("base64-".length);
    return JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Record<string, unknown>;
  }

  writeSession(session: Record<string, unknown>) {
    const key = this.authCookieKey();
    this.cookies.get(key)!.value =
      `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
  }

  clone(): Jar {
    const copy = new Jar();
    for (const [name, cookie] of this.cookies) copy.cookies.set(name, { ...cookie });
    return copy;
  }

  authCookieKey() {
    const key = this.keys().find((name) => name.endsWith("-auth-token"));
    if (!key) throw new Error("no auth cookie was written");
    return key;
  }

  authTokenKeys() {
    return this.keys().filter((name) => name.includes("auth-token"));
  }
}

export interface SignedIn {
  jar: Jar;
  response: Response;
  supabase: ReturnType<typeof clientOn>;
}

let current: RestStack | undefined;

export function getStack(): RestStack {
  if (!current) throw new Error("staff stack not started");
  return current;
}

export function anonKey() {
  return mintJwt(getStack().jwtSecret, { role: "anon" });
}

export function clientOn(jar: Jar) {
  return createServerClient(getStack().url, anonKey(), {
    db: { schema: "itsupport" },
    cookieOptions: POLICY,
    cookies: { getAll: jar.getAll, setAll: jar.setAll },
  });
}

/** Signs in through the real route handler and keeps the cookies it writes. */
export async function signIn(email: string, password: string): Promise<SignedIn> {
  const jar = new Jar();
  const supabase = clientOn(jar);
  const limiter = createRateLimiter({ limit: 5, windowMs: 10 * 60 * 1000 });
  const response = await handleStaffLogin(
    new Request("https://example.test/staff/login", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.20" },
      body: JSON.stringify({ email, password }),
    }),
    { supabase, limiter },
  );
  return { jar, response, supabase };
}

export async function startStaffStack(): Promise<RestStack> {
  current = await startRestStack();
  return current;
}

export async function stopStaffStack(): Promise<void> {
  await removeRestStack(current);
  current = undefined;
}
