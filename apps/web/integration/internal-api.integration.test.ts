import { globalAgent } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildCanaries, canaryTicketText } from "../../../packages/shared/src/canaries.js";
import { clientFor } from "../../../packages/db/integration/pg-container.js";
import {
  MIGRATIONS,
  removeRestStack,
  startRestStack,
  type RestStack,
} from "../../../packages/db/integration/rest-stack.js";
import { egress } from "../../../services/pipeline/test-support/egress.js";

// P3-T1g: the internal API route handlers against the local REST stack
// (migrations 0001-0003). The recorder runs for every test (setup file); the
// Trigger.dev call is the only mock.

const trigger = vi.hoisted(() => vi.fn());
vi.mock("@trigger.dev/sdk", () => ({ tasks: { trigger } }));

// The handlers run without a Next.js request scope, where after() throws.
// Tasks are queued here and runAfterTasks() runs them, as Next does once the
// response has been sent.
const afterTasks = vi.hoisted(() => [] as (() => unknown)[]);
vi.mock("next/server", () => ({
  after: (task: (() => unknown) | Promise<unknown>) => {
    afterTasks.push(typeof task === "function" ? task : () => task);
  },
}));
async function runAfterTasks(): Promise<void> {
  while (afterTasks.length > 0) await Promise.all(afterTasks.splice(0).map((task) => task()));
}

const TOKEN = "Token0".repeat(6);
const WRONG = "Wrong0".repeat(6);
const BASE = "http://localhost/api";
const MARKER_NAME = "Marker-Name-Zq7731";
const MARKER_EMAIL = "marker.zq7731@example.test";
const MARKER_TITLE = "Marker-Title-Zq7731";

let full: RestStack | undefined;
let db: ReturnType<typeof clientFor> | undefined;
const sql = (): NonNullable<typeof db> => {
  if (!db) throw new Error("database client not connected");
  return db;
};
const stack = (): RestStack => {
  if (!full) throw new Error("stack not started");
  return full;
};

type Handlers = {
  ticket: typeof import("../src/app/api/internal/tickets/[id]/route");
  testTickets: typeof import("../src/app/api/internal/test-tickets/route");
  usage: typeof import("../src/app/api/internal/usage/route");
  events: typeof import("../src/app/api/internal/security-events/route");
  health: typeof import("../src/app/api/health/config/route");
};

/**
 * Fresh module graph per call: the routes read env at import and the health
 * route keeps a 60 s probe cache in module state, so a reset gives each test
 * an empty cache and its own env.
 */
async function load(target: RestStack, e2eMode: boolean): Promise<Handlers> {
  vi.resetModules();
  vi.stubEnv("NEXT_PHASE", undefined);
  vi.stubEnv("SUPABASE_URL", target.url);
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", target.serviceRoleKey);
  vi.stubEnv("SUPABASE_DB_SCHEMA", "itsupport");
  vi.stubEnv("TRIGGER_SECRET_KEY", "fake-trigger-secret");
  vi.stubEnv("ADMIN_HEALTH_TOKEN", "fake-admin-health-token");
  vi.stubEnv("APP_VERSION", "1.0.0-test");
  vi.stubEnv("TURNSTILE_SECRET_KEY", "fake-turnstile-secret-key");
  vi.stubEnv("TURNSTILE_SITE_KEY", "fake-turnstile-site-key");
  vi.stubEnv("INTERNAL_API_TOKEN", TOKEN);
  vi.stubEnv("E2E_MODE", e2eMode ? "true" : "false");
  return {
    ticket: await import("../src/app/api/internal/tickets/[id]/route"),
    testTickets: await import("../src/app/api/internal/test-tickets/route"),
    usage: await import("../src/app/api/internal/usage/route"),
    events: await import("../src/app/api/internal/security-events/route"),
    health: await import("../src/app/api/health/config/route"),
  };
}

