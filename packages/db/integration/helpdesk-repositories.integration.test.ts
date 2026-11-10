import { randomUUID } from "node:crypto";
import { CATEGORIES, PRIORITIES } from "@ai-it-support/shared";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient } from "../src/client.js";

import { createRepositories, type Repositories } from "../src/repositories.js";
import { clientFor } from "./pg-container.js";
import { removeRestStack, startRestStack, type RestStack } from "./rest-stack.js";

// P5-T12: the helpdesk repository functions over supabase-js + PostgREST, on
// a throwaway stack with migrations 0001 to 0007.
let stack: RestStack | undefined;
let db: pg.Client | undefined;
let repos: Repositories;

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
    requester_email: "demo.user@example.test",
    idempotency_key: `it-${randomUUID()}`,
  });
  return ticket.id;
}

async function newHelpdeskTicket() {
  const ticketId = await newTicketId();
  const { helpdeskTicket } = await repos.createHelpdeskTicket({
    ticketId,
    priority: "P2",
    category: "network",
  });
  return { ticketId, helpdeskTicket };
}

describe("createHelpdeskTicket and getHelpdeskTicketByTicketId", () => {
  it("creating twice for one ticket returns the same row and number, and keeps the first values", async () => {
    const ticketId = await newTicketId();
    const first = await repos.createHelpdeskTicket({
      ticketId,
      priority: "P2",
      category: "network",
    });
    expect(first.created).toBe(true);
    expect(first.helpdeskTicket).toMatchObject({
      ticket_id: ticketId,
      state: "new",
      assignee_id: null,
    });
    expect(first.helpdeskTicket.number).toMatch(/^HD[0-9]{7}$/);

    const second = await repos.createHelpdeskTicket({
      ticketId,
      priority: "P1",
      category: "inquiry",
    });
    expect(second).toEqual({ helpdeskTicket: first.helpdeskTicket, created: false });
    const { rows } = await sql().query(
      "select count(*)::int as n from itsupport.helpdesk_tickets where ticket_id = $1",
      [ticketId],
    );
    expect(rows[0]).toEqual({ n: 1 });
    expect(await repos.getHelpdeskTicketByTicketId(ticketId)).toEqual(first.helpdeskTicket);
  });

  it("returns null for a ticket without a helpdesk ticket, and stores every priority and category", async () => {
    expect(await repos.getHelpdeskTicketByTicketId(randomUUID())).toBeNull();
    for (const [i, category] of CATEGORIES.entries()) {
      const priority = PRIORITIES[i % PRIORITIES.length] ?? "P3";
      const { helpdeskTicket } = await repos.createHelpdeskTicket({
        ticketId: await newTicketId(),
        priority,
        category,
      });
      expect(helpdeskTicket).toMatchObject({ priority, category });
    }
  });

  it("throws DbError with the foreign-key code for an unknown ticket", async () => {
    await expect(
      repos.createHelpdeskTicket({ ticketId: randomUUID(), priority: "P2", category: "network" }),
    ).rejects.toMatchObject({ name: "DbError", operation: "createHelpdeskTicket", code: "23503" });
  });
});

describe("addSystemNote", () => {
  it("stores a system note unchanged, 5000 wide characters included, and the table stays append-only", async () => {
    const { helpdeskTicket } = await newHelpdeskTicket();
    const wide = "😀".repeat(5000);
    const note = await repos.addSystemNote(helpdeskTicket.id, wide);
    expect(note).toMatchObject({ author_kind: "system", author_staff_id: null, body: wide });
    const odd = "'; drop table x; -- <b>é</b> ‮abc";
    await repos.addSystemNote(helpdeskTicket.id, odd);
    const { rows } = await sql().query(
      "select body from itsupport.helpdesk_notes where helpdesk_ticket_id = $1 order by created_at, id",
      [helpdeskTicket.id],
    );
    expect(rows.map((row: { body: string }) => row.body)).toEqual([wide, odd]);
    await expect(
      sql().query("update itsupport.helpdesk_notes set body = 'x' where id = $1", [note.id]),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("throws DbError for an unknown helpdesk ticket", async () => {
    await expect(repos.addSystemNote(randomUUID(), "note")).rejects.toMatchObject({
      name: "DbError",
      operation: "addSystemNote",
      code: "23503",
    });
  });
});
