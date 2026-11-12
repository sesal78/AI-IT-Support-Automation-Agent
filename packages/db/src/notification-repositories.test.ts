import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDbClient } from "./client.js";
import { DbError } from "./errors.js";
import { createRepositories, notificationSchema } from "./repositories.js";

const repos = createRepositories(
  createDbClient({
    SUPABASE_URL: "http://127.0.0.1:54321",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
    SUPABASE_DB_SCHEMA: "itsupport",
  }),
);

const ticketId = randomUUID();
const now = "2026-11-12T10:00:00.123456+00:00";
const COLUMNS = "id,ticket_id,channel,kind,status,provider_id,reason,at";
const REQUESTER = "requester.marker@example.test";
const SECRET_TEXT = "My SSN is 123-45-6789";

const sentRow = {
  id: randomUUID(),
  ticket_id: ticketId,
  channel: "email",
  kind: "incident_reply",
  status: "sent",
  provider_id: "re_msg_01",
  reason: null,
  at: now,
};
const skippedRow = {
  ...sentRow,
  id: randomUUID(),
  status: "skipped",
  provider_id: null,
  reason: "not_allow_listed",
};
const failedRow = {
  ...sentRow,
  id: randomUUID(),
  status: "failed",
  provider_id: null,
  reason: "provider_error",
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
    {
      code,
      message: `boom ${SECRET_TEXT}`,
      details: `Key (x)=(${SECRET_TEXT} ${REQUESTER})`,
      hint: null,
    },
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
  expect(dbError.message).not.toContain(SECRET_TEXT);
  expect(dbError.message).not.toContain(REQUESTER);
  return dbError;
}

describe("recordNotification", () => {
  const sent = {
    ticketId,
    channel: "email",
    kind: "incident_reply",
    status: "sent",
    providerId: "re_msg_01",
    reason: null,
  } as const;

  it("inserts a sent row with the provider id and returns it with created: true", async () => {
    const calls = respond(ok(sentRow, 201));
    expect(await repos.recordNotification(sent)).toEqual({ created: true, notification: sentRow });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url.pathname).toBe("/rest/v1/notifications");
    expect(calls[0]?.body).toEqual({
      ticket_id: ticketId,
      channel: "email",
      kind: "incident_reply",
      status: "sent",
      provider_id: "re_msg_01",
      reason: null,
    });
    expect(selectOf(calls[0])).toBe(COLUMNS);
  });

  it("inserts a skipped row (not_allow_listed, no provider id)", async () => {
    const calls = respond(ok(skippedRow, 201));
    const result = await repos.recordNotification({
      ...sent,
      status: "skipped",
      providerId: null,
      reason: "not_allow_listed",
    });
    expect(result).toEqual({ created: true, notification: skippedRow });
    expect(calls[0]?.body).toMatchObject({
      status: "skipped",
      provider_id: null,
      reason: "not_allow_listed",
    });
  });

  it("inserts a failed row (provider_error, no provider id)", async () => {
    const calls = respond(ok(failedRow, 201));
    const result = await repos.recordNotification({
      ...sent,
      status: "failed",
      providerId: null,
      reason: "provider_error",
    });
    expect(result).toEqual({ created: true, notification: failedRow });
    expect(calls[0]?.body).toMatchObject({ status: "failed", reason: "provider_error" });
  });

  it("on 23505 returns the stored row with created: false and writes nothing more", async () => {
    // A sent row already exists; a failure hook that runs later must not touch it.
    const calls = respond(pgError("23505", 409), ok(sentRow));
    const result = await repos.recordNotification({
      ...sent,
      status: "failed",
      providerId: null,
      reason: "provider_error",
    });
    expect(result).toEqual({ created: false, notification: sentRow });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.method).toBe("GET");
    expect(calls[1]?.url.searchParams.get("ticket_id")).toBe(`eq.${ticketId}`);
    expect(calls[1]?.url.searchParams.get("channel")).toBe("eq.email");
    expect(calls[1]?.url.searchParams.get("kind")).toBe("eq.incident_reply");
    expect(selectOf(calls[1])).toBe(COLUMNS);
    expect(calls.filter((call) => call.method !== "POST" && call.method !== "GET")).toEqual([]);
  });

  it("throws DbError when the row cannot be read back after a duplicate", async () => {
    respond(pgError("23505", 409), pgError("PGRST116", 406));
    await expectDbError(repos.recordNotification(sent), "recordNotification");
  });

  it("throws DbError with the code on any other Supabase error, leaking no value", async () => {
    const calls = respond(pgError("23514", 400));
    const error = await expectDbError(repos.recordNotification(sent), "recordNotification");
    expect(error.code).toBe("23514");
    expect(calls).toHaveLength(1);
  });

  it("throws DbError when the stored row has a column the schema does not know", async () => {
    respond(ok({ ...sentRow, requester_email: REQUESTER }, 201));
    await expectDbError(repos.recordNotification(sent), "recordNotification");
  });

  it.each([
    ["a non-UUID ticket id", { ...sent, ticketId: "nope" }],
    ["an unknown channel", { ...sent, channel: "sms" }],
    ["an unknown kind", { ...sent, kind: "welcome" }],
    ["an unknown status", { ...sent, status: "queued" }],
    ["a sent row without a provider id", { ...sent, providerId: null }],
    ["a sent row with a reason", { ...sent, reason: "provider_error" }],
    ["a provider id with a space", { ...sent, providerId: "a b" }],
    ["a provider id with an at sign", { ...sent, providerId: REQUESTER }],
    ["a provider id with a line break", { ...sent, providerId: "id\r\nBcc: x" }],
    ["an empty provider id", { ...sent, providerId: "" }],
    ["a 101-character provider id", { ...sent, providerId: "a".repeat(101) }],
    [
      "a skipped row with a provider id",
      { ...sent, status: "skipped", reason: "not_allow_listed" },
    ],
    ["a skipped row with the wrong reason", { ...sent, status: "skipped", providerId: null }],
    [
      "a failed row with a provider id",
      { ...sent, status: "failed", reason: "provider_error", providerId: "x" },
    ],
    ["a failed row with the wrong reason", { ...sent, status: "failed", providerId: null }],
  ])("rejects %s with a TypeError before any request", async (_name, input) => {
    const calls = respond();
    await expect(repos.recordNotification(input as never)).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });
});