const authed = { authorization: `Bearer ${TOKEN}` };
const get = (path: string, headers: Record<string, string> = {}) =>
  new Request(`${BASE}${path}`, { headers });
const post = (path: string, body: unknown, headers: Record<string, string> = authed) =>
  new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const idContext = (id: string) => ({ params: Promise.resolve({ id }) });
const aMinuteAgo = () => encodeURIComponent(new Date(Date.now() - 60_000).toISOString());
const thisMonth = () => new Date().toISOString().slice(0, 7);

const RPC_PATH = "/rest/v1/rpc/security_event_record";
// PostgREST's answer when no pooled connection frees up in time (load).
const POOL_TIMEOUT_BODY = JSON.stringify({
  code: "PGRST003",
  details: null,
  hint: null,
  message: "Timed out acquiring connection from connection pool.",
});

/**
 * Wraps fetch (supabase-js looks it up per call): the first
 * security_event_record call for each sample path in `faultPaths` gets
 * PostgREST's pool-timeout 504 without reaching the stack; a later call for the
 * same path, and every other request, goes to the REST stack as usual.
 */
function failFirstWrites(faultPaths: ReadonlySet<string>) {
  const realFetch = globalThis.fetch;
  const faulted = new Set<string>();
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (new URL(url).pathname === RPC_PATH && typeof init?.body === "string") {
      const { p_sample } = JSON.parse(init.body) as { p_sample?: { path?: string } };
      const path = p_sample?.path ?? "";
      if (faultPaths.has(path) && !faulted.has(path)) {
        faulted.add(path);
        return new Response(POOL_TIMEOUT_BODY, {
          status: 504,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
    }
    return realFetch(input, init);
  });
  return { faults: () => faulted.size, restore: () => spy.mockRestore() };
}

const FLOOD_REQUESTS = 1000;
const FLOOD_WRITERS = 20;

/**
 * Sends one wrong-token request per ID, at most FLOOD_WRITERS in flight (the
 * live T3.S.07 shape), then runs the after() tasks. Returns the statuses.
 */
async function flood(app: Handlers, ids: readonly string[]): Promise<number[]> {
  const statuses: number[] = [];
  let next = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  async function writer(): Promise<void> {
    while (next < ids.length) {
      const id = ids[next] ?? "";
      next += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const response = await app.ticket.GET(
        get(`/internal/tickets/${id}`, { authorization: `Bearer ${WRONG}` }),
        idContext(id),
      );
      inFlight -= 1;
      statuses.push(response.status);
    }
  }
  await Promise.all(Array.from({ length: FLOOD_WRITERS }, writer));
  expect(maxInFlight).toBe(FLOOD_WRITERS);
  await runAfterTasks();
  return statuses;
}

async function securityRows(kind?: string) {
  const { rows } = await sql().query<{ source: string; kind: string; count: number }>(
    `select source, kind, count from itsupport.security_events ${kind ? "where kind = $1" : ""} order by kind`,
    kind ? [kind] : [],
  );
  return rows;
}

beforeAll(async () => {
  full = await startRestStack();
  db = clientFor(full.pg);
  await db.connect();
});

afterEach(() => {
  vi.unstubAllEnvs();
  trigger.mockReset();
});

afterAll(async () => {
  await db?.end().catch(() => undefined);
  await removeRestStack(full);
});

describe("auth boundary with E2E_MODE=false (T3.S.02, local half)", () => {
  it("answers 401 without a token and with a wrong token, and 404 on the disabled test route", async () => {
    await sql().query("truncate itsupport.security_events");
    const app = await load(stack(), false);
    const id = crypto.randomUUID();

    const none = await app.ticket.GET(get(`/internal/tickets/${id}`), idContext(id));
    expect(none.status).toBe(401);
    const wrong = await app.ticket.GET(
      get(`/internal/tickets/${id}`, { authorization: `Bearer ${WRONG}` }),
      idContext(id),
    );
    expect(wrong.status).toBe(401);
    const disabled = await app.testTickets.POST(post("/internal/test-tickets", { testId: "x" }));
    expect(disabled.status).toBe(404);
    expect(trigger).not.toHaveBeenCalled();

    expect((await securityRows()).map((row) => [row.source, row.kind, row.count])).toEqual([
      ["internal_api", "bad_token", 1],
      ["internal_api", "missing_token", 1],
      ["internal_api", "test_tickets_disabled", 1],
    ]);

    const listed = await app.events.GET(
      get(`/internal/security-events?since=${aMinuteAgo()}`, authed),
    );
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { events: { source: string; kind: string }[] };
    expect(body.events.map((event) => `${event.source}/${event.kind}`).sort()).toEqual([
      "internal_api/bad_token",
      "internal_api/missing_token",
      "internal_api/test_tickets_disabled",
    ]);
    expect(Object.keys(body.events[0] ?? {}).sort()).toEqual([
      "count",
      "kind",
      "source",
      "windowStart",
    ]);
  });

  it("folds a burst of 50 wrong-token requests into at most 2 rows that add up to 50", async () => {
    await sql().query("truncate itsupport.security_events");
    const app = await load(stack(), false);
    const id = crypto.randomUUID();

    const responses = await Promise.all(
      Array.from({ length: 50 }, () =>
        app.ticket.GET(
          get(`/internal/tickets/${id}`, { authorization: `Bearer ${WRONG}` }),
          idContext(id),
        ),
      ),
    );
    expect(responses.every((response) => response.status === 401)).toBe(true);

    const rows = await securityRows("bad_token");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.length).toBeLessThanOrEqual(2); // a minute boundary may split the burst
    expect(rows.reduce((sum, row) => sum + row.count, 0)).toBe(50);
  });
});

