import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const trigger = vi.hoisted(() => vi.fn());
const repo = vi.hoisted(() => ({
  createTicket: vi.fn(),
  addEvent: vi.fn(),
  recordSecurityEvent: vi.fn(),
}));
vi.mock("@trigger.dev/sdk", () => ({ tasks: { trigger } }));
vi.mock("@ai-it-support/db", () => ({
  createDbClient: () => ({}),
  createRepositories: () => repo,
}));
const siteverify = vi.hoisted(() => vi.fn());
vi.mock("@/lib/intake/turnstile", () => ({ verifyTurnstile: siteverify }));

const TOKEN = "fakeInternalApiToken0123456789ABCDEF";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DESCRIPTION = "My laptop shows RAW-DESCRIPTION-MARKER-7731 on boot, then a black screen.";
const valid = {
  testId: "eval-1",
  name: "Jo Private-Name",
  email: "jo.private@example.com",
  department: "Finance",
  title: "Laptop will not boot",
  description: DESCRIPTION,
};
const sensitive = [DESCRIPTION, valid.email, valid.name];
const auth = { authorization: `Bearer ${TOKEN}` };
const URL_ = "http://localhost/api/internal/test-tickets";

type Route = typeof import("./route");
let route: Route;
let ids: Map<string, string>;

