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
