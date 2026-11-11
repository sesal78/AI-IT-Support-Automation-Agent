import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient } from "../../db/src/client.js";
import { createRepositories, type Repositories } from "../../db/src/repositories.js";
import { clientFor } from "../../db/integration/pg-container.js";
import {
  removeRestStack,
  startRestStack,
  type RestStack,
} from "../../db/integration/rest-stack.js";
import { BuiltinConnector, type BuiltinHelpdeskStore } from "../src/builtin.js";
import { HelpdeskError } from "../src/errors.js";
import { runHelpdeskContract } from "../src/testing/contract.js";
import type { CreatedHelpdeskTicket, HelpdeskTicketRef } from "../src/types.js";

// P5-T13: BuiltinConnector on the real repositories, over supabase-js and
// PostgREST, on a throwaway stack with migrations 0001 to 0008. The P5-T2
// contract suite runs unchanged; the cases after it cover the retry, the
// state rules and the outage.
let stack: RestStack | undefined;
let db: ReturnType<typeof clientFor> | undefined;
let repos: Repositories;

const sql = (): ReturnType<typeof clientFor> => {
  if (!db) throw new Error("database client not connected");
  return db;
};

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

/**
 * The contract suite names ticket IDs the connector has never seen, but a
 * helpdesk ticket needs its ticket row (foreign key). This store adds that
 * row first, the way intake does; the connector and the suite stay untouched.
 */
function seededStore(): BuiltinHelpdeskStore {
  return {
    ...repos,
    createHelpdeskTicket: async (input) => {
      await sql().query(
        `insert into itsupport.tickets (id, source, raw_title, raw_description, requester_email, idempotency_key, is_test)
         values ($1, 'web', 'seed', 'seed', 'demo.user@example.test', $2, true) on conflict (id) do nothing`,
        [input.ticketId, `it-${input.ticketId}`],
      );
      return repos.createHelpdeskTicket({
        ticketId: input.ticketId,
        priority: input.priority as "P1",
        category: input.category as "hardware",
      });
    },
  };
}

runHelpdeskContract("BuiltinConnector (REST stack)", () => new BuiltinConnector(seededStore()));

function ticketInput() {
  return {
    ticketId: randomUUID(),
    ticketNumber: "ITS-000042",
    isTest: true,
    redactedTitle: "VPN down",
    redactedDescription: "Cannot connect to the VPN.",
    category: "network",
    priority: "P2",
    assignmentGroup: null,
    requesterEmail: null,
  };
}

const created = (result: unknown): CreatedHelpdeskTicket => {
  if (typeof result !== "object" || result === null || !("externalId" in result)) {
    throw new Error("expected a created ticket");
  }
  return result as CreatedHelpdeskTicket;
};

const count = async (table: string, where: string, value: string): Promise<number> =>
  Number(
    (
      await sql().query(`select count(*)::int as n from itsupport.${table} where ${where} = $1`, [
        value,
      ])
    ).rows[0].n,
  );

describe("BuiltinConnector on the REST stack", () => {
  it("a retry after a lost create response finds one ticket and a second create returns it", async () => {
    const connector = new BuiltinConnector(seededStore());
    const body = ticketInput();
    // The first create happened but its answer was lost: the caller asks again.
    const first = created(await connector.createTicket(body));
    const found = await connector.findByExternalRef(body.ticketId);
    expect(found).toEqual({ externalId: first.externalId, number: first.number });
    expect(first.number).toMatch(/^HD[0-9]{7}$/);
    const second = created(await connector.createTicket(body));
    expect(second).toEqual(first);
    expect(await connector.findByExternalRef(body.ticketId)).toEqual(found);
    expect(await count("helpdesk_tickets", "ticket_id", body.ticketId)).toBe(1);
    const flag = await sql().query("select helpdesk from itsupport.tickets where id = $1", [
      body.ticketId,
    ]);
    expect(flag.rows[0].helpdesk).toBe("builtin");
  });

  it("addNote stores a system note", async () => {
    const connector = new BuiltinConnector(seededStore());
    const body = ticketInput();
    const ref = created(await connector.createTicket(body));
    await connector.addNote(ref, "Checked the cable.");
    const note = await sql().query(
      "select author_kind, author_staff_id, body from itsupport.helpdesk_notes where helpdesk_ticket_id = $1",
      [ref.externalId],
    );
    expect(note.rows).toEqual([
      { author_kind: "system", author_staff_id: null, body: "Checked the cable." },
    ]);
  });

  it("updateTicket applies the G3 rules; an illegal move is bad_request and changes nothing", async () => {
    const connector = new BuiltinConnector(seededStore());
    const ref: HelpdeskTicketRef = created(await connector.createTicket(ticketInput()));
    await connector.updateTicket(ref, { state: "resolved" });
    await connector.updateTicket(ref, { state: "resolved" });
    await connector.updateTicket(ref, { state: "closed" });
    const error = await connector
      .updateTicket(ref, { state: "in_progress" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HelpdeskError);
    expect((error as HelpdeskError).code).toBe("bad_request");
    const row = await repos.getHelpdeskTicket(ref.externalId);
    expect(row?.state).toBe("closed");
  });

  it("a ticket that lives in the other helpdesk is refused, with the code only", async () => {
    const connector = new BuiltinConnector(seededStore());
    const body = ticketInput();
    await sql().query(
      `insert into itsupport.tickets (id, source, raw_title, raw_description, requester_email, idempotency_key, helpdesk)
       values ($1, 'web', 'seed', 'seed', 'demo.user@example.test', $2, 'servicenow')`,
      [body.ticketId, `it-${body.ticketId}`],
    );
    const error = await connector.createTicket(body).catch((e: unknown) => e);
    expect((error as HelpdeskError).code).toBe("bad_request");
    expect((error as Error).message).toBe("helpdesk createTicket failed: bad_request");
  });

  it("with the database unreachable, health is down and writes give a typed retryable error", async () => {
    const dead = createRepositories(
      createDbClient({
        SUPABASE_URL: "http://127.0.0.1:9",
        SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
        SUPABASE_DB_SCHEMA: "itsupport",
      }),
    );
    const connector = new BuiltinConnector(dead);
    expect(await connector.health()).toEqual({ status: "down" });
    const ref = { externalId: randomUUID(), number: "HD0000001" };
    for (const attempt of [
      () => connector.createTicket(ticketInput()),
      () => connector.findByExternalRef(randomUUID()),
      () => connector.addNote(ref, "x"),
      () => connector.updateTicket(ref, { state: "resolved" }),
    ]) {
      const error = await attempt().then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(HelpdeskError);
      expect((error as HelpdeskError).code).toBe("unavailable");
      expect((error as HelpdeskError).retryable).toBe(true);
    }
  });
});
