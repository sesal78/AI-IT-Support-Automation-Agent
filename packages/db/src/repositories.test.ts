import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDbClient } from "./client.js";
import { DbError } from "./errors.js";
import { createRepositories, type NewTicket } from "./repositories.js";

const SECRET_KEY = "test-service-role-key";
const client = createDbClient({
  SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_SERVICE_ROLE_KEY: SECRET_KEY,
  SUPABASE_DB_SCHEMA: "itsupport",
});
const repos = createRepositories(client);

const ticketId = randomUUID();
const now = "2026-09-29T10:00:00.123456+00:00";
const RAW_DESCRIPTION = "My SSN is 123-45-6789 and VPN is down";

const newTicket: NewTicket = {
  source: "web",
  raw_title: "VPN down",
  raw_description: RAW_DESCRIPTION,
  requester_email: "demo.user@example.test",
  requester_name: "Demo User",
  department: "Finance",
  idempotency_key: "key-1",
};

const ticketRow = {
  id: ticketId,
  ...newTicket,
  status: "new",
  servicenow_sys_id: null,
  servicenow_number: null,
  is_test: false,
  created_at: now,
};
const eventRow = { id: 7, ticket_id: ticketId, type: "received", payload: { a: 1 }, at: now };
const redactionRow = {
  ticket_id: ticketId,
  redacted_title: "VPN down",
  redacted_description: "My SSN is [REDACTED_SSN] and VPN is down",
  redaction_log: [{ type: "SSN", count: 1 }],
  created_at: now,
};
const triageRow = {
  ticket_id: ticketId,
  sensitive: true,
  sensitive_flags: ["termination"],
  checker: "keywords+typesafe",
  created_at: now,
};

interface Captured {
  method: string;
  url: URL;
  headers: Headers;
  body: unknown;
}

/** Stubs global fetch (used lazily by supabase-js) with queued PostgREST responses. */
function respond(...responses: Response[]): Captured[] {
  const calls: Captured[] = [];
  vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
    calls.push({
      method: init.method ?? "GET",
      url: new URL(String(input)),
      headers: new Headers(init.headers),
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    return next;
  });
  return calls;
}

const ok = (body: unknown, status = 200): Response => Response.json(body, { status });
// PostgREST error body. `details` may carry row values; they must not leak.
const pgError = (code: string, status = 400): Response =>
  Response.json(
    {
      code,
      message: `boom ${RAW_DESCRIPTION}`,
      details: `Key (x)=(${RAW_DESCRIPTION})`,
      hint: null,
    },
    { status },
  );

afterEach(() => {
  vi.unstubAllGlobals();
});

