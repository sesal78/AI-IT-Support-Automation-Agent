import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDbClient } from "./client.js";
import { DbError } from "./errors.js";
import { createRepositories } from "./repositories.js";

const SECRET_KEY = "test-service-role-key";
const repos = createRepositories(
  createDbClient({
    SUPABASE_URL: "http://127.0.0.1:54321",
    SUPABASE_SERVICE_ROLE_KEY: SECRET_KEY,
    SUPABASE_DB_SCHEMA: "itsupport",
  }),
);

const ticketId = randomUUID();
const helpdeskId = randomUUID();
const now = "2026-11-10T10:00:00.123456+00:00";
const SECRET_TEXT = "My SSN is 123-45-6789";
const COLUMNS = "id,ticket_id,seq,number,state,priority,category,assignee_id,created_at,updated_at";
const NOTE_COLUMNS = "id,helpdesk_ticket_id,author_kind,author_staff_id,body,created_at";

const row = {
  id: helpdeskId,
  ticket_id: ticketId,
  seq: 42,
  number: "HD0000042",
  state: "new",
  priority: "P2",
  category: "network",
  assignee_id: null,
  created_at: now,
  updated_at: now,
};
const noteRow = {
  id: randomUUID(),
  helpdesk_ticket_id: helpdeskId,
  author_kind: "system",
  author_staff_id: null,
  body: "Created by the agent",
  created_at: now,
};

interface Captured {
  method: string;
  url: URL;
  body: unknown;
}

