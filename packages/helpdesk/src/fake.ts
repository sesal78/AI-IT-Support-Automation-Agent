import { HelpdeskError, InstanceAsleepError, type HelpdeskErrorCode } from "./errors.js";
import type {
  CreateHelpdeskTicketInput,
  CreatedHelpdeskTicket,
  HelpdeskConnector,
  HelpdeskHealth,
  HelpdeskTicketRef,
  HelpdeskUpdateState,
} from "./types.js";
import { assertNoteBody, assertTicketId, assertUpdateState } from "./validate.js";

export interface FakeCall {
  operation: string;
  args: unknown;
}

/** In-memory connector for tests. Numbers tickets FAKE0000001 upwards. */
export class FakeConnector implements HelpdeskConnector {
  readonly kind = "fake" as const;
  readonly calls: FakeCall[] = [];
  protected readonly byTicketId = new Map<string, HelpdeskTicketRef>();
  protected readonly known = new Set<string>();
  private counter = 0;
  private nextFailure: HelpdeskErrorCode | null = null;
  private asleep = false;

  failNext(code: HelpdeskErrorCode): void {
    this.nextFailure = code;
  }

  setAsleep(asleep: boolean): void {
    this.asleep = asleep;
  }

  protected enter(operation: string, args: unknown): void {
    this.calls.push({ operation, args });
    if (this.asleep) throw new InstanceAsleepError(operation);
    if (this.nextFailure) {
      const code = this.nextFailure;
      this.nextFailure = null;
      throw new HelpdeskError(code, operation);
    }
  }

  /** What a create call records: the known fields only, never extra keys. */
  protected recordedInput(input: CreateHelpdeskTicketInput): unknown {
    return {
      ticketId: input.ticketId,
      isTest: input.isTest,
      redactedTitle: input.redactedTitle,
      redactedDescription: input.redactedDescription,
      category: input.category,
      priority: input.priority,
      assignmentGroup: input.assignmentGroup,
      requesterEmail: input.requesterEmail,
    };
  }

  async createTicket(input: CreateHelpdeskTicketInput): Promise<CreatedHelpdeskTicket> {
    assertTicketId(input.ticketId);
    this.enter("createTicket", this.recordedInput(input));
    this.counter += 1;
    const number = `FAKE${String(this.counter).padStart(7, "0")}`;
    const ref = { externalId: `fake-${number}`, number };
    this.byTicketId.set(input.ticketId, ref);
    this.known.add(ref.externalId);
    return { ...ref, callerDefaulted: input.requesterEmail === null };
  }

  async findByExternalRef(ticketId: string): Promise<HelpdeskTicketRef | null> {
    assertTicketId(ticketId);
    this.enter("findByExternalRef", { ticketId });
    const ref = this.byTicketId.get(ticketId);
    return ref ? { ...ref } : null;
  }

  async addNote(ref: HelpdeskTicketRef, body: string): Promise<void> {
    assertNoteBody(body);
    this.enter("addNote", { externalId: ref.externalId, length: body.length });
    if (!this.known.has(ref.externalId)) throw new HelpdeskError("not_found", "addNote");
  }

  async updateTicket(
    ref: HelpdeskTicketRef,
    update: { state: HelpdeskUpdateState },
  ): Promise<void> {
    assertUpdateState(update.state);
    this.enter("updateTicket", { externalId: ref.externalId, state: update.state });
    if (!this.known.has(ref.externalId)) throw new HelpdeskError("not_found", "updateTicket");
  }

  async health(): Promise<HelpdeskHealth> {
    this.calls.push({ operation: "health", args: {} });
    if (this.asleep) return { status: "asleep" };
    if (this.nextFailure) {
      const code = this.nextFailure;
      this.nextFailure = null;
      throw new HelpdeskError(code, "health");
    }
    return { status: "ok" };
  }
}
