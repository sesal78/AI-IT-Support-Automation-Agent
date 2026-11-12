import type { Notification, Ticket, Triage } from "@ai-it-support/db";
import { AbortTaskRunError } from "@trigger.dev/sdk";
import { describe, expect, it } from "vitest";
import type { SendEmailInput } from "../email/index.js";
import { runNotifyRequester, type NotifyRequesterDeps } from "./notify-requester.js";

const TICKET = "00000000-0000-4000-8000-000000000001";
const NOW = "2026-11-12T10:00:00.000Z";
const FROM = "help@example.test";
const EMAIL = "marker.requester@example.test";
const RAW = { title: "MARKER-RAW-TITLE", description: "MARKER-RAW-DESCRIPTION" };
const INC = "INC0010001";
const HD = "HD0000042";
const SYS_ID = "a".repeat(31) + "1";

function ticket(over: Partial<Ticket> = {}): Ticket {
  return {
    id: TICKET,
    ticket_number: "ITS-000042",
    source: "web",
    raw_title: RAW.title,
    raw_description: RAW.description,
    requester_email: EMAIL,
    requester_name: "MARKER-NAME",
    department: "Finance",
    status: "incident_created",
    servicenow_sys_id: SYS_ID,
    servicenow_number: INC,
    helpdesk: "servicenow",
    idempotency_key: "k",
    is_test: false,
    created_at: NOW,
    ...over,
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
    assignment_group: "Network",
    route: "auto",
    probabilities: {},
    flags: [],
    grounding_score: 0.9,
    kb_article_ids: [],
    suggested_fix: { steps: ["Restart the VPN client", "Sign in again"], caveats: [] },
    model_versions: null,
    triaged_at: NOW,
    ...over,
  };
}

interface Options {
  ticket?: Ticket | null;
  triage?: Triage | null;
  email?: string | null;
  /** The builtin helpdesk ticket number, when there is a row. */
  hdNumber?: string | null;
  allowed?: string[];
  /** Results of the next sends, in order: a provider id or an error to throw. */
  sends?: Array<string | Error>;
  existing?: Notification | null;
}

function harness(options: Options = {}) {
  const found = options.ticket === undefined ? ticket() : options.ticket;
  const rows = new Map<string, Notification>();
  if (options.existing) rows.set(options.existing.kind, options.existing);
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const requests: SendEmailInput[] = [];
  const logs: unknown[] = [];
  const sends = [...(options.sends ?? [])];
  // The provider returns the first result for a repeated Idempotency-Key.
  const byKey = new Map<string, string>();
  let counter = 0;

  const record = (level: string) => (message: string, data?: Record<string, unknown>) => {
    logs.push({ level, message, data });
  };
  const deps: NotifyRequesterDeps = {
    repos: {
      getTicket: async () => found,
      getTriage: async () => (options.triage === undefined ? triage() : options.triage),
      getHelpdeskTicketByTicketId: async () =>
        options.hdNumber === undefined || options.hdNumber === null
          ? null
          : ({
              id: TICKET,
              ticket_id: TICKET,
              seq: 42,
              number: options.hdNumber,
              state: "new",
              priority: "P3",
              category: "network",
              assignee_id: null,
              created_at: NOW,
              updated_at: NOW,
            } as never),
      getRequesterEmail: async () => (options.email === undefined ? EMAIL : options.email),
      getNotification: async (_id, kind) => rows.get(kind) ?? null,
      recordNotification: async (input) => {
        const stored = rows.get(input.kind);
        if (stored) return { created: false, notification: stored };
        const notification: Notification = {
          id: `00000000-0000-4000-8000-0000000000${(++counter).toString().padStart(2, "0")}`,
          ticket_id: input.ticketId,
          channel: input.channel,
          kind: input.kind,
          status: input.status,
          provider_id: input.providerId,
          reason: input.reason,
          at: NOW,
        };
        rows.set(input.kind, notification);
        return { created: true, notification };
      },
      addEvent: async (ticketId, type, payload = {}) => {
        events.push({ type, payload });
        return { id: events.length, ticket_id: ticketId, type, payload, at: NOW };
      },
    },
    resend: {
      send: async (input) => {
        requests.push(input);
        const prior = byKey.get(input.idempotencyKey);
        if (prior !== undefined) return { id: prior };
        const next = sends.shift() ?? `msg_${requests.length}`;
        if (next instanceof Error) throw next;
        byKey.set(input.idempotencyKey, next);
        return { id: next };
      },
    },
    from: FROM,
    allowedRecipients: options.allowed ?? [EMAIL],
    logger: { info: record("info"), warn: record("warn"), error: record("error") },
  };
  return { deps, rows, events, requests, logs };
}