describe("security-event counts under load (P3-T1b, live T3.S.07 shape)", () => {
  // With msw (the egress recorder) on, about a thousand interleaved fetch and
  // node:http requests crash the Windows test worker natively (exit
  // 0xC0000409; reproduced without Docker on Node 24, msw 2.15.0). The
  // recorder passes 127.0.0.1 through unrecorded and these tests make no other
  // request, so it pauses for this block only. The pooled keep-alive sockets
  // opened while it was on are dropped too: reusing them still crashed.
  beforeAll(() => {
    egress.stop();
    globalAgent.destroy();
  });
  afterAll(() => egress.start());

  const sumOf = (rows: { count: number }[]) => rows.reduce((sum, row) => sum + row.count, 0);
  const newIds = () => Array.from({ length: FLOOD_REQUESTS }, () => crypto.randomUUID());

  it("counts 1000 wrong-token requests from 20 concurrent writers exactly", async () => {
    await sql().query("truncate itsupport.security_events");
    const app = await load(stack(), false);

    const statuses = await flood(app, newIds());

    expect(statuses.filter((status) => status === 401)).toHaveLength(FLOOD_REQUESTS);
    expect(sumOf(await securityRows("bad_token"))).toBe(FLOOD_REQUESTS);
  });

  it("keeps the exact count when the REST API times out the first write of 25 events", async () => {
    await sql().query("truncate itsupport.security_events");
    const ids = newIds();
    const faultPaths = new Set(
      ids.filter((_, i) => i % 40 === 0).map((id) => `/api/internal/tickets/${id}`),
    );
    const writes = failFirstWrites(faultPaths);
    const logError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const app = await load(stack(), false);

      const statuses = await flood(app, ids);

      expect(writes.faults()).toBe(25);
      expect(statuses.filter((status) => status === 401)).toHaveLength(FLOOD_REQUESTS);
      expect(sumOf(await securityRows("bad_token"))).toBe(FLOOD_REQUESTS);
    } finally {
      logError.mockRestore();
      writes.restore();
    }
  });
});

