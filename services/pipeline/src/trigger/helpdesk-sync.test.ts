import { IncidentConflictError, type Redaction, type Ticket, type Triage } from "@ai-it-support/db";
import {
  HelpdeskError,
  type CreateHelpdeskTicketInput,
  type CreatedHelpdeskTicket,
  type HelpdeskConnector,
  type HelpdeskErrorCode,
  type HelpdeskTicketRef,
} from "@ai-it-support/helpdesk";
import { assertTransition, type TicketStatus } from "@ai-it-support/shared";
import { AbortTaskRunError } from "@trigger.dev/sdk";
import { describe, expect, it, vi } from "vitest";
import { helpdeskSyncPayload, runHelpdeskSync, type HelpdeskSyncDeps } from "./helpdesk-sync.js";

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

function harness(options: Options = {}) {
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

type Harness = ReturnType<typeof harness>;
const run = (h: Harness, testOverrides?: Record<string, unknown>, attempt = 1) =>
  runHelpdeskSync(
    { ticketId: TICKET, ...(testOverrides ? { testOverrides } : {}) },
    h.deps,
    attempt,
  );
const eventTypes = (h: Harness) => h.events.map((event) => event.type);
const payloadOf = (h: Harness, type: string) =>
  h.events.find((event) => event.type === type)?.payload;

/** Everything that left the task except the connector's own create input. */
function outbound(h: Harness): string {
  const repoCalls = Object.values(h.repos).map((fn) => fn.mock.calls as unknown[]);
  const logs = Object.values(h.logger).flatMap((fn) => fn.mock.calls);
  return JSON.stringify([repoCalls, logs, h.alert.mock.calls, h.sent.notes]);
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

describe("runHelpdeskSync: the incident is created", () => {
  it.each(["auto", "approved"])(
    "an %s ticket ends incident_created with its events",
    async (from) => {
      const h = harness({ found: ticket(from) });
      await expect(run(h)).resolves.toEqual({
        ticketId: TICKET,
        incident: { externalId: SYS_ID, number: INC },
      });
      expect(eventTypes(h)).toEqual([
        "helpdesk_sync_started",
        "incident_created",
        "helpdesk_note_added",
      ]);
      expect(payloadOf(h, "incident_created")).toEqual({ externalId: SYS_ID, number: INC });
      expect(payloadOf(h, "helpdesk_note_added")).toEqual({ externalId: SYS_ID });
      expect(h.statusWrites).toEqual(["helpdesk_pending", "incident_created"]);
      expect(h.stored.incident).toEqual({ sysId: SYS_ID, number: INC });
    },
  );

  it("calls the steps in the specified order", async () => {
    const h = harness();
    await run(h);
    expect(h.calls.filter((c) => c !== "getTicket")).toEqual([
      "status:helpdesk_pending",
      "event:helpdesk_sync_started",
      "findByExternalRef",
      "createTicket",
      "setTicketIncident",
      "event:incident_created",
      "addNote",
      "event:helpdesk_note_added",
      "status:incident_created",
    ]);
  });

  it("sends the redaction, triage fields, ticket number and requester email to the connector", async () => {
    const h = harness({ found: ticket("auto", true) });
    await run(h);
    expect(h.sent.creates).toEqual([
      {
        ticketId: TICKET,
        ticketNumber: "ITS-000042",
        isTest: true,
        redactedTitle: redaction.redacted_title,
        redactedDescription: redaction.redacted_description,
        category: "network",
        priority: "P3",
        assignmentGroup: "Network Support",
        requesterEmail: MARK.email,
      },
    ]);
  });

  it("adds one work note with the triage fields, KB slugs and fix steps", async () => {
    const h = harness();
    await run(h);
    expect(h.sent.notes).toHaveLength(1);
    const note = h.sent.notes[0] ?? "";
    expect(note).toContain("ITS-000042");
    expect(note).toContain("Category: network");
    expect(note).toContain("Priority: P3");
    expect(note).toContain("Assignment group: Network Support");
    expect(note).toContain("KB articles: vpn-reset");
    expect(note).toContain("1. Restart the VPN client");
    expect(note).toContain("- Needs admin rights");
  });

  it("writes caller_defaulted before incident_created when the connector flags it", async () => {
    const h = harness({ callerDefaulted: true });
    await run(h);
    expect(eventTypes(h)).toEqual([
      "helpdesk_sync_started",
      "caller_defaulted",
      "incident_created",
      "helpdesk_note_added",
    ]);
  });

  it("uses an incident that findByExternalRef already knows, without a create call", async () => {
    const h = harness({ incidentExists: true });
    await run(h);
    expect(h.connector.createTicket).not.toHaveBeenCalled();
    expect(eventTypes(h)).toEqual([
      "helpdesk_sync_started",
      "incident_created",
      "helpdesk_note_added",
    ]);
    expect(h.stored.incident).toEqual({ sysId: SYS_ID, number: INC });
  });

  it("T5.I.02: a lost create response is found by the retry; one incident, incident_created once", async () => {
    const h = harness({ loseCreateResponse: true });
    await expect(run(h, undefined, 1)).rejects.toMatchObject({ code: "unavailable" });
    expect(h.status.value).toBe("helpdesk_pending");
    await run(h, undefined, 2);
    expect(h.incidents.size).toBe(1);
    expect(h.connector.createTicket).toHaveBeenCalledTimes(1);
    expect(eventTypes(h).filter((type) => type === "incident_created")).toHaveLength(1);
    expect(eventTypes(h).filter((type) => type === "helpdesk_sync_started")).toHaveLength(1);
    expect(h.status.value).toBe("incident_created");
  });

  it("T5.I.03: a 500 then success ends incident_created on the second attempt", async () => {
    const h = harness({
      failures: { createTicket: [new HelpdeskError("unavailable", "createTicket")] },
    });
    await expect(run(h, undefined, 1)).rejects.toMatchObject({ code: "unavailable" });
    await expect(run(h, undefined, 2)).resolves.toMatchObject({ incident: { number: INC } });
    expect(h.status.value).toBe("incident_created");
  });

  it("on a retry after the note failed: no second incident_created, the note is sent again, once", async () => {
    const h = harness({ failures: { addNote: [new HelpdeskError("unavailable", "addNote")] } });
    await expect(run(h, undefined, 1)).rejects.toMatchObject({ code: "unavailable" });
    expect(eventTypes(h)).toEqual(["helpdesk_sync_started", "incident_created"]);
    await run(h, undefined, 2);
    expect(eventTypes(h)).toEqual([
      "helpdesk_sync_started",
      "incident_created",
      "helpdesk_note_added",
    ]);
    expect(h.sent.notes).toHaveLength(1);
  });

  it("on a retry from helpdesk_pending with every event written: only the status moves", async () => {
    const h = harness({
      found: ticket("helpdesk_pending"),
      incidentExists: true,
      events: ["helpdesk_sync_started", "incident_created", "helpdesk_note_added"],
    });
    await run(h);
    expect(h.events).toHaveLength(3);
    expect(h.connector.addNote).not.toHaveBeenCalled();
    expect(h.statusWrites).toEqual(["incident_created"]);
  });
});

describe("runHelpdeskSync: the guard", () => {
  it.each([
    "rejected",
    "escalated_manual",
    "review_pending",
    "triaged",
    "failed",
    "new",
    "redacted",
  ])(
    "T5.I.05: a forged trigger for a %s ticket is refused, loudly, with no connector",
    async (status) => {
      const h = harness({ found: ticket(status) });
      await expect(run(h)).resolves.toEqual({ ticketId: TICKET, refused: true });
      expect(h.events).toEqual([{ type: "sync_refused", payload: { status } }]);
      expect(h.alert).toHaveBeenCalledWith("sync_refused", { ticketId: TICKET });
      expect(h.createConnector).not.toHaveBeenCalled();
      expect(h.repos.setTicketStatus).not.toHaveBeenCalled();
      expect(h.status.value).toBe(status);
    },
  );

  it.each(["incident_created", "incident_skipped_shadow"])(
    "a %s ticket is skipped without a write",
    async (status) => {
      const h = harness({ found: ticket(status) });
      await expect(run(h)).resolves.toEqual({ ticketId: TICKET, skipped: true });
      expect(h.events).toEqual([]);
      expect(h.alert).not.toHaveBeenCalled();
      expect(h.createConnector).not.toHaveBeenCalled();
      expect(h.repos.setTicketStatus).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["no ticket", { found: null }],
    ["no triage row", { triage: null }],
    ["a triage row without a category", { triage: triage({ category: null }) }],
    ["a triage row without a priority", { triage: triage({ priority: null }) }],
    ["no redaction", { redaction: null }],
  ] as Array<[string, Options]>)(
    "aborts the run for %s, before any write",
    async (_name, options) => {
      const h = harness(options);
      await expect(run(h)).rejects.toBeInstanceOf(AbortTaskRunError);
      expect(h.repos.setTicketStatus).not.toHaveBeenCalled();
      expect(h.repos.addEvent).not.toHaveBeenCalled();
      expect(h.createConnector).not.toHaveBeenCalled();
    },
  );
});

describe("runHelpdeskSync: shadow mode", () => {
  const expectShadow = (h: Harness) => {
    expect(eventTypes(h)).toEqual(["helpdesk_sync_started", "shadow_skipped"]);
    expect(payloadOf(h, "shadow_skipped")).toEqual({ operation: "create" });
    expect(h.status.value).toBe("incident_skipped_shadow");
    expect(h.connector.createTicket).not.toHaveBeenCalled();
    expect(h.connector.addNote).not.toHaveBeenCalled();
    expect(h.repos.setTicketIncident).not.toHaveBeenCalled();
  };

  it("SHADOW_MODE=true: incident_skipped_shadow, shadow_skipped { operation: create }, no write call", async () => {
    const h = harness({ shadowMode: true });
    await expect(run(h)).resolves.toEqual({ ticketId: TICKET, shadow: true });
    expectShadow(h);
    expect(h.logger.info).toHaveBeenCalledWith(
      "helpdesk-sync: shadow_skipped",
      expect.objectContaining({ operation: "create", ticketId: TICKET }),
    );
  });

  it("the shadowMode switch on an e2e test ticket turns shadow mode on", async () => {
    const h = harness({ e2eMode: true, found: ticket("auto", true) });
    await run(h, { shadowMode: true });
    expectShadow(h);
  });

  it.each([
    ["a ticket that is not a test ticket", { e2eMode: true, found: ticket("auto", false) }],
    ["E2E_MODE=false", { e2eMode: false, found: ticket("auto", true) }],
  ] as Array<[string, Options]>)(
    "the shadowMode switch has no effect with %s",
    async (_name, options) => {
      const h = harness(options);
      await run(h, { shadowMode: true });
      expect(h.status.value).toBe("incident_created");
      expect(h.connector.createTicket).toHaveBeenCalledTimes(1);
    },
  );

  it("an incident that exists already is stored, but its note is skipped and not recorded", async () => {
    const h = harness({ shadowMode: true, incidentExists: true });
    await run(h);
    expect(eventTypes(h)).toEqual(["helpdesk_sync_started", "incident_created"]);
    expect(h.connector.addNote).not.toHaveBeenCalled();
    expect(h.status.value).toBe("incident_created");
  });

  it("writes shadow_skipped once across retries", async () => {
    const h = harness({
      shadowMode: true,
      events: ["helpdesk_sync_started", "shadow_skipped"],
      found: ticket("helpdesk_pending"),
    });
    await run(h);
    expect(eventTypes(h)).toEqual(["helpdesk_sync_started", "shadow_skipped"]);
    expect(h.status.value).toBe("incident_skipped_shadow");
  });
});

describe("runHelpdeskSync: errors", () => {
  const failing = (code: HelpdeskErrorCode) =>
    harness({ failures: { findByExternalRef: [new HelpdeskError(code, "findByExternalRef")] } });

  it.each([
    ["auth", "helpdesk_auth_failed"],
    ["config", "helpdesk_config"],
    ["bad_request", "helpdesk_config"],
    ["not_found", "helpdesk_sync_failed"],
    ["bad_response", "helpdesk_sync_failed"],
    ["duplicate_external_ref", "helpdesk_sync_failed"],
  ] as const)(
    "%s: failed with helpdesk_sync_failed, alert %s, no retry",
    async (code, alertKind) => {
      const h = failing(code);
      await expect(run(h)).resolves.toEqual({ ticketId: TICKET, failed: true, error: code });
      expect(h.events.at(-1)).toEqual({ type: "helpdesk_sync_failed", payload: { error: code } });
      expect(h.status.value).toBe("failed");
      expect(h.alert).toHaveBeenCalledTimes(1);
      expect(h.alert).toHaveBeenCalledWith(alertKind, { ticketId: TICKET });
    },
  );

  it.each(["unavailable", "rate_limited"] as const)(
    "%s: the run throws so the task retries",
    async (code) => {
      const h = failing(code);
      await expect(run(h)).rejects.toMatchObject({ name: "HelpdeskError", code });
      expect(h.status.value).toBe("helpdesk_pending");
      expect(eventTypes(h)).toEqual(["helpdesk_sync_started"]);
      expect(h.alert).not.toHaveBeenCalled();
    },
  );

  it("an error that is not a HelpdeskError is thrown as it is", async () => {
    const h = harness({ failures: { findByExternalRef: [new TypeError("boom")] } });
    await expect(run(h)).rejects.toThrow(TypeError);
    expect(h.status.value).toBe("helpdesk_pending");
  });

  it("a connector that cannot be built (config) fails the ticket as a config error", async () => {
    const h = harness({ connectorFactoryError: new HelpdeskError("config", "create client") });
    await expect(run(h)).resolves.toMatchObject({ failed: true, error: "config" });
    expect(h.alert).toHaveBeenCalledWith("helpdesk_config", { ticketId: TICKET });
  });

  it("a different stored sys_id fails the ticket as a conflict", async () => {
    const h = harness({ incidentConflict: true });
    await expect(run(h)).resolves.toMatchObject({ failed: true, error: "conflict" });
    expect(h.alert).toHaveBeenCalledWith("helpdesk_sync_failed", { ticketId: TICKET });
    expect(h.status.value).toBe("failed");
  });

  it("writes helpdesk_sync_failed once and keeps the failed status on a repeated run", async () => {
    const h = failing("auth");
    await run(h);
    const again = await run(h);
    expect(again).toEqual({ ticketId: TICKET, refused: true });
    expect(eventTypes(h).filter((type) => type === "helpdesk_sync_failed")).toHaveLength(1);
  });
});

describe("runHelpdeskSync: privacy", () => {
  it("no event, log, alert or note holds the raw title, raw description, requester name or email", async () => {
    for (const options of [
      {},
      { callerDefaulted: true },
      { shadowMode: true },
      { failures: { findByExternalRef: [new HelpdeskError("auth", "x")] } },
      { found: ticket("rejected") },
    ] as Options[]) {
      const h = harness(options);
      await run(h);
      const text = outbound(h);
      for (const marker of Object.values(MARK)) {
        // The requester email is allowed in one place: the create call's input.
        const inRepos = text.includes(marker);
        expect(inRepos).toBe(false);
      }
    }
  });

  it("passes the requester email only in the connector's create input", async () => {
    const h = harness();
    await run(h);
    expect(JSON.stringify(h.sent.creates)).toContain(MARK.email);
    expect(JSON.stringify(h.sent.creates)).not.toContain(MARK.title);
    expect(JSON.stringify(h.sent.creates)).not.toContain(MARK.name);
  });
});
