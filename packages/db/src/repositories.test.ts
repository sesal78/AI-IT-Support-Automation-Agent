import { randomUUID } from "node:crypto";
import { IllegalTransitionError, type TriageResult } from "@ai-it-support/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDbClient } from "./client.js";
import { DbError, StatusConflictError } from "./errors.js";
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

describe("listEventTypes", () => {
  it("selects only the type of the ticket's events of the given types, without duplicates", async () => {
    const calls = respond(
      ok([{ type: "kb_matched" }, { type: "kb_matched" }, { type: "triaged" }]),
    );
    expect(await repos.listEventTypes(ticketId, ["kb_matched", "triaged"])).toEqual([
      "kb_matched",
      "triaged",
    ]);
    expect(calls[0]?.url.pathname).toBe("/rest/v1/ticket_events");
    expect(calls[0]?.url.searchParams.get("select")).toBe("type");
    expect(calls[0]?.url.searchParams.get("ticket_id")).toBe(`eq.${ticketId}`);
    expect(calls[0]?.url.searchParams.get("type")).toBe("in.(kb_matched,triaged)");
  });

  it("returns [] for no types without a request", async () => {
    const calls = respond();
    expect(await repos.listEventTypes(ticketId, [])).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("throws DbError on a Supabase error", async () => {
    respond(pgError("XX000", 500));
    await expectDbError(repos.listEventTypes(ticketId, ["triaged"]), "listEventTypes");
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

describe("reserveAiCall", () => {
  const callId = randomUUID();
  const input = {
    provider: "llm",
    kind: "triage",
    calls: 3,
    capCalls: 2000,
    environment: "test",
    ticketId: ticketId,
  } as const;

  it("calls the ai_budget_reserve RPC with every argument and maps the row", async () => {
    const calls = respond(ok([{ allowed: true, used_calls: 1603, call_id: callId }]));
    expect(await repos.reserveAiCall(input)).toEqual({
      allowed: true,
      usedCalls: 1603,
      callId,
    });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url.pathname).toBe("/rest/v1/rpc/ai_budget_reserve");
    expect(calls[0]?.body).toEqual({
      p_provider: "llm",
      p_est_cost: null,
      p_est_calls: 3,
      p_cap_calls: 2000,
      p_environment: "test",
      p_kind: "triage",
      p_ticket_id: ticketId,
    });
  });

  it("sends a null ticket id and the estimated cost when given", async () => {
    const calls = respond(ok([{ allowed: true, used_calls: 1, call_id: callId }]));
    await repos.reserveAiCall({ ...input, ticketId: undefined, calls: 1, estCost: 0.5 });
    expect(calls[0]?.body).toMatchObject({ p_ticket_id: null, p_est_cost: 0.5 });
  });

  it("returns a refusal with a null call id", async () => {
    respond(ok([{ allowed: false, used_calls: 2000, call_id: null }]));
    expect(await repos.reserveAiCall(input)).toEqual({
      allowed: false,
      usedCalls: 2000,
      callId: null,
    });
  });

  it("throws DbError naming the operation and the code", async () => {
    respond(pgError("25001"));
    const error = await expectDbError(repos.reserveAiCall(input), "reserveAiCall");
    expect(error.code).toBe("25001");
  });

  it.each([
    ["no row", []],
    [
      "two rows",
      [
        { allowed: false, used_calls: 1, call_id: null },
        { allowed: false, used_calls: 1, call_id: null },
      ],
    ],
    ["allowed without a call id", [{ allowed: true, used_calls: 1, call_id: null }]],
    ["refused with a call id", [{ allowed: false, used_calls: 1, call_id: callId }]],
  ])("throws DbError on a bad response: %s", async (_name, body) => {
    respond(ok(body));
    await expectDbError(repos.reserveAiCall(input), "reserveAiCall");
  });

  it.each([
    ["calls 0", { calls: 0 }],
    ["calls 1.5", { calls: 1.5 }],
    ["calls NaN", { calls: Number.NaN }],
    ["calls above int32", { calls: 2 ** 31 }],
    ["cap -1", { capCalls: -1 }],
    ["cap 1.5", { capCalls: 1.5 }],
    ["cap above int32", { capCalls: 2 ** 31 }],
    ["provider other", { provider: "other" }],
  ])("rejects %s before any request", async (_name, patch) => {
    const calls = respond();
    await expect(repos.reserveAiCall({ ...input, ...patch } as never)).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });
});

describe("completeAiCall", () => {
  const callId = randomUUID();

  it("updates the tokens of the row with this id", async () => {
    const calls = respond(ok([{ id: callId }]));
    await repos.completeAiCall(callId, { tokensIn: 120, tokensOut: 30 });
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.url.pathname).toBe("/rest/v1/ai_calls");
    expect(calls[0]?.url.searchParams.get("id")).toBe(`eq.${callId}`);
    expect(calls[0]?.body).toEqual({ tokens_in: 120, tokens_out: 30 });
  });

  it("throws DbError when no row has this id", async () => {
    respond(ok([]));
    await expectDbError(
      repos.completeAiCall(callId, { tokensIn: 1, tokensOut: 1 }),
      "completeAiCall",
    );
  });

  it("throws DbError naming the operation and the code on a Supabase error", async () => {
    respond(pgError("22P02"));
    const error = await expectDbError(
      repos.completeAiCall("not-a-uuid", { tokensIn: 1, tokensOut: 1 }),
      "completeAiCall",
    );
    expect(error.code).toBe("22P02");
  });

  it.each([
    ["negative", -1, 0],
    ["NaN", 0, Number.NaN],
    ["fractional", 1.5, 0],
    ["Infinity", Number.POSITIVE_INFINITY, 0],
    ["above int32", 0, 2 ** 31],
  ])("rejects %s token counts before any request", async (_name, tokensIn, tokensOut) => {
    const calls = respond();
    await expect(repos.completeAiCall(callId, { tokensIn, tokensOut })).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });
});

describe("probeSchema", () => {
  const tableOf = (call: Captured | undefined) => call?.url.pathname.split("/").pop();

  it("reports both true when every probe succeeds, selecting only one row", async () => {
    const calls = respond(ok([]), ok([]), ok([]), ok([]), ok([]), ok([]));
    expect(await repos.probeSchema()).toEqual({
      database: true,
      migration0003: true,
      migration0005: true,
    });
    expect(calls.map(tableOf).sort()).toEqual(
      ["ai_calls", "kb_articles", "reviews", "security_events", "tickets", "tickets"].sort(),
    );
    expect(calls.some((c) => c.url.searchParams.get("select") === "is_test")).toBe(true);
    for (const call of calls) expect(call.url.searchParams.get("limit")).toBe("1");
  });

  it("reports migration0003 false when one migration probe fails", async () => {
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = new URL(String(input));
      return url.pathname.endsWith("/kb_articles") ? pgError("42P01", 404) : ok([]);
    });
    expect(await repos.probeSchema()).toEqual({
      database: true,
      migration0003: false,
      migration0005: true,
    });
  });

  it("reports migration0005 false, and the rest true, when only the reviews probe fails", async () => {
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = new URL(String(input));
      return url.pathname.endsWith("/reviews") ? pgError("42P01", 404) : ok([]);
    });
    expect(await repos.probeSchema()).toEqual({
      database: true,
      migration0003: true,
      migration0005: false,
    });
  });

  it("reports migration0003 false when tickets.is_test is missing", async () => {
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = new URL(String(input));
      return url.searchParams.get("select") === "is_test" ? pgError("42703") : ok([]);
    });
    expect(await repos.probeSchema()).toEqual({
      database: true,
      migration0003: false,
      migration0005: true,
    });
  });

  it("reports both false, without throwing, when the database is unreachable", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError(`fetch failed ${RAW_DESCRIPTION}`);
    });
    expect(await repos.probeSchema()).toEqual({
      database: false,
      migration0003: false,
      migration0005: false,
    });
  });

  it("reports both false on a Supabase error for the tickets probe", async () => {
    vi.stubGlobal("fetch", async () => pgError("28000", 401));
    expect(await repos.probeSchema()).toEqual({
      database: false,
      migration0003: false,
      migration0005: false,
    });
  });

  it("starts every probe after the tickets check at the same time", async () => {
    const started: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = new URL(String(input));
      started.push(`${url.pathname.split("/").pop()}:${url.searchParams.get("select")}`);
      // The first (tickets.id) probe answers at once; the rest wait until all five have started.
      if (started.length > 1) await gate;
      return ok([]);
    });
    const pending = repos.probeSchema();
    await vi.waitFor(() => expect(started).toHaveLength(6));
    release?.();
    expect(await pending).toEqual({ database: true, migration0003: true, migration0005: true });
    expect(started).toContain("reviews:id");
  });

  it("times out a hanging probe and counts it as false", async () => {
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    const started = Date.now();
    expect(await repos.probeSchema(50)).toEqual({
      database: false,
      migration0003: false,
      migration0005: false,
    });
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

describe("listKbArticles and upsertKbArticles", () => {
  const article = {
    slug: "vpn-reset",
    title: "Reset the VPN client",
    content: "Steps to reset the VPN client.",
    category: "network" as const,
    assignment_group: "Network" as const,
  };
  const row = { id: randomUUID(), ...article };

  it("lists the articles ordered by slug, with named columns", async () => {
    const calls = respond(ok([row]));
    expect(await repos.listKbArticles()).toEqual([row]);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url.pathname).toBe("/rest/v1/kb_articles");
    expect(calls[0]?.url.searchParams.get("select")).toBe(
      "id,slug,title,content,category,assignment_group",
    );
    expect(calls[0]?.url.searchParams.get("order")).toBe("slug.asc");
  });

  it("reads a stored row outside the seed length bounds", async () => {
    const short = { ...row, title: "x", content: "y" };
    respond(ok([short]));
    expect(await repos.listKbArticles()).toEqual([short]);
  });

  it("throws DbError on a read error, without row text", async () => {
    respond(pgError("XX000", 500));
    const error = await expectDbError(repos.listKbArticles(), "listKbArticles");
    expect(error.code).toBe("XX000");
  });

  it("upserts by slug in one request and returns the count", async () => {
    const calls = respond(ok([{ slug: article.slug }]));
    expect(await repos.upsertKbArticles([article])).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url.searchParams.get("on_conflict")).toBe("slug");
    expect(calls[0]?.headers.get("prefer")).toContain("resolution=merge-duplicates");
    expect(calls[0]?.body).toEqual([article]);
  });

  it("sends only the five article columns", async () => {
    const calls = respond(ok([{ slug: article.slug }]));
    await repos.upsertKbArticles([{ ...article, id: randomUUID() } as never]);
    expect(calls[0]?.body).toEqual([article]);
  });

  it("makes no request for an empty list", async () => {
    const calls = respond();
    expect(await repos.upsertKbArticles([])).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("throws DbError on a write error, without row text", async () => {
    respond(pgError("23514", 400));
    const error = await expectDbError(repos.upsertKbArticles([article]), "upsertKbArticles");
    expect(error.code).toBe("23514");
    expect(error.message).not.toContain(RAW_DESCRIPTION);
  });

  it("throws DbError when fewer rows come back than were sent", async () => {
    respond(ok([]));
    const error = await expectDbError(repos.upsertKbArticles([article]), "upsertKbArticles");
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
    reviews: ok([]),
  });

  it("selects named columns only, never a raw column", async () => {
    const calls = database(full());
    await repos.getTicketView(ticketId);
    expect(calls.length).toBe(6);
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

describe("setTicketStatus", () => {
  it("moves new -> redacted with one conditional update and returns changed: true", async () => {
    const calls = respond(ok({ status: "new" }), ok([{ id: ticketId }]));
    expect(await repos.setTicketStatus(ticketId, "redacted")).toEqual({ changed: true });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.method).toBe("PATCH");
    expect(calls[1]?.url.pathname).toBe("/rest/v1/tickets");
    expect(calls[1]?.url.searchParams.get("id")).toBe(`eq.${ticketId}`);
    expect(calls[1]?.url.searchParams.get("status")).toBe("eq.new");
    expect(calls[1]?.body).toEqual({ status: "redacted" });
  });

  it("returns changed: false with no update when the ticket is already in the target status", async () => {
    const calls = respond(ok({ status: "redacted" }));
    expect(await repos.setTicketStatus(ticketId, "redacted")).toEqual({ changed: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
  });

  it("throws IllegalTransitionError for new -> triaged before any update", async () => {
    const calls = respond(ok({ status: "new" }));
    await expect(repos.setTicketStatus(ticketId, "triaged")).rejects.toBeInstanceOf(
      IllegalTransitionError,
    );
    expect(calls).toHaveLength(1);
  });

  it("throws DbError for an unknown ticket", async () => {
    const calls = respond(ok(null));
    const error = await expectDbError(
      repos.setTicketStatus(ticketId, "redacted"),
      "setTicketStatus",
    );
    expect(error).not.toBeInstanceOf(StatusConflictError);
    expect(calls).toHaveLength(1);
  });

  it("throws StatusConflictError when the status changed to another one in between", async () => {
    respond(ok({ status: "new" }), ok([]), ok({ status: "failed" }));
    const error = await repos
      .setTicketStatus(ticketId, "redacted")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StatusConflictError);
    expect(error).toBeInstanceOf(DbError);
    expect(error).toMatchObject({ name: "StatusConflictError", operation: "setTicketStatus" });
  });

  it("returns changed: false when a parallel caller already made the same move", async () => {
    respond(ok({ status: "redacted" }), ok([]), ok({ status: "triaged" }));
    expect(await repos.setTicketStatus(ticketId, "triaged")).toEqual({ changed: false });
  });

  it("throws DbError naming the code on a Supabase error", async () => {
    respond(ok({ status: "new" }), pgError("XX000", 500));
    const error = await expectDbError(
      repos.setTicketStatus(ticketId, "redacted"),
      "setTicketStatus",
    );
    expect(error.code).toBe("XX000");
  });
});

describe("saveTriageResult", () => {
  const kbId = randomUUID();
  const result: TriageResult = {
    category: "network",
    subcategory: "vpn",
    priority: "P3",
    urgency: "medium",
    assignmentGroup: "Network",
    route: "auto",
    probabilities: { network: 0.9 },
    flags: ["needs_info"],
    groundingScore: 0.5,
    kbArticleIds: [kbId],
    suggestedFix: { steps: ["restart"] },
    modelVersions: { llm: "m1" },
  };
  const columns = {
    category: "network",
    subcategory: "vpn",
    priority: "P3",
    urgency: "medium",
    assignment_group: "Network",
    route: "auto",
    probabilities: { network: 0.9 },
    flags: ["needs_info"],
    grounding_score: 0.5,
    kb_article_ids: [kbId],
    suggested_fix: { steps: ["restart"] },
    model_versions: { llm: "m1" },
  };
  const savedRow = { ...triageRow, ...columns, triaged_at: now };

  it("updates the 13 columns of the ticket's row and nothing else", async () => {
    const calls = respond(ok([savedRow]));
    expect(await repos.saveTriageResult(ticketId, result)).toEqual(savedRow);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.url.pathname).toBe("/rest/v1/triage_results");
    expect(calls[0]?.url.searchParams.get("ticket_id")).toBe(`eq.${ticketId}`);
    const body = calls[0]?.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([...Object.keys(columns), "triaged_at"].sort());
    expect(body).toMatchObject(columns);
    expect(Number.isNaN(Date.parse(String(body.triaged_at)))).toBe(false);
  });

  it("rejects an invalid result before any request, naming only the field path", async () => {
    const calls = respond();
    const bad = { ...result, category: `unknown ${RAW_DESCRIPTION}` } as unknown as TriageResult;
    const error = await repos.saveTriageResult(ticketId, bad).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toContain("category");
    expect((error as Error).message).not.toContain(RAW_DESCRIPTION);
    expect(calls).toHaveLength(0);
  });

  it("rejects an extra key before any request", async () => {
    const calls = respond();
    const bad = { ...result, sensitive: false } as unknown as TriageResult;
    await expect(repos.saveTriageResult(ticketId, bad)).rejects.toBeInstanceOf(TypeError);
    expect(calls).toHaveLength(0);
  });

  it("throws DbError when the ticket has no triage row", async () => {
    respond(ok([]));
    await expectDbError(repos.saveTriageResult(ticketId, result), "saveTriageResult");
  });
});

describe("getRedaction and getTriage", () => {
  it("getRedaction returns the row, and null when there is none", async () => {
    const calls = respond(ok(redactionRow), ok(null));
    expect(await repos.getRedaction(ticketId)).toEqual(redactionRow);
    expect(calls[0]?.url.pathname).toBe("/rest/v1/ticket_redactions");
    expect(calls[0]?.url.searchParams.get("ticket_id")).toBe(`eq.${ticketId}`);
    expect(await repos.getRedaction(ticketId)).toBeNull();
  });

  it("getTriage parses a phase-2 row whose new columns are all null", async () => {
    const phase2 = {
      ...triageRow,
      category: null,
      subcategory: null,
      priority: null,
      urgency: null,
      assignment_group: null,
      route: null,
      probabilities: null,
      flags: null,
      grounding_score: null,
      kb_article_ids: null,
      suggested_fix: null,
      model_versions: null,
      triaged_at: null,
    };
    const calls = respond(ok(phase2), ok(null));
    expect(await repos.getTriage(ticketId)).toEqual(phase2);
    expect(calls[0]?.url.pathname).toBe("/rest/v1/triage_results");
    expect(await repos.getTriage(ticketId)).toBeNull();
  });

  it("getTriage throws DbError on a Supabase error", async () => {
    respond(pgError("XX000", 500));
    await expectDbError(repos.getTriage(ticketId), "getTriage");
  });
});

describe("reviews", () => {
  const reviewId = randomUUID();
  const USER = "U0000000001";
  const TOKEN_MARKER = "wait-token-marker-123";
  const reviewRow = {
    id: reviewId,
    ticket_id: ticketId,
    kind: "triage",
    proposal_id: null,
    slack_user_id: null,
    decision: null,
    decided_at: null,
    wait_token_id: TOKEN_MARKER,
    slack_ts: null,
    created_at: now,
  };
  const decidedRow = { ...reviewRow, slack_user_id: USER, decision: "approve", decided_at: now };
  const selectOf = (call: Captured | undefined) => call?.url.searchParams.get("select");
  const COLUMNS =
    "id,ticket_id,kind,proposal_id,slack_user_id,decision,decided_at,wait_token_id,slack_ts,created_at";

  describe("createTriageReview", () => {
    it("inserts a triage review, selecting named columns", async () => {
      const calls = respond(ok(reviewRow, 201));
      const review = await repos.createTriageReview({ ticketId, waitTokenId: TOKEN_MARKER });
      expect(review).toEqual(reviewRow);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.method).toBe("POST");
      expect(calls[0]?.url.pathname).toBe("/rest/v1/reviews");
      expect(calls[0]?.body).toEqual({
        ticket_id: ticketId,
        kind: "triage",
        wait_token_id: TOKEN_MARKER,
      });
      expect(selectOf(calls[0])).toBe(COLUMNS);
    });

    it("returns the existing row on 23505 with a read that filters on ticket, kind and no proposal", async () => {
      const calls = respond(pgError("23505", 409), ok(reviewRow));
      const review = await repos.createTriageReview({ ticketId, waitTokenId: "second-token" });
      expect(review).toEqual(reviewRow);
      expect(calls).toHaveLength(2);
      expect(calls[1]?.method).toBe("GET");
      expect(calls[1]?.url.searchParams.get("ticket_id")).toBe(`eq.${ticketId}`);
      expect(calls[1]?.url.searchParams.get("kind")).toBe("eq.triage");
      expect(calls[1]?.url.searchParams.get("proposal_id")).toBe("is.null");
      expect(selectOf(calls[1])).toBe(COLUMNS);
    });

    it.each(["23503", "42501", "23514", "PGRST116"])(
      "throws DbError, not the existing row, on error %s",
      async (code) => {
        const calls = respond(pgError(code, 400));
        const error = await expectDbError(
          repos.createTriageReview({ ticketId, waitTokenId: "t" }),
          "createTriageReview",
        );
        expect(error.code).toBe(code);
        expect(calls).toHaveLength(1);
      },
    );

    it("throws DbError when the row cannot be read back after 23505", async () => {
      respond(pgError("23505", 409), pgError("PGRST116", 406));
      await expectDbError(
        repos.createTriageReview({ ticketId, waitTokenId: "t" }),
        "createTriageReview",
      );
    });

    it.each([
      ["a non-UUID ticket", { ticketId: "nope", waitTokenId: "t" }],
      ["an empty token", { ticketId, waitTokenId: "" }],
      ["a blank token", { ticketId, waitTokenId: "   " }],
    ])("rejects %s before any request", async (_name, input) => {
      const calls = respond();
      await expect(repos.createTriageReview(input)).rejects.toThrow(TypeError);
      expect(calls).toHaveLength(0);
    });
  });

  describe("getReview and getTriageReview", () => {
    it("getReview returns the row with named columns", async () => {
      const calls = respond(ok(reviewRow));
      expect(await repos.getReview(reviewId)).toEqual(reviewRow);
      expect(calls[0]?.url.searchParams.get("id")).toBe(`eq.${reviewId}`);
      expect(selectOf(calls[0])).toBe(COLUMNS);
    });

    it("getReview returns null for an unknown id", async () => {
      respond(ok(null, 200));
      expect(await repos.getReview(randomUUID())).toBeNull();
    });

    it("getTriageReview filters on ticket, kind triage and no proposal", async () => {
      const calls = respond(ok(reviewRow));
      expect(await repos.getTriageReview(ticketId)).toEqual(reviewRow);
      expect(calls[0]?.url.searchParams.get("ticket_id")).toBe(`eq.${ticketId}`);
      expect(calls[0]?.url.searchParams.get("kind")).toBe("eq.triage");
      expect(calls[0]?.url.searchParams.get("proposal_id")).toBe("is.null");
      expect(selectOf(calls[0])).toBe(COLUMNS);
    });

    it("getTriageReview returns null when the ticket has none", async () => {
      respond(ok(null, 200));
      expect(await repos.getTriageReview(ticketId)).toBeNull();
    });

    it.each([
      ["getReview", (v: string) => repos.getReview(v)],
      ["getTriageReview", (v: string) => repos.getTriageReview(v)],
    ])("%s throws TypeError for a non-UUID with no request", async (_name, call) => {
      const calls = respond();
      await expect(call("not-a-uuid")).rejects.toThrow(TypeError);
      await expect(call("")).rejects.toThrow(TypeError);
      expect(calls).toHaveLength(0);
    });

    it.each([
      ["getReview", () => repos.getReview(reviewId)],
      ["getTriageReview", () => repos.getTriageReview(ticketId)],
    ])("%s throws DbError naming the operation on a Supabase error", async (name, call) => {
      respond(pgError("42501", 403));
      await expectDbError(call(), name);
    });

    it("throws DbError when the stored row has an unexpected shape", async () => {
      respond(ok({ ...reviewRow, decision: "maybe" }));
      await expectDbError(repos.getReview(reviewId), "getReview");
    });
  });

  describe("setReviewSlackTs", () => {
    it("updates only while slack_ts is null and reports changed", async () => {
      const calls = respond(ok([{ id: reviewId }]));
      expect(await repos.setReviewSlackTs(reviewId, "1730000000.000100")).toEqual({
        changed: true,
      });
      expect(calls[0]?.method).toBe("PATCH");
      expect(calls[0]?.url.searchParams.get("id")).toBe(`eq.${reviewId}`);
      expect(calls[0]?.url.searchParams.get("slack_ts")).toBe("is.null");
      expect(calls[0]?.body).toEqual({ slack_ts: "1730000000.000100" });
      expect(selectOf(calls[0])).toBe("id");
    });

    it("reports changed false when no row matched", async () => {
      respond(ok([]));
      expect(await repos.setReviewSlackTs(reviewId, "1730000000.000200")).toEqual({
        changed: false,
      });
    });

    it("throws DbError when more than one row comes back", async () => {
      respond(ok([{ id: reviewId }, { id: randomUUID() }]));
      await expectDbError(repos.setReviewSlackTs(reviewId, "1.1"), "setReviewSlackTs");
    });

    it.each([
      ["a non-UUID id", "nope", "1.1"],
      ["an empty ts", reviewId, ""],
      ["a blank ts", reviewId, "  "],
    ])("rejects %s before any request", async (_name, id, ts) => {
      const calls = respond();
      await expect(repos.setReviewSlackTs(id, ts)).rejects.toThrow(TypeError);
      expect(calls).toHaveLength(0);
    });

    it("throws DbError naming the operation on a Supabase error", async () => {
      respond(pgError("42501", 403));
      await expectDbError(repos.setReviewSlackTs(reviewId, "1.1"), "setReviewSlackTs");
    });
  });

  describe("decideReview", () => {
    it("sets the decision with one conditional update and returns the winner's row", async () => {
      const calls = respond(ok([decidedRow]));
      const outcome = await repos.decideReview(reviewId, "approve", USER);
      expect(outcome).toEqual({ changed: true, review: decidedRow });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.method).toBe("PATCH");
      expect(calls[0]?.url.searchParams.get("id")).toBe(`eq.${reviewId}`);
      expect(calls[0]?.url.searchParams.get("decision")).toBe("is.null");
      expect(selectOf(calls[0])).toBe(COLUMNS);
      const body = calls[0]?.body as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(["decided_at", "decision", "slack_user_id"]);
      expect(body.decision).toBe("approve");
      expect(body.slack_user_id).toBe(USER);
      expect(Number.isNaN(Date.parse(String(body.decided_at)))).toBe(false);
    });

    it("sends a null user for a timeout", async () => {
      const timedOut = { ...reviewRow, decision: "timeout", decided_at: now };
      const calls = respond(ok([timedOut]));
      expect(await repos.decideReview(reviewId, "timeout", null)).toEqual({
        changed: true,
        review: timedOut,
      });
      expect((calls[0]?.body as Record<string, unknown>).slack_user_id).toBeNull();
    });

    it("returns the stored row with changed false when the update matched nothing", async () => {
      const calls = respond(ok([]), ok(decidedRow));
      const outcome = await repos.decideReview(reviewId, "reject", "U0000000002");
      expect(outcome).toEqual({ changed: false, review: decidedRow });
      expect(calls).toHaveLength(2);
      expect(calls[1]?.method).toBe("GET");
      expect(calls[1]?.url.searchParams.get("id")).toBe(`eq.${reviewId}`);
      expect(selectOf(calls[1])).toBe(COLUMNS);
    });

    it("throws DbError for an unknown review id", async () => {
      respond(ok([]), ok(null, 200));
      await expectDbError(repos.decideReview(randomUUID(), "approve", USER), "decideReview");
    });

    it("throws DbError when more than one row is updated", async () => {
      respond(ok([decidedRow, decidedRow]));
      await expectDbError(repos.decideReview(reviewId, "approve", USER), "decideReview");
    });

    it("throws DbError, without a read-back, when the update fails", async () => {
      const calls = respond(pgError("42501", 403));
      await expectDbError(repos.decideReview(reviewId, "approve", USER), "decideReview");
      expect(calls).toHaveLength(1);
    });

    it("throws DbError when the read-back fails", async () => {
      respond(ok([]), pgError("42501", 403));
      await expectDbError(repos.decideReview(reviewId, "approve", USER), "decideReview");
    });

    it.each([
      ["timeout with a user", reviewId, "timeout", USER],
      ["timeout with an empty user", reviewId, "timeout", ""],
      ["approve with a null user", reviewId, "approve", null],
      ["reject with a null user", reviewId, "reject", null],
      ["approve with an empty user", reviewId, "approve", ""],
      ["approve with a blank user", reviewId, "approve", "         "],
      ["approve with a lower-case user", reviewId, "approve", "u0000000001"],
      ["approve with a short user", reviewId, "approve", "U1234567"],
      ["approve with a channel ID", reviewId, "approve", "C0000000001"],
      ["approve with a 14-character user", reviewId, "approve", "U0123456789012"],
      ["approve with a too-long user", reviewId, "approve", "U0123456789ABCDEFGHIJ"],
      ["approve with a W user that is too short", reviewId, "approve", "W1234567"],
      ["approve with a user plus a suffix", reviewId, "approve", "U0000000001 x"],
      ["approve with a newline in the user", reviewId, "approve", "U0000000001\n"],
      ["an unknown decision", reviewId, "maybe", USER],
      ["an empty decision", reviewId, "", USER],
      ["a non-UUID id", "nope", "approve", USER],
    ])("throws TypeError with no request for %s", async (_name, id, decision, user) => {
      const calls = respond();
      await expect(
        repos.decideReview(id, decision as "approve", user as string | null),
      ).rejects.toThrow(TypeError);
      expect(calls).toHaveLength(0);
    });

    it("accepts a W-prefixed user and a user at the 13-character limit", async () => {
      const calls = respond(ok([decidedRow]), ok([decidedRow]));
      await repos.decideReview(reviewId, "approve", "W012345678");
      await repos.decideReview(reviewId, "reject", "U012345678901");
      expect(calls).toHaveLength(2);
    });

    it("accepts the e2e and staging style reviewer IDs", async () => {
      respond(ok([decidedRow]), ok([decidedRow]));
      await repos.decideReview(reviewId, "approve", "UE2EREVIEWER");
      await repos.decideReview(reviewId, "reject", "U0A5ATR4WJD");
    });
  });

  describe("getKbArticlesByIds", () => {
    const a = randomUUID();
    const b = randomUUID();
    const c = randomUUID();
    const titleRow = (id: string, slug: string) => ({ id, slug, title: `Title ${slug}` });

    it("returns rows in input order, leaves unknown ids out, selecting id, slug and title", async () => {
      const calls = respond(ok([titleRow(a, "a"), titleRow(b, "b")]));
      expect(await repos.getKbArticlesByIds([b, a, c])).toEqual([
        titleRow(b, "b"),
        titleRow(a, "a"),
      ]);
      expect(selectOf(calls[0])).toBe("id,slug,title");
      expect(calls[0]?.url.pathname).toBe("/rest/v1/kb_articles");
    });

    it("returns each article once for a repeated id, in first-seen order", async () => {
      const calls = respond(ok([titleRow(a, "a"), titleRow(b, "b")]));
      expect(await repos.getKbArticlesByIds([b, a, b, a])).toEqual([
        titleRow(b, "b"),
        titleRow(a, "a"),
      ]);
      expect(calls[0]?.url.searchParams.get("id")).toBe(`in.(${b},${a})`);
    });

    it("makes no request for an empty list", async () => {
      const calls = respond();
      expect(await repos.getKbArticlesByIds([])).toEqual([]);
      expect(calls).toHaveLength(0);
    });

    it("throws TypeError for a non-UUID id with no request", async () => {
      const calls = respond();
      await expect(repos.getKbArticlesByIds([a, "1),(drop"])).rejects.toThrow(TypeError);
      expect(calls).toHaveLength(0);
    });

    it("throws DbError naming the operation on a Supabase error", async () => {
      respond(pgError("42501", 403));
      await expectDbError(repos.getKbArticlesByIds([a]), "getKbArticlesByIds");
    });
  });

  describe("getTicketView reviews", () => {
    const viewTicket = {
      id: ticketId,
      status: "approved",
      is_test: true,
      source: "web",
      created_at: now,
    };
    const viewReview = {
      id: reviewId,
      kind: "triage",
      slack_user_id: USER,
      decision: "approve",
      decided_at: now,
      slack_ts: "1730000000.000100",
      created_at: now,
    };

    function database(reviewBody: Response): Captured[] {
      const calls: Captured[] = [];
      vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
        const url = new URL(String(input));
        calls.push({
          method: init.method ?? "GET",
          url,
          headers: new Headers(init.headers),
          body: undefined,
        });
        const table = url.pathname.split("/").pop();
        if (table === "tickets") return ok(viewTicket);
        if (table === "ai_calls") {
          return new Response(null, { status: 200, headers: { "content-range": "*/0" } });
        }
        if (table === "reviews") return reviewBody.clone();
        if (table === "ticket_events") return ok([]);
        return ok(null, 200);
      });
      return calls;
    }

    it("maps an approved review and never selects wait_token_id", async () => {
      const calls = database(ok([{ ...viewReview, wait_token_id: TOKEN_MARKER }]));
      const view = await repos.getTicketView(ticketId);
      expect(view?.reviews).toEqual([
        {
          id: reviewId,
          kind: "triage",
          decision: "approve",
          decidedBy: USER,
          decidedAt: now,
          slackTs: "1730000000.000100",
          createdAt: now,
        },
      ]);
      expect(JSON.stringify(view)).not.toContain(TOKEN_MARKER);
      const reviews = calls.find((c) => c.url.pathname.endsWith("/reviews"));
      expect(selectOf(reviews)).toBe(
        "id,kind,slack_user_id,decision,decided_at,slack_ts,created_at",
      );
      expect(selectOf(reviews)?.split(",")).not.toContain("wait_token_id");
      expect(reviews?.url.searchParams.get("ticket_id")).toBe(`eq.${ticketId}`);
      expect(reviews?.url.searchParams.get("order")).toBe("created_at.asc,id.asc");
      for (const call of calls) expect(selectOf(call)).not.toBe("*");
    });

    it("gives reviews: [] for a ticket without reviews", async () => {
      database(ok([]));
      expect((await repos.getTicketView(ticketId))?.reviews).toEqual([]);
    });

    it("maps an open review with null decision fields", async () => {
      database(
        ok([
          { ...viewReview, slack_user_id: null, decision: null, decided_at: null, slack_ts: null },
        ]),
      );
      expect((await repos.getTicketView(ticketId))?.reviews).toEqual([
        {
          id: reviewId,
          kind: "triage",
          decision: null,
          decidedBy: null,
          decidedAt: null,
          slackTs: null,
          createdAt: now,
        },
      ]);
    });

    it("throws DbError without row data when the reviews query fails", async () => {
      database(pgError("42P01", 404));
      await expectDbError(repos.getTicketView(ticketId), "getTicketView");
    });
  });
});