describe("privacy boundary with E2E_MODE=true", () => {
  it("creates a test ticket with canary text and keeps every canary and marker out of the views", async () => {
    await sql().query("truncate itsupport.security_events");
    const app = await load(stack(), true);
    trigger.mockResolvedValue({ id: "run_1" });
    const canaries = buildCanaries(egress.runId).map((canary) => canary.value);
    const forbidden = [...canaries, MARKER_NAME, MARKER_EMAIL, MARKER_TITLE];
    for (const value of forbidden) egress.forbid(value);

    const created = await app.testTickets.POST(
      post("/internal/test-tickets", {
        testId: `canary-${egress.runId}`,
        name: MARKER_NAME,
        email: MARKER_EMAIL,
        department: "Finance",
        title: MARKER_TITLE,
        description: canaryTicketText(egress.runId),
      }),
    );
    expect(created.status).toBe(201);
    const { ticketId, queued } = (await created.json()) as { ticketId: string; queued: boolean };
    expect(queued).toBe(true);
    expect(trigger).toHaveBeenCalledTimes(1);

    // The row holds the raw text (that is the point of the test), so the
    // check below is on what the internal API returns.
    const stored = await sql().query<{ raw_description: string; is_test: boolean }>(
      "select raw_description, is_test from itsupport.tickets where id = $1",
      [ticketId],
    );
    expect(stored.rows[0]?.is_test).toBe(true);
    expect(stored.rows[0]?.raw_description).toContain(canaries[0]);

    const view = await app.ticket.GET(
      get(`/internal/tickets/${ticketId}`, authed),
      idContext(ticketId),
    );
    expect(view.status).toBe(200);
    const viewText = await view.text();
    const parsed = JSON.parse(viewText) as {
      status: string;
      isTest: boolean;
      events: { type: string }[];
    };
    expect(parsed.status).toBe("new");
    expect(parsed.isTest).toBe(true);
    expect(parsed.events.map((event) => event.type)).toEqual(["received"]);

    const usage = await app.usage.GET(get(`/internal/usage?month=${thisMonth()}`, authed));
    expect(usage.status).toBe(200);
    const events = await app.events.GET(
      get(`/internal/security-events?since=${aMinuteAgo()}`, authed),
    );
    expect(events.status).toBe(200);

    for (const text of [viewText, await usage.text(), await events.text()]) {
      for (const value of forbidden) expect(text).not.toContain(value);
    }
  });
});

describe("usage", () => {
  it("returns zeros for the current month on an empty ai_calls table", async () => {
    const calls = await sql().query<{ n: string }>("select count(*) as n from itsupport.ai_calls");
    expect(calls.rows[0]?.n).toBe("0");
    const app = await load(stack(), false);

    const res = await app.usage.GET(get(`/internal/usage?month=${thisMonth()}`, authed));
    expect(res.status).toBe(200);
    const zero = { calls: 0, tokensIn: 0, tokensOut: 0, costUsd: null };
    expect(await res.json()).toEqual({ month: thisMonth(), llm: zero, typesafe: zero });
  });
});

describe("health config", () => {
  type Health = { features: { database: boolean; migration0003: boolean } };

  it("reports migration0003 true on the full stack", async () => {
    const app = await load(stack(), false); // fresh module: empty probe cache
    const body = (await (await app.health.GET()).json()) as Health;
    expect(body.features.database).toBe(true);
    expect(body.features.migration0003).toBe(true);
  });

  it("reports migration0003 false on a stack with only 0001 and 0002", async () => {
    const old = await startRestStack(180_000, MIGRATIONS.slice(0, 2));
    try {
      const app = await load(old, false); // fresh module: the full stack's cache is gone
      const body = (await (await app.health.GET()).json()) as Health;
      expect(body.features.database).toBe(true);
      expect(body.features.migration0003).toBe(false);
    } finally {
      await removeRestStack(old);
    }
  });
});