describe("getNotification", () => {
  it("reads the row by ticket, channel and kind with named columns", async () => {
    const calls = respond(ok(sentRow));
    expect(await repos.getNotification(ticketId, "incident_reply")).toEqual(sentRow);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url.pathname).toBe("/rest/v1/notifications");
    expect(calls[0]?.url.searchParams.get("ticket_id")).toBe(`eq.${ticketId}`);
    expect(calls[0]?.url.searchParams.get("channel")).toBe("eq.email");
    expect(calls[0]?.url.searchParams.get("kind")).toBe("eq.incident_reply");
    expect(selectOf(calls[0])).toBe(COLUMNS);
  });

  it("returns null when there is no row", async () => {
    respond(ok(null));
    expect(await repos.getNotification(ticketId, "needs_info")).toBeNull();
  });

  it("the strict schema refuses a column it does not know", () => {
    expect(notificationSchema.safeParse(sentRow).success).toBe(true);
    expect(notificationSchema.safeParse({ ...sentRow, requester_email: REQUESTER }).success).toBe(
      false,
    );
  });

  it("throws DbError on a Supabase error", async () => {
    respond(pgError("42501", 403));
    await expectDbError(repos.getNotification(ticketId, "needs_info"), "getNotification");
  });

  it("throws DbError on a row of the wrong shape", async () => {
    respond(ok({ ...sentRow, status: "queued" }));
    await expectDbError(repos.getNotification(ticketId, "incident_reply"), "getNotification");
  });

  it.each([
    ["a non-UUID ticket id", "nope", "incident_reply"],
    ["an unknown kind", ticketId, "welcome"],
  ])("rejects %s with a TypeError before any request", async (_name, id, kind) => {
    const calls = respond();
    await expect(repos.getNotification(id, kind as never)).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });
});

describe("getRequesterEmail", () => {
  it("selects the one named column and returns the address", async () => {
    const calls = respond(ok({ requester_email: REQUESTER }));
    expect(await repos.getRequesterEmail(ticketId)).toBe(REQUESTER);
    expect(calls[0]?.url.pathname).toBe("/rest/v1/tickets");
    expect(selectOf(calls[0])).toBe("requester_email");
    expect(calls[0]?.url.searchParams.get("id")).toBe(`eq.${ticketId}`);
  });

  it("returns null for an unknown ticket", async () => {
    respond(ok(null));
    expect(await repos.getRequesterEmail(ticketId)).toBeNull();
  });

  it("throws DbError when the row has another shape, naming no value", async () => {
    respond(ok({ requester_email: 42 }));
    await expectDbError(repos.getRequesterEmail(ticketId), "getRequesterEmail");
  });

  it("throws DbError on a Supabase error without echoing the address", async () => {
    respond(pgError("42501", 403));
    await expectDbError(repos.getRequesterEmail(ticketId), "getRequesterEmail");
  });

  it("rejects a non-UUID with a TypeError before any request", async () => {
    const calls = respond();
    await expect(repos.getRequesterEmail("nope")).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });
});
