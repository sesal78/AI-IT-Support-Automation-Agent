import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient } from "../src/client.js";
import { DbError } from "../src/errors.js";
import { createRepositories, type Repositories } from "../src/repositories.js";
import { clientFor } from "./pg-container.js";
import { removeRestStack, startRestStack, type RestStack } from "./rest-stack.js";

// P5-T8b: the notification repository functions over supabase-js + PostgREST,
// on a throwaway stack with migrations 0001 to 0008. All data is fake.
let stack: RestStack | undefined;
let db: pg.Client | undefined;
let repos: Repositories;

const REQUESTER = "demo.requester@example.test";

function sql(): pg.Client {
  if (!db) throw new Error("database client not connected");
  return db;
}

beforeAll(async () => {
  stack = await startRestStack();
  db = clientFor(stack.pg);
  await db.connect();
  repos = createRepositories(
    createDbClient({
      SUPABASE_URL: stack.url,
      SUPABASE_SERVICE_ROLE_KEY: stack.serviceRoleKey,
      SUPABASE_DB_SCHEMA: "itsupport",
    }),
  );
});

afterAll(async () => {
  await db?.end().catch(() => undefined);
  await removeRestStack(stack);
});

async function newTicketId(): Promise<string> {
  const { ticket } = await repos.createTicket({
    source: "web",
    raw_title: "VPN down",
    raw_description: "Cannot connect to VPN from home",
    requester_email: REQUESTER,
    idempotency_key: `it-${randomUUID()}`,
  });
  return ticket.id;
}

const sent = (ticketId: string, providerId = "msg_it_01") =>
  ({
    ticketId,
    channel: "email",
    kind: "incident_reply",
    status: "sent",
    providerId,
    reason: null,
  }) as const;

async function rowsOf(ticketId: string): Promise<{ status: string; provider_id: string | null }[]> {
  const result = await sql().query(
    "select status, provider_id from itsupport.notifications where ticket_id = $1 order by kind",
    [ticketId],
  );
  return result.rows;
}

describe("recordNotification", () => {
  it("stores a sent row, and a second call for the same ticket and kind returns it with created: false", async () => {
    const ticketId = await newTicketId();
    const first = await repos.recordNotification(sent(ticketId));
    expect(first.created).toBe(true);
    expect(first.notification).toMatchObject({
      ticket_id: ticketId,
      channel: "email",
      kind: "incident_reply",
      status: "sent",
      provider_id: "msg_it_01",
      reason: null,
    });

    const second = await repos.recordNotification(sent(ticketId, "msg_it_02"));
    expect(second).toEqual({ created: false, notification: first.notification });
    expect(await rowsOf(ticketId)).toEqual([{ status: "sent", provider_id: "msg_it_01" }]);
  });

  it("a failed or skipped record after a sent row changes nothing", async () => {
    const ticketId = await newTicketId();
    const first = await repos.recordNotification(sent(ticketId));
    const failed = await repos.recordNotification({
      ...sent(ticketId),
      status: "failed",
      providerId: null,
      reason: "provider_error",
    });
    const skipped = await repos.recordNotification({
      ...sent(ticketId),
      status: "skipped",
      providerId: null,
      reason: "not_allow_listed",
    });
    expect(failed).toEqual({ created: false, notification: first.notification });
    expect(skipped).toEqual({ created: false, notification: first.notification });
    expect(await rowsOf(ticketId)).toEqual([{ status: "sent", provider_id: "msg_it_01" }]);
  });

  it("stores skipped and failed rows, and the two kinds of one ticket coexist", async () => {
    const ticketId = await newTicketId();
    const skipped = await repos.recordNotification({
      ...sent(ticketId),
      kind: "needs_info",
      status: "skipped",
      providerId: null,
      reason: "not_allow_listed",
    });
    const failed = await repos.recordNotification({
      ...sent(ticketId),
      status: "failed",
      providerId: null,
      reason: "provider_error",
    });
    expect([skipped.created, failed.created]).toEqual([true, true]);
    expect(await rowsOf(ticketId)).toEqual([
      { status: "failed", provider_id: null },
      { status: "skipped", provider_id: null },
    ]);
  });

  it("an unknown ticket is a DbError with the foreign key code and no value in the message", async () => {
    const error = await repos.recordNotification(sent(randomUUID())).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(DbError);
    expect((error as DbError).code).toBe("23503");
    expect((error as DbError).message).not.toContain("msg_it_01");
  });
});

describe("getNotification", () => {
  it("returns the stored row, or null for the other kind", async () => {
    const ticketId = await newTicketId();
    const { notification } = await repos.recordNotification(sent(ticketId));
    expect(await repos.getNotification(ticketId, "incident_reply")).toEqual(notification);
    expect(await repos.getNotification(ticketId, "needs_info")).toBeNull();
    expect(await repos.getNotification(randomUUID(), "incident_reply")).toBeNull();
  });
});

describe("getRequesterEmail", () => {
  it("returns the stored address, and null for an unknown ticket", async () => {
    const ticketId = await newTicketId();
    expect(await repos.getRequesterEmail(ticketId)).toBe(REQUESTER);
    expect(await repos.getRequesterEmail(randomUUID())).toBeNull();
  });
});
