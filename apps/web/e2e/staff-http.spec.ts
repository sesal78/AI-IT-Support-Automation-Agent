import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";

test.setTimeout(240_000);
import { createTestStaffUser } from "../../../packages/db/integration/test-users.js";
import {
  mintJwt,
  removeRestStack,
  startRestStack,
  type RestStack,
} from "../../../packages/db/integration/rest-stack.js";

// Real Next HTTP responses against private GoTrue. Cookie headers are replayed
// explicitly: this proves framework cookie emission, not browser HTTPS transport.
let stack: RestStack | undefined;
let web: ChildProcess | undefined;
let base: string;
const jar = new Map<string, string>();

async function unusedPort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((done) => socket.listen(0, "127.0.0.1", done));
  const address = socket.address();
  if (!address || typeof address === "string") throw new Error("no local test port");
  await new Promise<void>((done) => socket.close(() => done()));
  return address.port;
}

async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(base + path, {
    ...init,
    redirect: "manual",
    headers: {
      cookie: [...jar].map(([key, value]) => key + "=" + value).join("; "),
      ...init.headers,
    },
    signal: AbortSignal.timeout(20_000),
  });
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(";")[0]!;
    const split = pair.indexOf("=");
    const name = pair.slice(0, split);
    if (/max-age=0/i.test(cookie)) jar.delete(name);
    else jar.set(name, pair.slice(split + 1));
  }
  return response;
}

test.beforeAll(async () => {
  stack = await startRestStack();
  const port = await unusedPort();
  base = "http://127.0.0.1:" + port;
  const next = fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url));
  web = spawn(
    process.execPath,
    [next, "start", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        NEXT_TELEMETRY_DISABLED: "1",
        HELPDESK: "builtin",
        SUPABASE_URL: stack.url,
        SUPABASE_DB_SCHEMA: "itsupport",
        SUPABASE_SERVICE_ROLE_KEY: stack.serviceRoleKey,
        SUPABASE_ANON_KEY: mintJwt(stack.jwtSecret, { role: "anon" }),
        TRIGGER_SECRET_KEY: "fake-trigger-secret",
        ADMIN_HEALTH_TOKEN: "fake-admin-health-token",
        APP_VERSION: "0.0.0-staff-http-test",
        INTERNAL_API_TOKEN: "fakeInternalApiToken0123456789ABCDEF",
        TURNSTILE_SECRET_KEY: "fake-turnstile-secret",
        TURNSTILE_SITE_KEY: "fake-turnstile-site",
        SLACK_SIGNING_SECRET: "f".repeat(32),
        SLACK_REVIEWER_IDS: "U0000000000",
        SLACK_CHANNEL_ID: "C0000000000",
        SHADOW_MODE: "true",
      },
    },
  );
  // Drain without exposing application errors, generated passwords or tokens.
  web.stdout?.resume();
  web.stderr?.resume();
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (web.exitCode !== null) throw new Error("local Next server exited");
    try {
      if ((await request("/api/health")).ok) return;
    } catch {
      /* server not listening yet */
    }
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error("local Next server startup timed out");
});

test.afterAll(async () => {
  try {
    if (web && web.exitCode === null && web.signalCode === null) {
      const child = web;
      await new Promise<void>((done) => {
        child.once("exit", () => done());
        child.kill();
      });
    }
  } finally {
    await removeRestStack(stack);
  }
});

test("emits secure cookies on login, serves the guarded page, and clears them on POST logout", async () => {
  const user = await createTestStaffUser(stack!, { role: "agent" });
  const login = await request("/staff/login/submit", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.76" },
    body: JSON.stringify({ email: user.email, password: user.password }),
  });
  // Avoid assertion output that could include a generated cookie value.
  expect(login.status).toBe(200);
  const authCookies = login.headers.getSetCookie().filter((value) => value.includes("auth-token"));
  expect(authCookies.length > 0).toBe(true);
  expect(
    authCookies.every(
      (value) => /httponly/i.test(value) && /secure/i.test(value) && /samesite=lax/i.test(value),
    ),
  ).toBe(true);
  expect((await request("/staff/tickets")).status).toBe(200);

  const logout = await request("/staff/logout", { method: "POST" });
  expect(logout.status).toBe(303);
  expect(logout.headers.get("location")).toBe("/staff/login");
  const cleared = logout.headers.getSetCookie().filter((value) => value.includes("auth-token"));
  expect(cleared.length > 0 && cleared.every((value) => /max-age=0/i.test(value))).toBe(true);
  expect([...jar.keys()].some((name) => name.includes("auth-token"))).toBe(false);
  const next = await request("/staff/tickets");
  expect(next.status).toBe(307);
  expect(new URL(next.headers.get("location")!, base).pathname).toBe("/staff/login");
});