/** Stubs global fetch (used lazily by supabase-js) with queued PostgREST responses. */
function respond(...responses: Response[]): Captured[] {
  const calls: Captured[] = [];
  vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
    calls.push({
      method: init.method ?? "GET",
      url: new URL(String(input)),
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
    { code, message: `boom ${SECRET_TEXT}`, details: `Key (x)=(${SECRET_TEXT})`, hint: null },
    { status },
  );
const selectOf = (call: Captured | undefined) => call?.url.searchParams.get("select");

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
  expect(dbError.operation).toBe(operation);
  expect(dbError.message).toContain(operation);
  expect(dbError.message).not.toContain(SECRET_TEXT);
  expect(dbError.message).not.toContain(SECRET_KEY);
  return dbError;
}

describe("createHelpdeskTicket", () => {
  const input = { ticketId, priority: "P2", category: "network" } as const;

  it("inserts the row and returns it with created: true", async () => {
    const calls = respond(ok(row, 201));
    expect(await repos.createHelpdeskTicket(input)).toEqual({ helpdeskTicket: row, created: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url.pathname).toBe("/rest/v1/helpdesk_tickets");
    expect(calls[0]?.body).toEqual({ ticket_id: ticketId, priority: "P2", category: "network" });
    expect(selectOf(calls[0])).toBe(COLUMNS);
  });

  it("returns the existing row with created: false on a duplicate ticket", async () => {
    const calls = respond(pgError("23505", 409), ok(row));
    expect(await repos.createHelpdeskTicket({ ...input, priority: "P1" })).toEqual({
      helpdeskTicket: row,
      created: false,
    });
    expect(calls[1]?.method).toBe("GET");
    expect(calls[1]?.url.searchParams.get("ticket_id")).toBe(`eq.${ticketId}`);
    expect(selectOf(calls[1])).toBe(COLUMNS);
  });

  it("throws DbError when the row cannot be read back after a duplicate", async () => {
    respond(pgError("23505", 409), pgError("PGRST116", 406));
    await expectDbError(repos.createHelpdeskTicket(input), "createHelpdeskTicket");
  });

  it("throws DbError naming the operation on any other Supabase error", async () => {
    const calls = respond(pgError("23514", 400));
    const error = await expectDbError(repos.createHelpdeskTicket(input), "createHelpdeskTicket");
    expect(error.code).toBe("23514");
    expect(calls).toHaveLength(1);
  });

  it.each([
    ["a non-UUID ticket id", { ...input, ticketId: "nope" }],
    ["an unknown priority", { ...input, priority: "P9" }],
    ["an unknown category", { ...input, category: "weather" }],
    ["a missing priority", { ticketId, category: "network" }],
  ])("rejects %s with a TypeError before any request", async (_name, bad) => {
    const calls = respond();
    await expect(repos.createHelpdeskTicket(bad as never)).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["a bad number", { ...row, number: SECRET_TEXT }],
    ["an unknown state", { ...row, state: SECRET_TEXT }],
    ["an extra column", { ...row, requester_email: SECRET_TEXT }],
    ["a missing column", { ...row, seq: undefined }],
    ["a non-UUID id", { ...row, id: SECRET_TEXT }],
  ])("throws DbError for a malformed response: %s", async (_name, bad) => {
    respond(ok(bad, 201));
    await expectDbError(repos.createHelpdeskTicket(input), "createHelpdeskTicket");
  });
});

describe("getHelpdeskTicketByTicketId", () => {
  it("reads by ticket_id and returns the row", async () => {
    const calls = respond(ok(row));
    expect(await repos.getHelpdeskTicketByTicketId(ticketId)).toEqual(row);
    expect(calls[0]?.url.searchParams.get("ticket_id")).toBe(`eq.${ticketId}`);
    expect(selectOf(calls[0])).toBe(COLUMNS);
  });

  it("returns null when the ticket has no helpdesk ticket", async () => {
    respond(ok(null));
    expect(await repos.getHelpdeskTicketByTicketId(ticketId)).toBeNull();
  });

  it("rejects a non-UUID before any request and wraps errors and bad rows in DbError", async () => {
    const calls = respond(pgError("42501", 403), ok({ ...row, state: "bogus" }));
    await expect(repos.getHelpdeskTicketByTicketId("nope")).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
    const op = "getHelpdeskTicketByTicketId";
    await expectDbError(repos.getHelpdeskTicketByTicketId(ticketId), op);
    await expectDbError(repos.getHelpdeskTicketByTicketId(ticketId), op);
  });
});

describe("addSystemNote", () => {
  it("inserts a system note and returns it", async () => {
    const calls = respond(ok(noteRow, 201));
    expect(await repos.addSystemNote(helpdeskId, noteRow.body)).toEqual(noteRow);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url.pathname).toBe("/rest/v1/helpdesk_notes");
    expect(calls[0]?.body).toEqual({
      helpdesk_ticket_id: helpdeskId,
      author_kind: "system",
      body: noteRow.body,
    });
    expect(selectOf(calls[0])).toBe(NOTE_COLUMNS);
  });

  it("accepts 5000 characters, counting a character once however wide it is", async () => {
    respond(ok(noteRow, 201), ok(noteRow, 201));
    await repos.addSystemNote(helpdeskId, "x".repeat(5000));
    await repos.addSystemNote(helpdeskId, "😀".repeat(5000));
  });

  it.each([
    ["a non-UUID id", "nope", "note", TypeError],
    ["a non-string body", helpdeskId, 42, TypeError],
    ["an empty body", helpdeskId, "", TypeError],
    ["a blank body", helpdeskId, "  \n", TypeError],
    ["a body of 5001 characters", helpdeskId, "x".repeat(5001), RangeError],
  ])("rejects %s before any request", async (_name, id, body, errorClass) => {
    const calls = respond();
    await expect(repos.addSystemNote(id, body as string)).rejects.toThrow(errorClass);
    expect(calls).toHaveLength(0);
  });

  it("never echoes the body in an error", async () => {
    respond(pgError("23503", 409), ok({ ...noteRow, author_kind: SECRET_TEXT }, 201));
    await expectDbError(repos.addSystemNote(helpdeskId, SECRET_TEXT), "addSystemNote");
    await expectDbError(repos.addSystemNote(helpdeskId, SECRET_TEXT), "addSystemNote");
  });
});
