import { randomUUID } from "node:crypto";
import { IllegalHelpdeskTransitionError, assertHelpdeskTransition } from "@ai-it-support/shared";
import type { HelpdeskState } from "@ai-it-support/shared";
import { describe, expect, it } from "vitest";
import { BuiltinConnector, type BuiltinHelpdeskStore } from "./builtin.js";
import { HelpdeskError } from "./errors.js";
import type { CreateHelpdeskTicketInput } from "./types.js";

// A store with the semantics of the db repositories: one row per ticket, a
// duplicate create returns the existing row, a compare-and-set state move and
// an unknown helpdesk ticket id breaks the foreign key (code 23503).
const ERROR_DETAIL = ["private", "database", "detail"].join("-");

class FkError extends Error {
  readonly code = "23503";
}
class ConflictError extends Error {
  override name = "HelpdeskConflictError";
}

function memoryStore() {
  const rows = new Map<
    string,
    { id: string; ticket_id: string; number: string; state: HelpdeskState }
  >();
  const flags = new Map<string, string>();
  const notes: { id: string; body: string }[] = [];
  const calls: string[] = [];
  let down: Error | null = null;
  const enter = (name: string) => {
    calls.push(name);
    if (down) throw down;
  };
  const byId = (id: string) => [...rows.values()].find((row) => row.id === id) ?? null;
  const store: BuiltinHelpdeskStore = {
    async createHelpdeskTicket(input) {
      enter("create");
      const existing = rows.get(input.ticketId);
      if (existing) return { helpdeskTicket: existing, created: false };
      const row = {
        id: randomUUID(),
        ticket_id: input.ticketId,
        number: `HD${String(rows.size + 1).padStart(7, "0")}`,
        state: "new" as HelpdeskState,
      };
      rows.set(input.ticketId, row);
      return { helpdeskTicket: row, created: true };
    },
    async getHelpdeskTicketByTicketId(ticketId) {
      enter("getByTicket");
      return rows.get(ticketId) ?? null;
    },
    async getHelpdeskTicket(id) {
      enter("getById");
      return byId(id);
    },
    async addSystemNote(id, body) {
      enter("note");
      if (!byId(id)) throw new FkError(ERROR_DETAIL);
      notes.push({ id, body });
      return { id: randomUUID() };
    },
    async setHelpdeskState(id, from, to) {
      enter("state");
      assertHelpdeskTransition(from, to);
      const row = byId(id);
      if (!row) throw new Error(ERROR_DETAIL);
      if (row.state !== from) return { changed: false, helpdeskTicket: row };
      row.state = to;
      return { changed: true, helpdeskTicket: row };
    },
    async setTicketHelpdesk(ticketId, kind) {
      enter("flag");
      const stored = flags.get(ticketId);
      if (stored !== undefined && stored !== kind) throw new ConflictError(ERROR_DETAIL);
      flags.set(ticketId, kind);
      return { changed: stored === undefined };
    },
  };
  return {
    store,
    rows,
    flags,
    notes,
    calls,
    setDown: (error: Error | null) => {
      down = error;
    },
  };
}

function input(extra: Partial<CreateHelpdeskTicketInput> = {}): CreateHelpdeskTicketInput {
  return {
    ticketId: randomUUID(),
    ticketNumber: "ITS-000042",
    isTest: true,
    redactedTitle: "Printer offline",
    redactedDescription: "The printer on level 2 is offline.",
    category: "hardware",
    priority: "P3",
    assignmentGroup: null,
    requesterEmail: null,
    ...extra,
  };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error,
  );
}

