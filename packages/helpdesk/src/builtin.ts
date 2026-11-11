import { IllegalHelpdeskTransitionError, type HelpdeskState } from "@ai-it-support/shared";
import { HelpdeskError } from "./errors.js";
import type {
  CreateHelpdeskTicketInput,
  CreatedHelpdeskTicket,
  HelpdeskConnector,
  HelpdeskHealth,
  HelpdeskTicketRef,
  HelpdeskUpdateState,
} from "./types.js";
import { assertNoteBody, assertTicketId, assertUpdateState } from "./validate.js";

interface HelpdeskRow {
  id: string;
  number: string;
}

/**
 * What the connector needs from the P5-T12 repositories (`packages/db`). The
 * db `Repositories` object satisfies it, so this package does not depend on
 * `packages/db`.
 */
export interface BuiltinHelpdeskStore {
  createHelpdeskTicket(input: {
    ticketId: string;
    priority: string;
    category: string;
  }): Promise<{ helpdeskTicket: HelpdeskRow; created: boolean }>;
  getHelpdeskTicketByTicketId(ticketId: string): Promise<HelpdeskRow | null>;
  getHelpdeskTicket(id: string): Promise<(HelpdeskRow & { state: HelpdeskState }) | null>;
  addSystemNote(helpdeskTicketId: string, body: string): Promise<unknown>;
  setHelpdeskState(
    id: string,
    from: HelpdeskState,
    to: HelpdeskState,
  ): Promise<{ changed: boolean; helpdeskTicket: { state: HelpdeskState } }>;
  setTicketHelpdesk(ticketId: string, kind: "builtin"): Promise<{ changed: boolean }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The health read asks for a ticket that does not exist: ok means "the table answers".
const NO_TICKET = "00000000-0000-4000-8000-000000000000";
const FOREIGN_KEY_VIOLATION = "23503";

/**
 * Maps whatever the store throws to the interface's typed errors. A bad
 * argument stays a TypeError or RangeError; everything else becomes a
 * HelpdeskError whose message names the operation and the code only, never the
 * database text (it can echo a value).
 */
function toHelpdeskError(error: unknown, operation: string): unknown {
  if (error instanceof HelpdeskError || error instanceof TypeError || error instanceof RangeError) {
    return error;
  }
  if (error instanceof IllegalHelpdeskTransitionError) {
    return new HelpdeskError("bad_request", operation);
  }
  const named = error as { name?: unknown; code?: unknown } | null;
  // The ticket lives in the other helpdesk (G2): the caller's guard should have refused first.
  if (named?.name === "HelpdeskConflictError") return new HelpdeskError("bad_request", operation);
  if (named?.code === FOREIGN_KEY_VIOLATION) return new HelpdeskError("not_found", operation);
  return new HelpdeskError("unavailable", operation);
}

async function guarded<T>(operation: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw toHelpdeskError(error, operation);
  }
}

/** The ref of a helpdesk ticket: its row id (a UUID) and its HD number. */
function refOf(row: HelpdeskRow): HelpdeskTicketRef {
  return { externalId: row.id, number: row.number };
}

function helpdeskTicketId(ref: HelpdeskTicketRef, operation: string): string {
  if (typeof ref.externalId !== "string" || !UUID.test(ref.externalId)) {
    throw new HelpdeskError("not_found", operation);
  }
  return ref.externalId;
}

/**
 * The built-in helpdesk (plan §6.3.1 G2-G4, P5-T13) on the P5-T12 repositories.
 * Only redacted text reaches it. It never reports `asleep`: the database is
 * either answering or `down`.
 */
export class BuiltinConnector implements HelpdeskConnector {
  readonly kind = "builtin" as const;

  constructor(private readonly store: BuiltinHelpdeskStore) {}

  /**
   * Creates the helpdesk ticket, then records `tickets.helpdesk = builtin`
   * (G2: only after a real helpdesk ticket exists). A ticket has one helpdesk
   * ticket: a repeat call (a lost response, a retry) returns the existing one.
   * Only the priority and category are stored; the text fields stay with the ticket.
   */
  async createTicket(input: CreateHelpdeskTicketInput): Promise<CreatedHelpdeskTicket> {
    assertTicketId(input.ticketId);
    return guarded("createTicket", async () => {
      const { helpdeskTicket } = await this.store.createHelpdeskTicket({
        ticketId: input.ticketId,
        // The repository checks both values and throws a TypeError for an unknown one.
        priority: input.priority,
        category: input.category,
      });
      await this.store.setTicketHelpdesk(input.ticketId, "builtin");
      return { ...refOf(helpdeskTicket), callerDefaulted: false };
    });
  }

  async findByExternalRef(ticketId: string): Promise<HelpdeskTicketRef | null> {
    assertTicketId(ticketId);
    return guarded("findByExternalRef", async () => {
      const row = await this.store.getHelpdeskTicketByTicketId(ticketId);
      return row === null ? null : refOf(row);
    });
  }

  async addNote(ref: HelpdeskTicketRef, body: string): Promise<void> {
    assertNoteBody(body);
    return guarded("addNote", async () => {
      await this.store.addSystemNote(helpdeskTicketId(ref, "addNote"), body);
    });
  }

  /**
   * Moves the helpdesk ticket to `update.state` with the G3 rules. The same
   * state again is a no-op, so a retry after a lost response succeeds. An
   * illegal move is `bad_request`; a state that changed between the read and
   * the write is a retryable `unavailable`, so the next try reads it again.
   */
  async updateTicket(
    ref: HelpdeskTicketRef,
    update: { state: HelpdeskUpdateState },
  ): Promise<void> {
    assertUpdateState(update.state);
    return guarded("updateTicket", async () => {
      const id = helpdeskTicketId(ref, "updateTicket");
      const current = await this.store.getHelpdeskTicket(id);
      if (current === null) throw new HelpdeskError("not_found", "updateTicket");
      if (current.state === update.state) return;
      const moved = await this.store.setHelpdeskState(id, current.state, update.state);
      if (!moved.changed && moved.helpdeskTicket.state !== update.state) {
        throw new HelpdeskError("unavailable", "updateTicket");
      }
    });
  }

  /** One cheap read. Any failure is `down`; this connector is never `asleep`. */
  async health(): Promise<HelpdeskHealth> {
    try {
      await this.store.getHelpdeskTicketByTicketId(NO_TICKET);
      return { status: "ok" };
    } catch {
      return { status: "down" };
    }
  }
}
