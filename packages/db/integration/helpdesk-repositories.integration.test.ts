import { randomUUID } from "node:crypto";
import { CATEGORIES, PRIORITIES } from "@ai-it-support/shared";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient } from "../src/client.js";
import { DbError, HelpdeskConflictError, IncidentConflictError } from "../src/errors.js";
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

describe("setHelpdeskState", () => {
  it("moves a legal pair, then reports a stale `from` as changed: false with the stored row", async () => {
    const { helpdeskTicket } = await newHelpdeskTicket();
    const moved = await repos.setHelpdeskState(helpdeskTicket.id, "new", "in_progress");
    expect(moved.changed).toBe(true);
    expect(moved.helpdeskTicket.state).toBe("in_progress");
    expect(new Date(moved.helpdeskTicket.updated_at).getTime()).toBeGreaterThan(
      new Date(helpdeskTicket.updated_at).getTime(),
    );

    const stale = await repos.setHelpdeskState(helpdeskTicket.id, "new", "on_hold");
    expect(stale).toEqual({ changed: false, helpdeskTicket: moved.helpdeskTicket });
    const { rows } = await sql().query(
      "select state from itsupport.helpdesk_tickets where id = $1",
      [helpdeskTicket.id],
    );
    expect(rows).toEqual([{ state: "in_progress" }]);
  });

  it("refuses an illegal pair before any request and leaves the row alone", async () => {
    const { helpdeskTicket } = await newHelpdeskTicket();
    await expect(repos.setHelpdeskState(helpdeskTicket.id, "new", "new")).rejects.toMatchObject({
      name: "IllegalHelpdeskTransitionError",
    });
    expect(await repos.getHelpdeskTicketByTicketId(helpdeskTicket.ticket_id)).toEqual(
      helpdeskTicket,
    );
  });

  it("lets exactly one of two parallel moves from `new` win", async () => {
    const { helpdeskTicket } = await newHelpdeskTicket();
    const outcomes = await Promise.all([
      repos.setHelpdeskState(helpdeskTicket.id, "new", "in_progress"),
      repos.setHelpdeskState(helpdeskTicket.id, "new", "resolved"),
    ]);
    expect(outcomes.filter((outcome) => outcome.changed)).toHaveLength(1);
    const [winner] = outcomes.filter((outcome) => outcome.changed);
    for (const outcome of outcomes) {
      expect(outcome.helpdeskTicket.state).toBe(winner?.helpdeskTicket.state);
    }
  });

  it("throws DbError for an unknown id", async () => {
    await expect(repos.setHelpdeskState(randomUUID(), "new", "closed")).rejects.toBeInstanceOf(
      DbError,
    );
  });
});

describe("setTicketIncident", () => {
  const incident = { sysId: "a".repeat(32), number: "INC0010001" };
  const stored = async (ticketId: string) =>
    (
      await sql().query(
        "select servicenow_sys_id, servicenow_number from itsupport.tickets where id = $1",
        [ticketId],
      )
    ).rows;

  it("stores the incident once, accepts the same sys_id again and refuses another", async () => {
    const ticketId = await newTicketId();
    expect(await repos.setTicketIncident(ticketId, incident)).toEqual({ changed: true });
    expect(await repos.setTicketIncident(ticketId, incident)).toEqual({ changed: false });
    await expect(
      repos.setTicketIncident(ticketId, { sysId: "b".repeat(32), number: "INC0010002" }),
    ).rejects.toBeInstanceOf(IncidentConflictError);
    expect(await stored(ticketId)).toEqual([
      { servicenow_sys_id: incident.sysId, servicenow_number: incident.number },
    ]);
  });

  it("throws DbError for an unknown ticket", async () => {
    await expect(repos.setTicketIncident(randomUUID(), incident)).rejects.toMatchObject({
      name: "DbError",
      operation: "setTicketIncident",
    });
  });

  it("lets exactly one of two parallel callers with different sys_ids win", async () => {
    const ticketId = await newTicketId();
    const results = await Promise.allSettled([
      repos.setTicketIncident(ticketId, incident),
      repos.setTicketIncident(ticketId, { sysId: "c".repeat(32), number: "INC0010003" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((result) => result.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(IncidentConflictError);
    expect(await stored(ticketId)).toHaveLength(1);
  });
});

describe("setTicketHelpdesk", () => {
  it("sets a null helpdesk once, accepts the same value again and refuses a different one", async () => {
    const ticketId = await newTicketId();
    expect(await repos.setTicketHelpdesk(ticketId, "builtin")).toEqual({ changed: true });
    expect(await repos.setTicketHelpdesk(ticketId, "builtin")).toEqual({ changed: false });
    await expect(repos.setTicketHelpdesk(ticketId, "servicenow")).rejects.toBeInstanceOf(
      HelpdeskConflictError,
    );
    const { rows } = await sql().query("select helpdesk from itsupport.tickets where id = $1", [
      ticketId,
    ]);
    expect(rows).toEqual([{ helpdesk: "builtin" }]);
  });

  it("throws DbError for an unknown ticket", async () => {
    await expect(repos.setTicketHelpdesk(randomUUID(), "builtin")).rejects.toMatchObject({
      name: "DbError",
      operation: "setTicketHelpdesk",
    });
  });
});