describe("BuiltinConnector", () => {
  it("creates the helpdesk ticket, then records the helpdesk on the ticket", async () => {
    const mem = memoryStore();
    const body = input();
    const created = await new BuiltinConnector(mem.store).createTicket(body);
    const row = mem.rows.get(body.ticketId);
    expect(created).toEqual({ externalId: row?.id, number: "HD0000001", callerDefaulted: false });
    expect(mem.flags.get(body.ticketId)).toBe("builtin");
    expect(mem.calls).toEqual(["create", "flag"]);
  });

  it("a second create after a lost response returns the same ticket, never a second one", async () => {
    const mem = memoryStore();
    const connector = new BuiltinConnector(mem.store);
    const body = input();
    const first = await connector.createTicket(body);
    const again = await connector.createTicket(body);
    expect(again).toEqual(first);
    expect(mem.rows.size).toBe(1);
    expect(await connector.findByExternalRef(body.ticketId)).toEqual({
      externalId: "externalId" in first ? first.externalId : "",
      number: "number" in first ? first.number : "",
    });
  });

  it("findByExternalRef is null for a ticket without a helpdesk ticket", async () => {
    const connector = new BuiltinConnector(memoryStore().store);
    expect(await connector.findByExternalRef(randomUUID())).toBeNull();
  });

  it("addNote writes a note; an unknown or malformed ref is not_found", async () => {
    const mem = memoryStore();
    const connector = new BuiltinConnector(mem.store);
    const ref = await connector.createTicket(input());
    if ("skipped" in ref) throw new Error("unexpected skip");
    await connector.addNote(ref, "Checked the cable.");
    expect(mem.notes).toEqual([{ id: ref.externalId, body: "Checked the cable." }]);
    for (const externalId of [randomUUID(), randomUUID().replaceAll("-", "")]) {
      const error = await failure(connector.addNote({ externalId, number: "HD0000009" }, "x"));
      expect(error).toBeInstanceOf(HelpdeskError);
      expect((error as HelpdeskError).code).toBe("not_found");
      expect(JSON.stringify({ ...(error as object), m: (error as Error).message })).not.toContain(
        ERROR_DETAIL,
      );
    }
  });

  it("validates before it touches the store", async () => {
    const mem = memoryStore();
    const connector = new BuiltinConnector(mem.store);
    const ref = { externalId: randomUUID(), number: "HD0000001" };
    expect(await failure(connector.createTicket(input({ ticketId: "nope" })))).toBeInstanceOf(
      TypeError,
    );
    expect(await failure(connector.findByExternalRef("nope"))).toBeInstanceOf(TypeError);
    expect(await failure(connector.addNote(ref, ""))).toBeInstanceOf(TypeError);
    expect(await failure(connector.addNote(ref, "x".repeat(5001)))).toBeInstanceOf(TypeError);
    expect(await failure(connector.updateTicket(ref, { state: "new" as never }))).toBeInstanceOf(
      TypeError,
    );
    expect(mem.calls).toEqual([]);
  });

  it("updateTicket follows the G3 moves; the same state again is a no-op", async () => {
    const mem = memoryStore();
    const connector = new BuiltinConnector(mem.store);
    const body = input();
    const ref = await connector.createTicket(body);
    if ("skipped" in ref) throw new Error("unexpected skip");
    for (const state of ["in_progress", "in_progress", "resolved", "closed"] as const) {
      await connector.updateTicket(ref, { state });
    }
    expect(mem.rows.get(body.ticketId)?.state).toBe("closed");
  });

  it("an illegal move is a bad_request HelpdeskError and the state stays", async () => {
    const mem = memoryStore();
    const connector = new BuiltinConnector(mem.store);
    const body = input();
    const ref = await connector.createTicket(body);
    if ("skipped" in ref) throw new Error("unexpected skip");
    await connector.updateTicket(ref, { state: "closed" });
    const error = await failure(connector.updateTicket(ref, { state: "in_progress" }));
    expect(error).toBeInstanceOf(HelpdeskError);
    expect((error as HelpdeskError).code).toBe("bad_request");
    expect(error).not.toBeInstanceOf(IllegalHelpdeskTransitionError);
    expect(mem.rows.get(body.ticketId)?.state).toBe("closed");
    const missing = await failure(
      connector.updateTicket(
        { externalId: randomUUID(), number: "HD0000009" },
        { state: "resolved" },
      ),
    );
    expect((missing as HelpdeskError).code).toBe("not_found");
  });

  it("a state that moved under us gives a retryable error unless it already is the target", async () => {
    const mem = memoryStore();
    const connector = new BuiltinConnector(mem.store);
    const body = input();
    const ref = await connector.createTicket(body);
    if ("skipped" in ref) throw new Error("unexpected skip");
    const row = mem.rows.get(body.ticketId);
    const real = mem.store.getHelpdeskTicket;
    // The read answers "new", then a staff member moves it before our write.
    mem.store.getHelpdeskTicket = async (id) => {
      const answer = await real(id);
      if (row) row.state = "on_hold";
      return answer && { ...answer, state: "new" };
    };
    const error = await failure(connector.updateTicket(ref, { state: "in_progress" }));
    expect((error as HelpdeskError).code).toBe("unavailable");
    expect((error as HelpdeskError).retryable).toBe(true);
    mem.store.getHelpdeskTicket = async (id) => {
      const answer = await real(id);
      if (row) row.state = "in_progress";
      return answer && { ...answer, state: "new" };
    };
    await expect(connector.updateTicket(ref, { state: "in_progress" })).resolves.toBeUndefined();
  });

  it("a ticket that lives in another helpdesk is bad_request", async () => {
    const mem = memoryStore();
    const body = input();
    mem.flags.set(body.ticketId, "servicenow");
    const error = await failure(new BuiltinConnector(mem.store).createTicket(body));
    expect((error as HelpdeskError).code).toBe("bad_request");
    expect((error as Error).message).not.toContain(ERROR_DETAIL);
  });

  it("health is ok on one cheap read and down on any failure, never asleep", async () => {
    const mem = memoryStore();
    const connector = new BuiltinConnector(mem.store);
    expect(await connector.health()).toEqual({ status: "ok" });
    expect(mem.calls).toEqual(["getByTicket"]);
    mem.setDown(new Error(ERROR_DETAIL));
    expect(await connector.health()).toEqual({ status: "down" });
  });

  it("a database outage gives typed, retryable errors from every call, with no raw detail", async () => {
    const mem = memoryStore();
    const connector = new BuiltinConnector(mem.store);
    const ref = await connector.createTicket(input());
    if ("skipped" in ref) throw new Error("unexpected skip");
    mem.setDown(new Error(ERROR_DETAIL));
    const attempts = [
      connector.createTicket(input()),
      connector.findByExternalRef(randomUUID()),
      connector.addNote(ref, "x"),
      connector.updateTicket(ref, { state: "resolved" }),
    ];
    for (const attempt of attempts) {
      const error = await failure(attempt);
      expect(error).toBeInstanceOf(HelpdeskError);
      expect((error as HelpdeskError).code).toBe("unavailable");
      expect((error as HelpdeskError).retryable).toBe(true);
      expect(JSON.stringify({ ...(error as object), m: (error as Error).message })).not.toContain(
        ERROR_DETAIL,
      );
    }
  });
});
