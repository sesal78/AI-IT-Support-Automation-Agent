import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const trigger = vi.hoisted(() => vi.fn());
const createTicket = vi.hoisted(() => vi.fn());
const addEvent = vi.hoisted(() => vi.fn());
const createDbClient = vi.hoisted(() => vi.fn(() => ({})));

vi.mock("@trigger.dev/sdk", () => ({ tasks: { trigger } }));
vi.mock("@ai-it-support/db", () => ({
  createDbClient,
  createRepositories: () => ({ createTicket, addEvent }),
}));

// Cloudflare's published Turnstile test secret ("always passes"), built at
// run time so secret scanners do not see a key-shaped literal. siteverify is
// mocked: no test talks to the network.
const TEST_SECRET = `1x${"0".repeat(31)}AA`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const DESCRIPTION = "My laptop shows RAW-DESCRIPTION-MARKER-7731 on boot, then a black screen.";
const valid = {
  name: "Jo Private-Name",
  email: "jo.private@example.com",
  department: "Finance",
  title: "Laptop will not boot",
  description: DESCRIPTION,
  turnstileToken: "turnstile-token-marker-9911",
};
const sensitive = [DESCRIPTION, valid.email, valid.name, valid.turnstileToken];

let siteverify: ReturnType<typeof vi.fn>;

function stubEnv() {
  vi.stubEnv("NEXT_PHASE", undefined);
  vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "fake-service-role-key");
  vi.stubEnv("SUPABASE_DB_SCHEMA", undefined);
  vi.stubEnv("TRIGGER_SECRET_KEY", "fake-trigger-secret");
  vi.stubEnv("SHADOW_MODE", undefined);
  vi.stubEnv("ADMIN_HEALTH_TOKEN", "fake-admin-health-token");
  vi.stubEnv("APP_VERSION", "1.0.0-test");
  vi.stubEnv("TURNSTILE_SECRET_KEY", TEST_SECRET);
  vi.stubEnv("TURNSTILE_SITE_KEY", "fake-turnstile-site-key");
}

function ticketRow(id: string, idempotencyKey: string) {
  return {
    id,
    source: "web",
    raw_title: valid.title,
    raw_description: valid.description,
    requester_email: valid.email,
    requester_name: valid.name,
    department: valid.department,
    status: "received",
    servicenow_sys_id: null,
    servicenow_number: null,
    idempotency_key: idempotencyKey,
    is_test: false,
    created_at: "2026-09-30T10:00:00.000Z",
  };
}

