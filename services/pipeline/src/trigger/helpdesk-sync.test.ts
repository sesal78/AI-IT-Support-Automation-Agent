import { IncidentConflictError, type Redaction, type Ticket, type Triage } from "@ai-it-support/db";
import {
  HelpdeskError,
  type CreateHelpdeskTicketInput,
  type CreatedHelpdeskTicket,
  type HelpdeskConnector,
  type HelpdeskTicketRef,
} from "@ai-it-support/helpdesk";
import { assertTransition, type TicketStatus } from "@ai-it-support/shared";
import { describe, expect, it, vi } from "vitest";
import { helpdeskSyncPayload, type HelpdeskSyncDeps } from "./helpdesk-sync.js";

const TICKET = "00000000-0000-4000-8000-000000000001";
const KB = "00000000-0000-4000-8000-00000000000b";
const NOW = "2026-11-10T10:00:00.000Z";
const SYS_ID = "a".repeat(31) + "1";
const INC = "INC0010001";
const MARK = {
  title: "MARKER-RAW-TITLE",
  description: "MARKER-RAW-DESCRIPTION",
  name: "MARKER-REQUESTER-NAME",
  email: "marker.requester@example.test",
};

function ticket(status = "auto", isTest = false): Ticket {
  return {
    id: TICKET,
    ticket_number: "ITS-000042",
    source: "web",
    raw_title: MARK.title,
    raw_description: MARK.description,
    requester_email: MARK.email,
    requester_name: MARK.name,
    department: "Finance",
    status,
    servicenow_sys_id: null,
    servicenow_number: null,
    idempotency_key: "k",
    is_test: isTest,
    created_at: NOW,
  };
}

function triage(over: Partial<Triage> = {}): Triage {
  return {
    ticket_id: TICKET,
    sensitive: false,
    sensitive_flags: [],
    checker: "typesafe",
    created_at: NOW,
    category: "network",
    subcategory: null,
    priority: "P3",
    urgency: "medium",
    assignment_group: "Network Support",
    route: "auto",
    probabilities: {},
    flags: [],
    grounding_score: 0.9,
    kb_article_ids: [KB],
    suggested_fix: { steps: ["Restart the VPN client"], caveats: ["Needs admin rights"] },
    model_versions: null,
    triaged_at: NOW,
    ...over,
  };
}

const redaction: Redaction = {
  ticket_id: TICKET,
  redacted_title: "VPN [redacted] down",
  redacted_description: "Cannot connect, contact [email]",
  redaction_log: [],
  created_at: NOW,
};

interface Options {
  found?: Ticket | null;
  triage?: Triage | null;
  redaction?: Redaction | null;
  events?: string[];
  incidentExists?: boolean;
  /** Errors thrown by the next calls of a connector method, in order (undefined = succeed). */
  failures?: Partial<Record<"createTicket" | "findByExternalRef" | "addNote", unknown[]>>;
  /** createTicket creates the incident, then throws: the response is lost. */
  loseCreateResponse?: boolean;
  callerDefaulted?: boolean;
  shadowMode?: boolean;
  e2eMode?: boolean;
  connectorFactoryError?: unknown;
  incidentConflict?: boolean;
}

