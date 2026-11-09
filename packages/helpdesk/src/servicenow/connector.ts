import { ticketNumberSchema } from "@ai-it-support/shared";
import { HelpdeskError, InstanceAsleepError } from "../errors.js";
import type {
  CreateHelpdeskTicketInput,
  CreatedHelpdeskTicket,
  HelpdeskConnector,
  HelpdeskHealth,
  HelpdeskTicketRef,
  HelpdeskUpdateState,
} from "../types.js";
import { assertNoteBody, assertTicketId, assertUpdateState } from "../validate.js";
import type { ServiceNowClient } from "./client.js";
import { toImpactUrgency, toServiceNowCategory, toServiceNowState } from "./mapping.js";
import { isLookupSafeEmail, sysIdParam, ticketIdParam, userLookupParams } from "./query.js";

const SHORT_DESCRIPTION_MAX = 160;
const E2E_PREFIX = "[E2E] ";
const SYS_ID = /^[0-9a-f]{32}$/;

export interface ServiceNowConnectorOptions {
  client: ServiceNowClient;
  /** `SERVICENOW_DEFAULT_CALLER`: the sys_id used when the requester cannot be found. */
  defaultCaller: string;
}

type Row = Record<string, unknown>;

// Every shape check throws bad_response, which names the operation only.
function rowsOf(result: unknown, operation: string): Row[] {
  if (!Array.isArray(result)) throw new HelpdeskError("bad_response", operation);
  return result as Row[];
}

function sysIdOf(row: Row | undefined, operation: string): string {
  const id = row?.sys_id;
  if (typeof id !== "string" || !SYS_ID.test(id))
    throw new HelpdeskError("bad_response", operation);
  return id;
}

function refOf(row: Row | undefined, operation: string): HelpdeskTicketRef {
  const number = row?.number;
  if (typeof number !== "string") throw new HelpdeskError("bad_response", operation);
  return { externalId: sysIdOf(row, operation), number };
}

/** ServiceNow incidents for the helpdesk interface (resolved points 7, 8, 23). */
export class ServiceNowConnector implements HelpdeskConnector {
  readonly kind = "servicenow" as const;
  private readonly client: ServiceNowClient;
  private readonly defaultCaller: string;
  private readonly groupIds = new Map<string, string>();

  constructor(options: ServiceNowConnectorOptions) {
    this.client = options.client;
    this.defaultCaller = sysIdParam(options.defaultCaller);
  }

  async createTicket(input: CreateHelpdeskTicketInput): Promise<CreatedHelpdeskTicket> {
    // Everything is checked before the first request.
    assertTicketId(input.ticketId);
    if (!ticketNumberSchema.safeParse(input.ticketNumber).success) {
      throw new TypeError("ticketNumber must be a ticket number");
    }
    const category = toServiceNowCategory(input.category);
    const { impact, urgency } = toImpactUrgency(input.priority);
    const group = input.assignmentGroup === null ? null : await this.groupId(input.assignmentGroup);
    const caller = await this.callerId(input.requesterEmail);
    const title = input.isTest ? `${E2E_PREFIX}${input.redactedTitle}` : input.redactedTitle;
    const result = await this.client.post(
      "incident",
      {
        short_description: title.slice(0, SHORT_DESCRIPTION_MAX),
        description: input.redactedDescription,
        category,
        impact,
        urgency,
        caller_id: caller ?? this.defaultCaller,
        ...(group === null ? {} : { assignment_group: group }),
        correlation_id: ticketIdParam(input.ticketId),
        correlation_display: input.ticketNumber,
      },
      ["sys_id", "number"],
    );
    return { ...refOf(result as Row, "createTicket"), callerDefaulted: caller === null };
  }

  async findByExternalRef(ticketId: string): Promise<HelpdeskTicketRef | null> {
    const found = rowsOf(
      await this.client.get("incident", {
        filters: { correlation_id: ticketIdParam(ticketId) },
        fields: ["sys_id", "number"],
        limit: 2,
      }),
      "findByExternalRef",
    );
    if (found.length > 1) throw new HelpdeskError("duplicate_external_ref", "findByExternalRef");
    return found.length === 0 ? null : refOf(found[0], "findByExternalRef");
  }

  async addNote(ref: HelpdeskTicketRef, body: string): Promise<void> {
    assertNoteBody(body);
    await this.client.patch("incident", ref.externalId, { work_notes: body });
  }

  async updateTicket(
    ref: HelpdeskTicketRef,
    update: { state: HelpdeskUpdateState },
  ): Promise<void> {
    assertUpdateState(update.state);
    await this.client.patch("incident", ref.externalId, { ...toServiceNowState(update.state) });
  }

  async health(): Promise<HelpdeskHealth> {
    try {
      await this.client.get("sys_user", { fields: ["sys_id"], limit: 1 });
      return { status: "ok" };
    } catch (error) {
      return { status: error instanceof InstanceAsleepError ? "asleep" : "down" };
    }
  }

  /** The one active user with this email, else null (the caller then defaults). */
  private async callerId(email: string | null): Promise<string | null> {
    if (email === null || !isLookupSafeEmail(email)) return null;
    const found = rowsOf(
      await this.client.get("sys_user", userLookupParams(email)),
      "lookup caller",
    );
    return found.length === 1 ? sysIdOf(found[0], "lookup caller") : null;
  }

  /** Exact-name lookup, cached per connector; none or several is a config error. */
  private async groupId(name: string): Promise<string> {
    const cached = this.groupIds.get(name);
    if (cached !== undefined) return cached;
    const found = rowsOf(
      await this.client.get("sys_user_group", {
        filters: { name },
        fields: ["sys_id"],
        limit: 2,
      }),
      "lookup group",
    );
    if (found.length !== 1) throw new HelpdeskError("config", "lookup group");
    const id = sysIdOf(found[0], "lookup group");
    this.groupIds.set(name, id);
    return id;
  }
}