function request(
  body: unknown,
  { ip = "203.0.113.7", headers = {} }: { ip?: string; headers?: Record<string, string> } = {},
) {
  return new Request("http://localhost/api/tickets", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function loadPost() {
  const { POST } = await import("./route");
  return POST;
}

describe("POST /api/tickets", () => {
  let logSpies: Array<ReturnType<typeof vi.spyOn>>;

  beforeEach(() => {
    vi.resetModules();
    trigger.mockReset();
    createTicket.mockReset();
    addEvent.mockReset();
    createDbClient.mockClear();
    stubEnv();
    siteverify = vi.fn(async () => Response.json({ success: true }));
    vi.stubGlobal("fetch", siteverify);
    createTicket.mockImplementation(async (input: { idempotency_key: string }) => ({
      ticket: ticketRow(randomUUID(), input.idempotency_key),
      created: true,
    }));
    addEvent.mockResolvedValue({});
    trigger.mockResolvedValue({ id: "run_test_1" });
    logSpies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
  });

  afterEach(() => {
    // The raw description (and other requester data) never reaches a log line.
    const logged = logSpies
      .flatMap((spy) => spy.mock.calls.flat())
      .map((arg) =>
        arg instanceof Error ? `${arg.message}\n${arg.stack ?? ""}` : (JSON.stringify(arg) ?? ""),
      )
      .join("\n");
    for (const value of sensitive) expect(logged).not.toContain(value);
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("stores, records, triggers and returns 201 for a valid submission", async () => {
    const POST = await loadPost();
    const res = await POST(request(valid));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json).toEqual({ ticketId: expect.stringMatching(UUID_RE), queued: true });

    expect(createTicket).toHaveBeenCalledTimes(1);
    expect(createTicket).toHaveBeenCalledWith({
      source: "web",
      raw_title: valid.title,
      raw_description: valid.description,
      requester_email: valid.email,
      requester_name: valid.name,
      department: valid.department,
      idempotency_key: expect.stringMatching(/^web:b:[0-9a-f]{64}$/),
      is_test: false,
    });
    expect(addEvent).toHaveBeenCalledTimes(1);
    expect(addEvent).toHaveBeenCalledWith(json.ticketId, "received");
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveBeenCalledWith("intake-ticket", { ticketId: json.ticketId });
  });

  it("verifies Turnstile server-side with the secret and the client IP", async () => {
    const POST = await loadPost();
    await POST(request(valid, { ip: "198.51.100.23" }));
    expect(siteverify).toHaveBeenCalledTimes(1);
    const [url, init] = siteverify.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    const form = new URLSearchParams(String(init.body));
    expect(form.get("secret")).toBe(TEST_SECRET);
    expect(form.get("response")).toBe(valid.turnstileToken);
    expect(form.get("remoteip")).toBe("198.51.100.23");
  });

  it("uses x-forwarded-for when cf-connecting-ip is missing", async () => {
    const POST = await loadPost();
    const req = new Request("http://localhost/api/tickets", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "192.0.2.5, 10.0.0.1" },
      body: JSON.stringify(valid),
    });
    expect((await POST(req)).status).toBe(201);
    const [, init] = siteverify.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URLSearchParams(String(init.body)).get("remoteip")).toBe("192.0.2.5");
  });

  it("returns 403 turnstile_failed and stores nothing when siteverify says success:false", async () => {
    siteverify.mockImplementation(async () =>
      Response.json({ success: false, "error-codes": ["invalid-input-response"] }),
    );
    const POST = await loadPost();
    const res = await POST(request(valid));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "turnstile_failed" });
    expect(createTicket).not.toHaveBeenCalled();
    expect(addEvent).not.toHaveBeenCalled();
    expect(trigger).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
  ])(
    "returns 403 turnstile_failed for a %s token without calling siteverify",
    async (_l, token) => {
      const POST = await loadPost();
      const res = await POST(request({ ...valid, turnstileToken: token }));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "turnstile_failed" });
      expect(siteverify).not.toHaveBeenCalled();
      expect(createTicket).not.toHaveBeenCalled();
      expect(trigger).not.toHaveBeenCalled();
    },
  );

  it("returns 403 when siteverify cannot be reached", async () => {
    siteverify.mockRejectedValue(new Error("network down"));
    const POST = await loadPost();
    const res = await POST(request(valid));
    expect(res.status).toBe(403);
    expect(createTicket).not.toHaveBeenCalled();
  });

  it("returns 400 with field errors naming title and does not call Turnstile", async () => {
    const POST = await loadPost();
    const res = await POST(request({ ...valid, title: "ab" }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("invalid_body");
    expect(json.fieldErrors.title).toEqual([expect.any(String)]);
    expect(Object.keys(json.fieldErrors)).toEqual(["title"]);
    expect(siteverify).not.toHaveBeenCalled();
    expect(createTicket).not.toHaveBeenCalled();
  });

  it("returns 400 (not 403) when other fields are invalid as well as the token", async () => {
    const POST = await loadPost();
    const res = await POST(request({ ...valid, title: "ab", turnstileToken: "" }));
    expect(res.status).toBe(400);
    expect((await res.json()).fieldErrors.title).toBeDefined();
    expect(siteverify).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed JSON", "{not json"],
    ["a JSON array", "[]"],
  ])("returns 400 invalid_body for %s", async (_label, body) => {
    const POST = await loadPost();
    const res = await POST(request(body));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_body");
    expect(siteverify).not.toHaveBeenCalled();
  });

  it("returns 429 rate_limited on the 6th submit from the same IP within 10 minutes", async () => {
    const POST = await loadPost();
    for (let i = 0; i < 5; i++) {
      const res = await POST(request({ ...valid, title: `Laptop issue ${i}` }));
      expect(res.status).toBe(201);
    }
    const sixth = await POST(request({ ...valid, title: "Laptop issue 6" }));
    expect(sixth.status).toBe(429);
    expect(await sixth.json()).toEqual({ error: "rate_limited" });
    expect(createTicket).toHaveBeenCalledTimes(5);

    // Another IP is not affected.
    expect((await POST(request(valid, { ip: "198.51.100.99" }))).status).toBe(201);
  });

  it("returns the same ticketId for a repeated Idempotency-Key and does not trigger again", async () => {
    const id = randomUUID();
    createTicket
      .mockResolvedValueOnce({ ticket: ticketRow(id, "key-1"), created: true })
      .mockResolvedValueOnce({ ticket: ticketRow(id, "key-1"), created: false });
    const POST = await loadPost();
    const headers = { "Idempotency-Key": "key-1" };

    const first = await POST(request(valid, { headers }));
    const second = await POST(request(valid, { headers }));

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect((await first.json()).ticketId).toBe(id);
    expect((await second.json()).ticketId).toBe(id);
    expect(createTicket).toHaveBeenCalledTimes(2);
    for (const call of createTicket.mock.calls) {
      expect(call[0].idempotency_key).toBe("web:k:key-1");
    }
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(addEvent).toHaveBeenCalledTimes(1);
  });

  it("stores a client-sent email: key under the web namespace", async () => {
    const POST = await loadPost();
    const res = await POST(request(valid, { headers: { "Idempotency-Key": "email:abc" } }));
    expect(res.status).toBe(201);
    expect(createTicket).toHaveBeenCalledTimes(1);
    expect(createTicket).toHaveBeenCalledWith(
      expect.objectContaining({ source: "web", idempotency_key: "web:k:email:abc" }),
    );
  });

  describe("P3-T4b: disjoint web key forms, against a keyed store", () => {
    // A store that dedupes on idempotency_key the way the tickets table does.
    beforeEach(() => {
      const byKey = new Map<string, ReturnType<typeof ticketRow>>();
      createTicket.mockImplementation(async (input: { idempotency_key: string }) => {
        const existing = byKey.get(input.idempotency_key);
        if (existing) return { ticket: existing, created: false };
        const ticket = ticketRow(randomUUID(), input.idempotency_key);
        byKey.set(input.idempotency_key, ticket);
        return { ticket, created: true };
      });
    });

    it("a header equal to another body's hash cannot claim that body's ticket", async () => {
      const POST = await loadPost();
      const first = await POST(request(valid));
      expect(first.status).toBe(201);
      const firstId = (await first.json()).ticketId;
      const storedKey: string = createTicket.mock.calls[0][0].idempotency_key;
      expect(storedKey).toMatch(/^web:b:[0-9a-f]{64}$/);
      const bodyHash = storedKey.slice("web:b:".length);

      const other = { ...valid, title: "A different problem" };
      for (const header of [bodyHash, `b:${bodyHash}`]) {
        const res = await POST(request(other, { headers: { "Idempotency-Key": header } }));
        expect(res.status).toBe(201);
        const json = await res.json();
        expect(json.duplicate).toBeUndefined();
        expect(json.ticketId).not.toBe(firstId);
      }
      expect(createTicket.mock.calls.map((call) => call[0].idempotency_key)).toEqual([
        storedKey,
        `web:k:${bodyHash}`,
        `web:k:b:${bodyHash}`,
      ]);
      expect(trigger).toHaveBeenCalledTimes(3);
    });

    it("the same body and header twice return the same ticketId and trigger once", async () => {
      const POST = await loadPost();
      const headers = { "Idempotency-Key": "retry-7" };
      const first = await (await POST(request(valid, { headers }))).json();
      const second = await (await POST(request(valid, { headers }))).json();
      expect(second.ticketId).toBe(first.ticketId);
      expect(second.duplicate).toBe(true);
      expect(createTicket.mock.calls.map((call) => call[0].idempotency_key)).toEqual([
        "web:k:retry-7",
        "web:k:retry-7",
      ]);
      expect(trigger).toHaveBeenCalledTimes(1);
    });
  });

  it("returns 201 queued:false and records enqueue_failed when the trigger call fails", async () => {
    trigger.mockRejectedValue(new Error("trigger.dev unreachable"));
    const POST = await loadPost();
    const res = await POST(request(valid));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json).toEqual({ ticketId: expect.stringMatching(UUID_RE), queued: false });
    expect(addEvent).toHaveBeenCalledWith(json.ticketId, "received");
    expect(addEvent).toHaveBeenCalledWith(json.ticketId, "enqueue_failed", {
      error: "Error",
    });
  });

  it("still returns 201 queued:false when recording enqueue_failed also fails", async () => {
    trigger.mockRejectedValue(new Error("trigger.dev unreachable"));
    addEvent.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("db down"));
    const POST = await loadPost();
    const res = await POST(request(valid));
    expect(res.status).toBe(201);
    expect((await res.json()).queued).toBe(false);
  });

  it("returns 500 internal_error and does not trigger when the ticket cannot be stored", async () => {
    createTicket.mockRejectedValue(new Error("createTicket failed: supabase error 08006"));
    const POST = await loadPost();
    const res = await POST(request(valid));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal_error" });
    expect(trigger).not.toHaveBeenCalled();
  });

  it("builds the database client from the validated env", async () => {
    const POST = await loadPost();
    await POST(request(valid));
    await POST(request({ ...valid, title: "Second ticket" }));
    expect(createDbClient).toHaveBeenCalledTimes(1);
    expect(createDbClient).toHaveBeenCalledWith({
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "fake-service-role-key",
      SUPABASE_DB_SCHEMA: "itsupport",
    });
  });

  describe("test switches (public boundary)", () => {
    const smuggled: Array<[string, Record<string, unknown>]> = [
      ["testOverrides", { testOverrides: { llmCallCap: 0 } }],
      ["test_overrides", { test_overrides: { llmCallCap: 0 } }],
      ["TestOverrides", { TestOverrides: { llmCallCap: 0 } }],
      ["isTest", { isTest: true }],
      ["is_test", { is_test: true }],
      ["nested ticket", { ticket: { testOverrides: { llmCallCap: 0 }, is_test: true } }],
      ["constructor", { constructor: { prototype: { testOverrides: { llmCallCap: 0 } } } }],
    ];

    for (const e2e of ["false", "true"]) {
      it.each(smuggled)("ignores body field %s with E2E_MODE=" + e2e, async (_name, extra) => {
        vi.stubEnv("E2E_MODE", e2e);
        const POST = await loadPost();
        const res = await POST(request({ ...valid, ...extra }));
        expect(res.status).toBe(201);
        expect(createTicket.mock.calls[0]?.[0]).toMatchObject({ is_test: e2e === "true" });
        const payload = trigger.mock.calls[0]?.[1] as Record<string, unknown>;
        expect(Object.keys(payload)).toEqual(["ticketId"]);
      });
    }

    it("ignores __proto__ and duplicate-key JSON smuggling", async () => {
      const POST = await loadPost();
      const raw = JSON.stringify(valid).slice(0, -1);
      const protoBody = raw + ',"__proto__":{"testOverrides":{"llmCallCap":0},"is_test":true}}';
      const dupBody = raw + ',"is_test":true,"is_test":false,"testOverrides":{"llmCallCap":0}}';
      for (const body of [protoBody, dupBody]) {
        expect((await POST(request(body))).status).toBe(201);
      }
      for (const call of createTicket.mock.calls) expect(call[0]).toMatchObject({ is_test: false });
      for (const call of trigger.mock.calls) {
        expect(Object.keys(call[1] as object)).toEqual(["ticketId"]);
      }
    });

    it("stores is_test true for a form ticket when E2E_MODE=true", async () => {
      vi.stubEnv("E2E_MODE", "true");
      const POST = await loadPost();
      const res = await POST(request(valid));
      const { ticketId } = await res.json();
      expect(createTicket.mock.calls[0]?.[0]).toMatchObject({ is_test: true });
      expect(trigger).toHaveBeenCalledWith("intake-ticket", { ticketId });
    });

    it("rejects an E2E_MODE value other than true or false at boot", async () => {
      vi.stubEnv("E2E_MODE", "TRUE");
      const POST = loadPost();
      await expect(POST).rejects.toThrow();
    });
  });
});