const payload = (kind: "incident_reply" | "needs_info" = "incident_reply") => ({
  ticketId: TICKET,
  kind,
});

describe("runNotifyRequester: recipient allow-list", () => {
  it("records one skipped row and one event, with no request, for a requester not on the list", async () => {
    const h = harness({ allowed: ["someone.else@example.test"] });
    const result = await runNotifyRequester(payload(), h.deps);
    expect(result.outcome).toBe("skipped");
    expect(h.requests).toHaveLength(0);
    expect([...h.rows.values()]).toMatchObject([
      { status: "skipped", reason: "not_allow_listed", provider_id: null },
    ]);
    expect(h.events).toEqual([
      { type: "notification_skipped", payload: { kind: "incident_reply" } },
    ]);
  });

  it("matches the normalised address exactly", async () => {
    const upper = harness({ email: "Marker.Requester@Example.Test" });
    await runNotifyRequester(payload(), upper.deps);
    expect(upper.requests).toHaveLength(1);
    expect(upper.requests[0]?.to).toBe(EMAIL);

    for (const stored of [
      "x+marker.requester@example.test",
      "marker.requester@example.test.evil",
    ]) {
      const h = harness({ email: stored });
      expect((await runNotifyRequester(payload(), h.deps)).outcome).toBe("skipped");
      expect(h.requests).toHaveLength(0);
    }
  });

  it("skips an address with a line break instead of sending or throwing", async () => {
    const h = harness({ email: `${EMAIL}\r\nBcc: x@example.test` });
    expect((await runNotifyRequester(payload(), h.deps)).outcome).toBe("skipped");
    expect(h.requests).toHaveLength(0);
  });
});

describe("runNotifyRequester: refusals", () => {
  it.each([
    ["a rejected ticket", { ticket: ticket({ status: "rejected" }) }],
    ["a ticket still helpdesk_pending", { ticket: ticket({ status: "helpdesk_pending" }) }],
    [
      "an incident_created ticket with no stored number",
      {
        ticket: ticket({ servicenow_number: null, servicenow_sys_id: null }),
      },
    ],
    [
      "a builtin ticket with no helpdesk ticket row",
      {
        ticket: ticket({ helpdesk: "builtin", servicenow_number: null, servicenow_sys_id: null }),
        hdNumber: null,
      },
    ],
    ["an unknown ticket", { ticket: null }],
    ["a ticket without a requester address", { email: null }],
  ])("aborts with no request and no row for %s", async (_name, options) => {
    const h = harness(options as Options);
    await expect(runNotifyRequester(payload(), h.deps)).rejects.toBeInstanceOf(AbortTaskRunError);
    expect(h.requests).toHaveLength(0);
    expect(h.rows.size).toBe(0);
    expect(h.events).toEqual([]);
  });

  it("an existing row ends the run before any other check", async () => {
    const existing: Notification = {
      id: "00000000-0000-4000-8000-0000000000ff",
      ticket_id: TICKET,
      channel: "email",
      kind: "incident_reply",
      status: "sent",
      provider_id: "msg_old",
      reason: null,
      at: NOW,
    };
    const h = harness({ existing, ticket: ticket({ status: "rejected" }) });
    expect((await runNotifyRequester(payload(), h.deps)).outcome).toBe("already_recorded");
    expect(h.requests).toHaveLength(0);
  });
});