async function expectDbError(promise: Promise<unknown>, operation: string): Promise<DbError> {
  const error = await promise.then(
    () => {
      throw new Error(`${operation} did not throw`);
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(DbError);
  const dbError = error as DbError;
  expect(dbError.name).toBe("DbError");
  expect(dbError.operation).toBe(operation);
  expect(dbError.message).toContain(operation);
  expect(dbError.message).not.toContain(RAW_DESCRIPTION);
  expect(dbError.message).not.toContain(SECRET_KEY);
  return dbError;
}

describe("DbError on a Supabase error response", () => {
  const cases: Array<[string, () => Promise<unknown>]> = [
    ["createTicket", () => repos.createTicket(newTicket)],
    ["getTicket", () => repos.getTicket(ticketId)],
    ["addEvent", () => repos.addEvent(ticketId, "received", {})],
    [
      "saveRedaction",
      () =>
        repos.saveRedaction({
          ticket_id: ticketId,
          redacted_title: "t",
          redacted_description: "d",
          redaction_log: [],
        }),
    ],
    [
      "saveTriage",
      () =>
        repos.saveTriage({
          ticket_id: ticketId,
          sensitive: false,
          sensitive_flags: [],
          checker: "keywords",
        }),
    ],
  ];

  it.each(cases)("%s throws DbError naming the operation and the error code", async (op, run) => {
    respond(pgError("XX000", 500));
    const error = await expectDbError(run(), op);
    expect(error.code).toBe("XX000");
    expect(error.message).toContain("XX000");
  });

  it.each(cases)(
    "%s throws DbError when the response does not match the schema",
    async (op, run) => {
      respond(ok({ id: 42, unexpected: RAW_DESCRIPTION }), ok({ id: 42 }));
      const error = await expectDbError(run(), op);
      expect(error.code).toBeUndefined();
      expect(error.message).toMatch(/unexpected response/);
    },
  );

  // A write, because supabase-js retries idempotent reads with a backoff first.
  it("throws DbError on a network failure", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    await expectDbError(repos.addEvent(ticketId, "received"), "addEvent");
  });
});

describe("createTicket", () => {
  it("inserts the ticket and returns created: true", async () => {
    const calls = respond(ok(ticketRow, 201));

    const result = await repos.createTicket(newTicket);

    expect(result).toEqual({ ticket: ticketRow, created: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url.pathname).toBe("/rest/v1/tickets");
    expect(calls[0]?.body).toEqual(newTicket);
  });

  it("on a duplicate idempotency key returns the existing row with created: false", async () => {
    const calls = respond(pgError("23505", 409), ok(ticketRow));

    const result = await repos.createTicket(newTicket);

    expect(result).toEqual({ ticket: ticketRow, created: false });
    expect(calls[1]?.method).toBe("GET");
    expect(calls[1]?.url.searchParams.get("idempotency_key")).toBe("eq.key-1");
  });

  it("throws DbError when the existing row cannot be read back", async () => {
    respond(pgError("23505", 409), pgError("PGRST116", 406));
    const error = await expectDbError(repos.createTicket(newTicket), "createTicket");
    expect(error.code).toBe("PGRST116");
  });
});

describe("getTicket", () => {
  it("returns the parsed ticket", async () => {
    const calls = respond(ok(ticketRow));
    expect(await repos.getTicket(ticketId)).toEqual(ticketRow);
    expect(calls[0]?.url.searchParams.get("id")).toBe(`eq.${ticketId}`);
  });

  it("returns null when no ticket has that id", async () => {
    respond(ok(null));
    expect(await repos.getTicket(ticketId)).toBeNull();
  });
});

describe("addEvent", () => {
  it("inserts the event and returns it", async () => {
    const calls = respond(ok(eventRow, 201));
    expect(await repos.addEvent(ticketId, "received", { a: 1 })).toEqual(eventRow);
    expect(calls[0]?.url.pathname).toBe("/rest/v1/ticket_events");
    expect(calls[0]?.body).toEqual({ ticket_id: ticketId, type: "received", payload: { a: 1 } });
  });

  it("stores an empty payload when none is given", async () => {
    const calls = respond(ok({ ...eventRow, payload: {} }, 201));
    await repos.addEvent(ticketId, "received");
    expect(calls[0]?.body).toEqual({ ticket_id: ticketId, type: "received", payload: {} });
  });
});

describe("saveRedaction and saveTriage", () => {
  it("saveRedaction upserts by ticket_id", async () => {
    const calls = respond(ok(redactionRow, 201));
    const input = {
      ticket_id: redactionRow.ticket_id,
      redacted_title: redactionRow.redacted_title,
      redacted_description: redactionRow.redacted_description,
      redaction_log: redactionRow.redaction_log,
    };
    expect(await repos.saveRedaction(input)).toEqual(redactionRow);
    expect(calls[0]?.url.pathname).toBe("/rest/v1/ticket_redactions");
    expect(calls[0]?.url.searchParams.get("on_conflict")).toBe("ticket_id");
    expect(calls[0]?.headers.get("prefer")).toContain("resolution=merge-duplicates");
  });

  it("saveTriage upserts by ticket_id", async () => {
    const calls = respond(ok(triageRow, 201));
    const input = {
      ticket_id: triageRow.ticket_id,
      sensitive: triageRow.sensitive,
      sensitive_flags: triageRow.sensitive_flags,
      checker: triageRow.checker,
    };
    expect(await repos.saveTriage(input)).toEqual(triageRow);
    expect(calls[0]?.url.pathname).toBe("/rest/v1/triage_results");
    expect(calls[0]?.url.searchParams.get("on_conflict")).toBe("ticket_id");
    expect(calls[0]?.headers.get("prefer")).toContain("resolution=merge-duplicates");
    expect(calls[0]?.body).toEqual(input);
  });
});

describe("recordSecurityEvent", () => {
  it("calls the security_event_record RPC with the source, kind and sample", async () => {
    const calls = respond(ok(1));
    await repos.recordSecurityEvent("internal_api", "bad_token", { path: "/x", method: "POST" });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url.pathname).toBe("/rest/v1/rpc/security_event_record");
    expect(calls[0]?.body).toEqual({
      p_source: "internal_api",
      p_kind: "bad_token",
      p_sample: { path: "/x", method: "POST" },
    });
  });

  it("throws DbError naming the operation and the code, without Supabase text", async () => {
    respond(pgError("22023"));
    const error = await expectDbError(
      repos.recordSecurityEvent("internal_api", "bad_token", {}),
      "recordSecurityEvent",
    );
    expect(error.code).toBe("22023");
  });
});

describe("probeSchema", () => {
  const tableOf = (call: Captured | undefined) => call?.url.pathname.split("/").pop();

  it("reports both true when every probe succeeds, selecting only one row", async () => {
    const calls = respond(ok([]), ok([]), ok([]), ok([]), ok([]));
    expect(await repos.probeSchema()).toEqual({ database: true, migration0003: true });
    expect(calls.map(tableOf).sort()).toEqual(
      ["ai_calls", "kb_articles", "security_events", "tickets", "tickets"].sort(),
    );
    expect(calls.some((c) => c.url.searchParams.get("select") === "is_test")).toBe(true);
    for (const call of calls) expect(call.url.searchParams.get("limit")).toBe("1");
  });

  it("reports migration0003 false when one migration probe fails", async () => {
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = new URL(String(input));
      return url.pathname.endsWith("/kb_articles") ? pgError("42P01", 404) : ok([]);
    });
    expect(await repos.probeSchema()).toEqual({ database: true, migration0003: false });
  });

  it("reports migration0003 false when tickets.is_test is missing", async () => {
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = new URL(String(input));
      return url.searchParams.get("select") === "is_test" ? pgError("42703") : ok([]);
    });
    expect(await repos.probeSchema()).toEqual({ database: true, migration0003: false });
  });

  it("reports both false, without throwing, when the database is unreachable", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError(`fetch failed ${RAW_DESCRIPTION}`);
    });
    expect(await repos.probeSchema()).toEqual({ database: false, migration0003: false });
  });

  it("reports both false on a Supabase error for the tickets probe", async () => {
    vi.stubGlobal("fetch", async () => pgError("28000", 401));
    expect(await repos.probeSchema()).toEqual({ database: false, migration0003: false });
  });

  it("times out a hanging probe and counts it as false", async () => {
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    const started = Date.now();
    expect(await repos.probeSchema(50)).toEqual({ database: false, migration0003: false });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("searchKb", () => {
  const hit = {
    id: randomUUID(),
    slug: "vpn-reset",
    title: "Reset the VPN client",
    content: "Steps to reset the VPN client.",
    category: "network",
    assignment_group: "Network Support",
    rank: 0.0607927,
  };

  it("calls the kb_search RPC with the query and the default limit of 5", async () => {
    const calls = respond(ok([hit]));
    expect(await repos.searchKb("vpn or home")).toEqual([hit]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url.pathname).toBe("/rest/v1/rpc/kb_search");
    expect(calls[0]?.body).toEqual({ p_query: "vpn or home", p_limit: 5 });
  });

  it("returns an empty array for no rows", async () => {
    respond(ok([]));
    expect(await repos.searchKb("vpn")).toEqual([]);
  });

  it.each(["", "   ", "\t\n"])("returns [] without a database call for %j", async (query) => {
    const calls = respond();
    expect(await repos.searchKb(query)).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it.each([
    [0, 1],
    [-3, 1],
    [1, 1],
    [20, 20],
    [1000, 20],
  ])("clamps the limit %s to %s, as the RPC does", async (limit, sent) => {
    const calls = respond(ok([]));
    await repos.searchKb("vpn", limit);
    expect((calls[0]?.body as { p_limit: number }).p_limit).toBe(sent);
  });

  it.each([1.5, Number.NaN, Number.POSITIVE_INFINITY, "5", null])(
    "throws a RangeError for the limit %s and makes no call",
    async (limit) => {
      const calls = respond();
      await expect(repos.searchKb("vpn", limit as never)).rejects.toThrow(RangeError);
      expect(calls).toHaveLength(0);
    },
  );

  it.each([undefined, null, 42, ["vpn"]])("throws a TypeError for the query %s", async (query) => {
    const calls = respond();
    await expect(repos.searchKb(query as never)).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });

  it("throws DbError on a Supabase error, without the query text", async () => {
    respond(pgError("XX000", 500));
    const error = await expectDbError(repos.searchKb("vpn"), "searchKb");
    expect(error.code).toBe("XX000");
  });

  it("throws DbError when a row has an unexpected shape", async () => {
    respond(ok([{ ...hit, rank: "high" }]));
    const error = await expectDbError(repos.searchKb("vpn"), "searchKb");
    expect(error.message).toContain("unexpected response shape");
  });
});

describe("getTicketView", () => {
  const RAW = {
    raw_title: "t".repeat(20),
    raw_description: "d".repeat(20),
    requester_email: "e".repeat(20),
    requester_name: "n".repeat(20),
    department: "p".repeat(20),
  };
  const viewTicket = {
    id: ticketId,
    status: "triaged",
    is_test: false,
    source: "web",
    created_at: now,
  };
  const viewTriage = {
    sensitive: false,
    sensitive_flags: [],
    category: "network",
    subcategory: null,
    priority: "P3",
    urgency: "medium",
    assignment_group: "Network",
    route: "auto",
    flags: null,
    probabilities: { network: 0.9 },
    grounding_score: 0.8,
    kb_article_ids: [ticketId],
    suggested_fix: null,
    model_versions: { llm: "v1" },
    triaged_at: now,
  };

  /** Routes each PostgREST request to a body by table name. */
  function database(bodies: Record<string, Response | (() => Response)>): Captured[] {
    const calls: Captured[] = [];
    vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      calls.push({
        method: init.method ?? "GET",
        url,
        headers: new Headers(init.headers),
        body: undefined,
      });
      const body = bodies[url.pathname.split("/").pop() ?? ""];
      if (!body) throw new Error("unexpected request");
      return typeof body === "function" ? body() : body.clone();
    });
    return calls;
  }
  const full = () => ({
    tickets: ok({ ...viewTicket, ...RAW }),
    ticket_redactions: ok({ redacted_title: "VPN down", redacted_description: "gone", ...RAW }),
    triage_results: ok(viewTriage),
    ai_calls: new Response(null, { status: 200, headers: { "content-range": "*/3" } }),
    ticket_events: ok([
      { type: "received", at: now, payload: { m: "x".repeat(20) } },
      { type: "redacted", at: "2026-09-29T10:01:00+00:00" },
    ]),
  });

  it("selects named columns only, never a raw column", async () => {
    const calls = database(full());
    await repos.getTicketView(ticketId);
    expect(calls.length).toBe(5);
    for (const call of calls) {
      const columns = (call.url.searchParams.get("select") ?? "").split(",");
      for (const raw of Object.keys(RAW)) expect(columns).not.toContain(raw);
      expect(columns).not.toContain("payload");
      expect(call.url.searchParams.get("select")).not.toBe("*");
      expect(call.url.searchParams.get("select")).not.toBe(null);
    }
    const tickets = calls.find((c) => c.url.pathname.endsWith("/tickets"));
    expect(tickets?.url.searchParams.get("select")).toBe("id,status,is_test,source,created_at");
  });

  it("maps the rows and drops any column the database returns beyond the ones asked for", async () => {
    database(full());
    const view = await repos.getTicketView(ticketId);
    expect(view).toMatchObject({
      id: ticketId,
      status: "triaged",
      isTest: false,
      redacted: { title: "VPN down", description: "gone" },
      aiCallCount: 3,
      events: [
        { type: "received", at: now },
        { type: "redacted", at: "2026-09-29T10:01:00+00:00" },
      ],
      reviews: [],
      notifications: [],
      autofix: [],
    });
    expect(view?.triage).toMatchObject({
      assignmentGroup: "Network",
      flags: [],
      groundingScore: 0.8,
    });
    const text = JSON.stringify(view);
    for (const marker of [...Object.values(RAW), "x".repeat(20)])
      expect(text).not.toContain(marker);
    for (const event of view?.events ?? [])
      expect(Object.keys(event).sort()).toEqual(["at", "type"]);
  });

  it("returns null redaction and triage, zero calls and no events for a bare ticket", async () => {
    database({
      ...full(),
      ticket_redactions: ok(null, 200),
      triage_results: ok(null, 200),
      ai_calls: new Response(null, { status: 200, headers: { "content-range": "*/0" } }),
      ticket_events: ok([]),
    });
    expect(await repos.getTicketView(ticketId)).toMatchObject({
      redacted: null,
      triage: null,
      aiCallCount: 0,
      events: [],
    });
  });

  it("returns null for an unknown ticket and reads nothing else", async () => {
    const calls = database({ tickets: ok(null, 200) });
    expect(await repos.getTicketView(ticketId)).toBeNull();
    expect(calls.length).toBe(1);
  });

  it("asks for events oldest first", async () => {
    const calls = database(full());
    await repos.getTicketView(ticketId);
    const events = calls.find((c) => c.url.pathname.endsWith("/ticket_events"));
    expect(events?.url.searchParams.get("order")).toBe("at.asc,id.asc");
  });

  it("throws DbError without row values when a query fails", async () => {
    database({ ...full(), triage_results: pgError("42P01", 404) });
    await expectDbError(repos.getTicketView(ticketId), "getTicketView");
  });

  it("throws DbError when the ai_calls count fails", async () => {
    database({ ...full(), ai_calls: pgError("42501", 403) });
    await expectDbError(repos.getTicketView(ticketId), "getTicketView");
  });
});

describe("getAiUsage", () => {
  it("calls the RPC with the month start and maps both providers", async () => {
    const calls = respond(
      ok([
        { provider: "llm", calls: 12, tokens_in: 1200, tokens_out: 600, cost_usd: null },
        { provider: "typesafe", calls: "340", tokens_in: null, tokens_out: 5, cost_usd: 1.5 },
      ]),
    );
    expect(await repos.getAiUsage("2026-10-01")).toEqual({
      llm: { calls: 12, tokensIn: 1200, tokensOut: 600, costUsd: null },
      typesafe: { calls: 340, tokensIn: 0, tokensOut: 5, costUsd: 1.5 },
    });
    expect(calls[0]?.url.pathname.endsWith("/rpc/ai_usage_month")).toBe(true);
    expect(calls[0]?.body).toEqual({ p_month_start: "2026-10-01" });
  });

  it("returns zeros and a null cost for a month without rows", async () => {
    respond(ok([]));
    const zero = { calls: 0, tokensIn: 0, tokensOut: 0, costUsd: null };
    expect(await repos.getAiUsage("2026-10-01")).toEqual({ llm: zero, typesafe: zero });
  });

  it("throws DbError on a Supabase error and on a malformed month, without a request", async () => {
    respond(pgError("42883", 404));
    await expectDbError(repos.getAiUsage("2026-10-01"), "getAiUsage");
    const calls = respond();
    await expectDbError(repos.getAiUsage("2026-10"), "getAiUsage");
    expect(calls.length).toBe(0);
  });
});

describe("listSecurityEvents", () => {
  const row = (id: number) => ({
    source: "internal_api",
    kind: "bad_token",
    window_start: `2026-10-0${id}T10:00:00+00:00`,
    count: id,
    sample: { path: "m".repeat(20) },
  });
  const since = new Date("2026-10-01T00:00:00.000Z");

  it("selects named columns, filters, orders newest first and maps the rows", async () => {
    const calls = respond(ok([row(3), row(2)]));
    const events = await repos.listSecurityEvents(since, 50);
    const params = calls[0]?.url.searchParams;
    expect(params?.get("select")).toBe("source,kind,window_start,count");
    expect(params?.get("window_start")).toBe("gte.2026-10-01T00:00:00.000Z");
    expect(params?.get("order")).toBe("window_start.desc,id.desc");
    expect(params?.get("limit")).toBe("50");
    expect(events).toEqual([
      {
        source: "internal_api",
        kind: "bad_token",
        windowStart: "2026-10-03T10:00:00.000Z",
        count: 3,
      },
      {
        source: "internal_api",
        kind: "bad_token",
        windowStart: "2026-10-02T10:00:00.000Z",
        count: 2,
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("m".repeat(20));
  });

  it.each([
    [0, "1"],
    [-5, "1"],
    [600, "500"],
    [7.9, "7"],
    [Number.NaN, "500"],
    [Infinity, "500"],
  ])("clamps limit %s to %s", async (limit, expected) => {
    const calls = respond(ok([]));
    await repos.listSecurityEvents(since, limit);
    expect(calls[0]?.url.searchParams.get("limit")).toBe(expected);
  });

  it("defaults the limit to 500 and throws DbError on a Supabase error", async () => {
    const calls = respond(ok([]));
    await repos.listSecurityEvents(since);
    expect(calls[0]?.url.searchParams.get("limit")).toBe("500");
    respond(pgError("42P01", 404));
    await expectDbError(repos.listSecurityEvents(since), "listSecurityEvents");
  });
});