const post = (body: unknown, headers: Record<string, string> = auth, query = "") =>
  new Request(`${URL_}${query}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

async function load(e2e: string | undefined) {
  vi.resetModules();
  vi.stubEnv("NEXT_PHASE", undefined);
  vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "fake-service-role-key");
  vi.stubEnv("TRIGGER_SECRET_KEY", "fake-trigger-secret");
  vi.stubEnv("ADMIN_HEALTH_TOKEN", "fake-admin-health-token");
  vi.stubEnv("APP_VERSION", "1.0.0-test");
  vi.stubEnv("INTERNAL_API_TOKEN", TOKEN);
  vi.stubEnv("E2E_MODE", e2e);
  route = await import("./route");
}

beforeEach(() => {
  ids = new Map();
  for (const fn of [trigger, siteverify, ...Object.values(repo)]) fn.mockReset();
  repo.recordSecurityEvent.mockResolvedValue(undefined);
  repo.addEvent.mockResolvedValue(undefined);
  trigger.mockResolvedValue({ id: "run_1" });
  repo.createTicket.mockImplementation(async (input: { idempotency_key: string }) => {
    const existing = ids.get(input.idempotency_key);
    const id = existing ?? crypto.randomUUID();
    ids.set(input.idempotency_key, id);
    return { ticket: { id }, created: existing === undefined };
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function notFound(promise: Promise<Response>) {
  const res = await promise;
  expect(res.status).toBe(404);
  expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(res.headers.get("cache-control")).toContain("no-store");
  expect(await res.text()).toContain("404: This page could not be found.");
}

describe("POST /api/internal/test-tickets with E2E_MODE=true", () => {
  beforeEach(() => load("true"));

  it("creates a test ticket under the test: key without Turnstile or a rate limit", async () => {
    for (let i = 0; i < 11; i++) {
      const res = await route.POST(post({ ...valid, testId: `other-${i}` }));
      expect(res.status).toBe(201);
    }
    const res = await route.POST(post(valid));
    const body = (await res.json()) as { ticketId: string };
    expect(body.ticketId).toMatch(UUID_RE);
    expect(repo.createTicket).toHaveBeenLastCalledWith(
      expect.objectContaining({
        source: "web",
        is_test: true,
        idempotency_key: "test:eval-1",
        raw_title: valid.title,
      }),
    );
    expect(siteverify).not.toHaveBeenCalled();
  });

  it("passes testOverrides to the trigger payload unchanged", async () => {
    const res = await route.POST(post({ ...valid, testOverrides: { llmCallCap: 0 } }));
    expect(res.status).toBe(201);
    expect(trigger).toHaveBeenCalledWith("intake-ticket", {
      ticketId: expect.stringMatching(UUID_RE),
      testOverrides: { llmCallCap: 0 },
    });
  });

  it("returns the same ticket with duplicate: true and triggers once", async () => {
    const first = await (await route.POST(post(valid))).json();
    const res = await route.POST(post(valid));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ticketId: first.ticketId, queued: true, duplicate: true });
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it("reports queued: false when the task cannot be triggered", async () => {
    trigger.mockRejectedValue(new Error("down"));
    const res = await route.POST(post(valid));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ queued: false });
  });

  it.each([
    ["no token", {}],
    ["wrong token", { authorization: "Bearer wrong" }],
  ])("401 for %s, nothing stored", async (_name, headers) => {
    const res = await route.POST(post(valid, headers));
    expect(res.status).toBe(401);
    expect(repo.createTicket).not.toHaveBeenCalled();
    expect(trigger).not.toHaveBeenCalled();
  });

  it("401 for a token in the query string", async () => {
    const res = await route.POST(post(valid, auth, `?token=${TOKEN}`));
    expect(res.status).toBe(401);
    expect(repo.createTicket).not.toHaveBeenCalled();
  });

  const bad: Array<[string, Record<string, unknown>]> = [
    ["unknown switch", { ...valid, testOverrides: { slackTimeout: 1 } }],
    ["negative cap", { ...valid, testOverrides: { llmCallCap: -1 } }],
    ["missing testId", { ...valid, testId: undefined }],
    ["space in testId", { ...valid, testId: "eval 1" }],
    ["101-character testId", { ...valid, testId: "a".repeat(101) }],
    ["empty testId", { ...valid, testId: "" }],
    ["slash", { ...valid, testId: "a/b" }],
    ["encoded slash", { ...valid, testId: "a%2fb" }],
    ["dot dot slash", { ...valid, testId: "../x" }],
    ["newline at the end", { ...valid, testId: "eval-1\n" }],
    ["unicode digit", { ...valid, testId: "eval-١" }],
    ["fullwidth letter", { ...valid, testId: "ｅval" }],
    ["short title", { ...valid, title: "ab" }],
    ["bad email", { ...valid, email: "nope" }],
    ["smuggled is_test", { ...valid, is_test: false }],
    ["smuggled isTest", { ...valid, isTest: false }],
    ["smuggled source", { ...valid, source: "email" }],
    ["smuggled idempotency_key", { ...valid, idempotency_key: "web:x" }],
    ["smuggled turnstileToken", { ...valid, turnstileToken: "x" }],
  ];
  it.each(bad)("400 for %s, nothing stored", async (_name, body) => {
    const res = await route.POST(post(body));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_body");
    expect(repo.createTicket).not.toHaveBeenCalled();
    expect(trigger).not.toHaveBeenCalled();
  });

  it("400 with field errors for a bad switch", async () => {
    const res = await route.POST(post({ ...valid, testOverrides: { llmCallCap: -1 } }));
    expect(((await res.json()) as { fieldErrors: object }).fieldErrors).toHaveProperty(
      "testOverrides",
    );
  });

  it("400 for a __proto__ key and for invalid JSON", async () => {
    const proto = JSON.stringify(valid).replace("{", '{"__proto__":{"is_test":false},');
    expect((await route.POST(post(proto))).status).toBe(400);
    expect((await route.POST(post("{not json"))).status).toBe(400);
    expect(repo.createTicket).not.toHaveBeenCalled();
  });

  it.each(["a".repeat(100), "A.b_c:d-9"])("accepts testId %s", async (testId) => {
    expect((await route.POST(post({ ...valid, testId }))).status).toBe(201);
    expect(repo.createTicket).toHaveBeenCalledWith(
      expect.objectContaining({ idempotency_key: `test:${testId}` }),
    );
  });

  it("keeps a form key and a test key apart", async () => {
    await route.POST(post({ ...valid, testId: "web:abc" }));
    expect(repo.createTicket).toHaveBeenCalledWith(
      expect.objectContaining({ idempotency_key: "test:web:abc" }),
    );
  });

  it("answers 405 to other methods with the right token, 401 without", async () => {
    expect((await route.GET(new Request(URL_, { headers: auth }))).status).toBe(405);
    expect((await route.PUT(new Request(URL_, { method: "PUT" }))).status).toBe(401);
  });

  it("logs no description, name or email", async () => {
    const spies = (["log", "info", "warn", "error"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    trigger.mockRejectedValueOnce(new Error(DESCRIPTION));
    await route.POST(post(valid));
    await route.POST(post({ ...valid, title: "x" }));
    await route.POST(post(valid, {}));
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    for (const text of sensitive) expect(logged).not.toContain(text);
  });
});

describe.each([undefined, "false"])("with E2E_MODE=%s", (mode) => {
  beforeEach(() => load(mode));

  it("looks absent with the right token and a valid body, and stores nothing", async () => {
    await notFound(route.POST(post(valid)));
    expect(repo.createTicket).not.toHaveBeenCalled();
    expect(trigger).not.toHaveBeenCalled();
    expect(repo.recordSecurityEvent).toHaveBeenCalledWith("internal_api", "test_tickets_disabled", {
      path: "/api/internal/test-tickets",
      method: "POST",
    });
  });

  it("does not look at the token, even in the query string", async () => {
    await notFound(route.POST(post(valid, {}, `?token=${TOKEN}`)));
    await notFound(route.POST(post(valid, { authorization: "Bearer wrong" })));
    const kinds = repo.recordSecurityEvent.mock.calls.map((call) => call[1]);
    expect(new Set(kinds)).toEqual(new Set(["test_tickets_disabled"]));
  });

  it("is 404 for every method", async () => {
    for (const method of ["GET", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"] as const) {
      await notFound(route[method](new Request(URL_, { method })));
    }
  });

  it("stays 404 when recording the event fails", async () => {
    repo.recordSecurityEvent.mockRejectedValue(new Error(DESCRIPTION));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await notFound(route.POST(post(valid)));
    expect(JSON.stringify(spy.mock.calls)).not.toContain(DESCRIPTION);
  });
});