export function harness(options: Options = {}) {
  const calls: string[] = [];
  const status = { value: (options.found ?? ticket()).status as string };
  const events: Array<{ type: string; payload: Record<string, unknown> }> = (
    options.events ?? []
  ).map((type) => ({ type, payload: {} }));
  const statusWrites: string[] = [];
  const stored: { incident: { sysId: string; number: string } | null } = { incident: null };
  const incidents = new Map<string, HelpdeskTicketRef>();
  if (options.incidentExists) incidents.set(TICKET, { externalId: SYS_ID, number: INC });
  const failures = {
    createTicket: [...(options.failures?.createTicket ?? [])],
    findByExternalRef: [...(options.failures?.findByExternalRef ?? [])],
    addNote: [...(options.failures?.addNote ?? [])],
  };
  const fail = (name: keyof typeof failures) => {
    if (failures[name].length === 0) return;
    const next = failures[name].shift();
    if (next !== undefined) throw next;
  };
  const sent = {
    creates: [] as CreateHelpdeskTicketInput[],
    notes: [] as string[],
  };

  const connector: HelpdeskConnector = {
    kind: "servicenow",
    createTicket: vi.fn(
      async (input: CreateHelpdeskTicketInput): Promise<CreatedHelpdeskTicket> => {
        calls.push("createTicket");
        fail("createTicket");
        sent.creates.push(input);
        const ref = { externalId: SYS_ID, number: INC };
        incidents.set(input.ticketId, ref);
        if (options.loseCreateResponse) {
          options.loseCreateResponse = false;
          throw new HelpdeskError("unavailable", "createTicket");
        }
        return { ...ref, callerDefaulted: options.callerDefaulted ?? false };
      },
    ),
    findByExternalRef: vi.fn(async (ticketId: string) => {
      calls.push("findByExternalRef");
      fail("findByExternalRef");
      return incidents.get(ticketId) ?? null;
    }),
    addNote: vi.fn(async (_ref: HelpdeskTicketRef, body: string) => {
      calls.push("addNote");
      fail("addNote");
      sent.notes.push(body);
    }),
    updateTicket: vi.fn(async () => undefined),
    health: vi.fn(async () => ({ status: "ok" as const })),
  };

  const repos = {
    getTicket: vi.fn(async () => {
      calls.push("getTicket");
      return options.found === null
        ? null
        : { ...(options.found ?? ticket()), status: status.value };
    }),
    getTriage: vi.fn(async () => (options.triage === undefined ? triage() : options.triage)),
    getRedaction: vi.fn(async () =>
      options.redaction === undefined ? redaction : options.redaction,
    ),
    getKbArticlesByIds: vi.fn(async () => [{ id: KB, slug: "vpn-reset", title: "Reset VPN" }]),
    setTicketStatus: vi.fn(async (_id: string, to: string) => {
      calls.push(`status:${to}`);
      if (status.value === to) return { changed: false };
      assertTransition(status.value as TicketStatus, to as TicketStatus);
      status.value = to;
      statusWrites.push(to);
      return { changed: true };
    }),
    setTicketIncident: vi.fn(async (_id: string, incident: { sysId: string; number: string }) => {
      calls.push("setTicketIncident");
      if (options.incidentConflict) throw new IncidentConflictError("setTicketIncident");
      if (stored.incident?.sysId === incident.sysId) return { changed: false };
      stored.incident = incident;
      return { changed: true };
    }),
    listEventTypes: vi.fn(async (_id: string, types: readonly string[]) => [
      ...new Set(events.map((event) => event.type).filter((type) => types.includes(type))),
    ]),
    addEvent: vi.fn(async (_id: string, type: string, payload: Record<string, unknown> = {}) => {
      calls.push(`event:${type}`);
      events.push({ type, payload });
      return {} as never;
    }),
  };
  const alert = vi.fn(async () => undefined);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const createConnector = vi.fn(() => {
    if (options.connectorFactoryError) throw options.connectorFactoryError;
    return connector;
  });
  const deps: HelpdeskSyncDeps = {
    repos,
    createConnector,
    shadowMode: options.shadowMode ?? false,
    e2eMode: options.e2eMode ?? false,
    alert,
    logger,
  };
  return {
    deps,
    calls,
    repos,
    connector,
    createConnector,
    alert,
    logger,
    events,
    status,
    statusWrites,
    stored,
    sent,
    incidents,
  };
}

describe("helpdeskSyncPayload", () => {
  it("accepts a ticket id and test overrides and rejects a non-UUID or an unknown switch", () => {
    expect(helpdeskSyncPayload.safeParse({ ticketId: TICKET }).success).toBe(true);
    expect(
      helpdeskSyncPayload.safeParse({ ticketId: TICKET, testOverrides: { shadowMode: true } })
        .success,
    ).toBe(true);
    expect(helpdeskSyncPayload.safeParse({ ticketId: "ITS-000042" }).success).toBe(false);
    expect(
      helpdeskSyncPayload.safeParse({ ticketId: TICKET, testOverrides: { nope: true } }).success,
    ).toBe(false);
  });
});
