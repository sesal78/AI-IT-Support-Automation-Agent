import { DbError, type Notification, type Ticket, type Triage } from "@ai-it-support/db";
import { NOTIFY_REQUESTER_TASK_ID, notifyRequesterPayloadSchema } from "@ai-it-support/shared";
import { AbortTaskRunError } from "@trigger.dev/sdk";
import { describe, expect, it } from "vitest";
import { EmailProviderError, type SendEmailInput } from "../email/index.js";
import {
  createNotifyRequesterDeps,
  notifyRequesterOptions,
  onNotifyRequesterFailure,
  runNotifyRequester,
  type NotifyRequesterDeps,
  type NotifyRequesterFailureDeps,
} from "./notify-requester.js";

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
  /** recordNotification throws these, in order (undefined = succeed). */
  recordFailures?: unknown[];
  existing?: Notification | null;
}

function harness(options: Options = {}) {
  const found = options.ticket === undefined ? ticket() : options.ticket;
  const rows = new Map<string, Notification>();
  if (options.existing) rows.set(options.existing.kind, options.existing);
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const requests: SendEmailInput[] = [];
  const statusWrites: string[] = [];
  const alerts: Array<{ kind: string; ticketId?: string | undefined }> = [];
  const logs: unknown[] = [];
  const sends = [...(options.sends ?? [])];
  const recordFailures = [...(options.recordFailures ?? [])];
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
        const failure = recordFailures.shift();
        if (failure !== undefined) throw failure;
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
  const failureDeps: NotifyRequesterFailureDeps = {
    repos: {
      getTicket: deps.repos.getTicket,
      getTriage: deps.repos.getTriage,
      recordNotification: deps.repos.recordNotification,
      addEvent: deps.repos.addEvent,
    },
    alert: async (kind, alertOptions) => {
      alerts.push({ kind, ticketId: alertOptions?.ticketId });
    },
    logger: deps.logger,
  };
  return { deps, failureDeps, rows, events, requests, statusWrites, alerts, logs };
}

const payload = (kind: "incident_reply" | "needs_info" = "incident_reply") => ({
  ticketId: TICKET,
  kind,
});

describe("runNotifyRequester: incident_reply", () => {
  it("sends one email with the ITS number and the INC number, records one sent row and one event", async () => {
    const h = harness();
    const result = await runNotifyRequester(payload(), h.deps);
    expect(result).toEqual({ ticketId: TICKET, kind: "incident_reply", outcome: "sent" });
    expect(h.requests).toHaveLength(1);
    const request = h.requests[0]!;
    expect(request.to).toBe(EMAIL);
    expect(request.from).toBe(FROM);
    expect(request.idempotencyKey).toBe(`notify:${TICKET}:incident_reply`);
    expect(request.subject).toBe("Your IT ticket ITS-000042");
    expect(request.text).toContain("ITS-000042");
    expect(request.text).toContain(INC);
    expect(request.text).toContain("1. Restart the VPN client");
    expect(request.html).toContain(INC);
    expect([...h.rows.values()]).toMatchObject([
      { kind: "incident_reply", status: "sent", provider_id: "msg_1", reason: null },
    ]);
    expect(h.events).toEqual([{ type: "notification_sent", payload: { kind: "incident_reply" } }]);
  });

  it("running again sends nothing and writes nothing more", async () => {
    const h = harness();
    await runNotifyRequester(payload(), h.deps);
    const again = await runNotifyRequester(payload(), h.deps);
    expect(again).toEqual({
      ticketId: TICKET,
      kind: "incident_reply",
      outcome: "already_recorded",
    });
    expect(h.requests).toHaveLength(1);
    expect(h.rows.size).toBe(1);
    expect(h.events).toHaveLength(1);
  });

  it("marks a test ticket's subject with [E2E]", async () => {
    const h = harness({ ticket: ticket({ is_test: true }) });
    await runNotifyRequester(payload(), h.deps);
    expect(h.requests[0]?.subject).toBe("[E2E] Your IT ticket ITS-000042");
  });

  it("uses the stored HD number of a builtin ticket and never the ServiceNow columns", async () => {
    const h = harness({
      ticket: ticket({ helpdesk: "builtin", servicenow_number: null, servicenow_sys_id: null }),
      hdNumber: HD,
    });
    await runNotifyRequester(payload(), h.deps);
    expect(h.requests[0]?.text).toContain(HD);
    expect(h.requests[0]?.text).not.toContain(INC);
    expect(h.requests[0]?.text).not.toContain(SYS_ID);
  });

  it("a builtin ticket still takes the HD number when stray ServiceNow columns are set", async () => {
    const h = harness({ ticket: ticket({ helpdesk: "builtin" }), hdNumber: HD });
    await runNotifyRequester(payload(), h.deps);
    expect(h.requests[0]?.text).toContain(HD);
    expect(h.requests[0]?.text).not.toContain(INC);
  });

  it("a ticket made before the helpdesk flag existed uses its ServiceNow number", async () => {
    const h = harness({ ticket: ticket({ helpdesk: null }) });
    await runNotifyRequester(payload(), h.deps);
    expect(h.requests[0]?.text).toContain(INC);
  });

  it("aborts with no request when there is no fix step to send (the template needs one)", async () => {
    for (const suggested_fix of [null, { steps: [] }, { steps: ["  "] }]) {
      const h = harness({ triage: triage({ suggested_fix }) });
      await expect(runNotifyRequester(payload(), h.deps)).rejects.toBeInstanceOf(AbortTaskRunError);
      expect(h.requests).toHaveLength(0);
      expect(h.rows.size).toBe(0);
    }
  });

  it("throws, sending nothing, when the saved fix steps have an unexpected shape", async () => {
    const h = harness({ triage: triage({ suggested_fix: { steps: "not a list" } }) });
    await expect(runNotifyRequester(payload(), h.deps)).rejects.toThrow(/unexpected shape/);
    expect(h.requests).toHaveLength(0);
  });
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

describe("runNotifyRequester: needs_info", () => {
  const needy = () => ({
    ticket: ticket({ status: "review_pending", servicenow_number: null, servicenow_sys_id: null }),
    triage: triage({ route: "review", flags: ["needs_info"], suggested_fix: null }),
  });

  it("sends the details variant without a helpdesk number, under its own key", async () => {
    const h = harness(needy());
    const result = await runNotifyRequester(payload("needs_info"), h.deps);
    expect(result).toEqual({ ticketId: TICKET, kind: "needs_info", outcome: "sent" });
    const request = h.requests[0]!;
    expect(request.subject).toBe("More detail needed for your IT ticket ITS-000042");
    expect(request.idempotencyKey).toBe(`notify:${TICKET}:needs_info`);
    expect(request.text).not.toMatch(/INC|HD0/);
    expect(h.events).toEqual([{ type: "notification_sent", payload: { kind: "needs_info" } }]);
  });

  it("aborts with no request when the triage flags do not hold needs_info", async () => {
    const h = harness({ ...needy(), triage: triage({ route: "review", flags: ["p1"] }) });
    await expect(runNotifyRequester(payload("needs_info"), h.deps)).rejects.toBeInstanceOf(
      AbortTaskRunError,
    );
    expect(h.requests).toHaveLength(0);
  });

  it("an incident_reply row does not stop the needs_info email", async () => {
    const existing: Notification = {
      id: "00000000-0000-4000-8000-0000000000fe",
      ticket_id: TICKET,
      channel: "email",
      kind: "incident_reply",
      status: "sent",
      provider_id: "msg_old",
      reason: null,
      at: NOW,
    };
    const h = harness({ ...needy(), existing });
    expect((await runNotifyRequester(payload("needs_info"), h.deps)).outcome).toBe("sent");
    expect(h.requests).toHaveLength(1);
  });
});

describe("runNotifyRequester: failures and retries", () => {
  it("rethrows a transient provider error, writing no row and no event", async () => {
    const h = harness({ sends: [new EmailProviderError("http_500")] });
    await expect(runNotifyRequester(payload(), h.deps)).rejects.toBeInstanceOf(EmailProviderError);
    expect(h.rows.size).toBe(0);
    expect(h.events).toEqual([]);
  });

  it.each(["http_422", "http_401", "bad_response", "redirect"])(
    "aborts the task on the permanent provider error %s, so no attempt repeats it",
    async (code) => {
      const h = harness({ sends: [new EmailProviderError(code)] });
      const error = await runNotifyRequester(payload(), h.deps).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AbortTaskRunError);
      expect(String((error as Error).message)).toContain(code);
      expect(h.requests).toHaveLength(1);
      expect(h.rows.size).toBe(0);
    },
  );

  it.each(["http_429", "http_503", "network", "timeout"])(
    "keeps the transient provider error %s retryable",
    async (code) => {
      const h = harness({ sends: [new EmailProviderError(code)] });
      const error = await runNotifyRequester(payload(), h.deps).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(EmailProviderError);
    },
  );

  it("a retried attempt after a provider error sends once more with the same key and records one row", async () => {
    const h = harness({ sends: [new EmailProviderError("http_500"), "msg_ok"] });
    await expect(runNotifyRequester(payload(), h.deps)).rejects.toThrow();
    await runNotifyRequester(payload(), h.deps);
    expect(h.requests.map((r) => r.idempotencyKey)).toEqual([
      `notify:${TICKET}:incident_reply`,
      `notify:${TICKET}:incident_reply`,
    ]);
    expect([...h.rows.values()]).toHaveLength(1);
    expect([...h.rows.values()][0]?.provider_id).toBe("msg_ok");
    expect(h.events).toHaveLength(1);
  });

  it("a crash after the send but before the row: the retry sends with the same key and records the provider's first id", async () => {
    const h = harness({
      sends: ["msg_first", "msg_second"],
      recordFailures: [new DbError("recordNotification", "supabase error 08006")],
    });
    await expect(runNotifyRequester(payload(), h.deps)).rejects.toBeInstanceOf(DbError);
    expect(h.rows.size).toBe(0);
    await runNotifyRequester(payload(), h.deps);
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1]?.idempotencyKey).toBe(h.requests[0]?.idempotencyKey);
    // The provider answers a repeated key with its first result.
    expect([...h.rows.values()][0]?.provider_id).toBe("msg_first");
    expect(h.events).toHaveLength(1);
  });

  it("writes no event when another run created the row first", async () => {
    const h = harness();
    const original = h.deps.repos.recordNotification;
    h.deps.repos.recordNotification = async (input) => {
      const result = await original(input);
      return { created: false, notification: result.notification };
    };
    const result = await runNotifyRequester(payload(), h.deps);
    expect(result.outcome).toBe("already_recorded");
    expect(h.events).toEqual([]);
  });
});

describe("runNotifyRequester: privacy", () => {
  it("puts the requester address only in the Resend to field, and no ticket text anywhere else", async () => {
    const sentRun = harness();
    await runNotifyRequester(payload(), sentRun.deps);
    const skippedRun = harness({ allowed: ["other@example.test"] });
    await runNotifyRequester(payload(), skippedRun.deps);
    const failedRun = harness({ sends: [new EmailProviderError("http_500")] });
    await runNotifyRequester(payload(), failedRun.deps).catch(() => undefined);

    for (const h of [sentRun, skippedRun, failedRun]) {
      const observable = JSON.stringify({
        rows: [...h.rows.values()],
        events: h.events,
        logs: h.logs,
      });
      for (const marker of [EMAIL, RAW.title, RAW.description, "MARKER-NAME"]) {
        expect(observable).not.toContain(marker);
      }
    }
    const request = sentRun.requests[0]!;
    expect(request.to).toBe(EMAIL);
    for (const field of [request.subject, request.text, request.html, request.from]) {
      expect(field).not.toContain(EMAIL);
      expect(field).not.toContain(RAW.title);
      expect(field).not.toContain("MARKER-NAME");
    }
  });
});

describe("onNotifyRequesterFailure", () => {
  const failed = (
    h: ReturnType<typeof harness>,
    error: unknown = new EmailProviderError("http_500"),
  ) => onNotifyRequesterFailure({ payload: payload(), error }, h.failureDeps);

  it("records one failed row, one notification_failed event and one alert, and changes no status", async () => {
    const h = harness();
    await failed(h);
    expect([...h.rows.values()]).toMatchObject([
      { kind: "incident_reply", status: "failed", reason: "provider_error", provider_id: null },
    ]);
    expect(h.events).toEqual([
      { type: "notification_failed", payload: { kind: "incident_reply", error: "http_500" } },
    ]);
    expect(h.alerts).toEqual([{ kind: "notify_failed", ticketId: TICKET }]);
    expect(h.statusWrites).toEqual([]);
    expect(Object.keys(h.failureDeps.repos)).not.toContain("setTicketStatus");
  });

  it("names a non-provider error by its class only", async () => {
    const h = harness();
    await failed(h, new DbError("recordNotification", `boom ${EMAIL}`));
    expect(h.events[0]?.payload).toEqual({ kind: "incident_reply", error: "DbError" });
    expect(JSON.stringify(h.events)).not.toContain(EMAIL);
  });

  it("leaves a sent row, its proof and the alerts alone", async () => {
    const h = harness();
    await runNotifyRequester(payload(), h.deps);
    await failed(h);
    expect([...h.rows.values()]).toMatchObject([{ status: "sent", provider_id: "msg_1" }]);
    expect(h.events).toEqual([{ type: "notification_sent", payload: { kind: "incident_reply" } }]);
    expect(h.alerts).toEqual([]);
  });

  it("running the hook twice leaves one row, one event and one alert", async () => {
    const h = harness();
    await failed(h);
    await failed(h);
    expect(h.rows.size).toBe(1);
    expect(h.events).toHaveLength(1);
    expect(h.alerts).toHaveLength(1);
  });

  it.each([
    ["a rejected ticket", { ticket: ticket({ status: "rejected" }) }],
    ["an unknown ticket", { ticket: null }],
  ])("records nothing for %s: a refused trigger must not fill the slot", async (_name, options) => {
    const h = harness(options as Options);
    await failed(h, new AbortTaskRunError("refused"));
    expect(h.rows.size).toBe(0);
    expect(h.alerts).toEqual([]);
  });

  it("records nothing for a needs_info trigger on a ticket without the flag", async () => {
    const h = harness({ triage: triage({ flags: [] }) });
    await onNotifyRequesterFailure(
      { payload: payload("needs_info"), error: new AbortTaskRunError("x") },
      h.failureDeps,
    );
    expect(h.rows.size).toBe(0);
  });

  it("never throws: an invalid payload, a failing repository and a failing alert", async () => {
    const h = harness();
    await expect(
      onNotifyRequesterFailure(
        { payload: { ticketId: "nope" }, error: new Error("x") },
        h.failureDeps,
      ),
    ).resolves.toBeUndefined();
    h.failureDeps.repos.getTicket = async () => {
      throw new DbError("getTicket", `down ${EMAIL}`);
    };
    await expect(failed(h)).resolves.toBeUndefined();
    const g = harness();
    g.failureDeps.alert = async () => {
      throw new Error("slack down");
    };
    await expect(failed(g)).resolves.toBeUndefined();
    expect(JSON.stringify(h.logs)).not.toContain(EMAIL);
  });
});

describe("notifyRequesterOptions and deps", () => {
  it("is wired as the notify-requester task with three attempts and the failure hook", () => {
    expect(notifyRequesterOptions.id).toBe(NOTIFY_REQUESTER_TASK_ID);
    expect(notifyRequesterOptions.schema).toBe(notifyRequesterPayloadSchema);
    expect(notifyRequesterOptions.retry).toMatchObject({ maxAttempts: 3 });
    expect(notifyRequesterOptions.onFailure).toBe(onNotifyRequesterFailure);
  });

  const env = {
    SUPABASE_URL: "http://127.0.0.1:54321",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
    SUPABASE_DB_SCHEMA: "itsupport",
    RESEND_API_KEY: "re_" + "a".repeat(24),
    REPLY_FROM: FROM,
    REPLY_ALLOWED_RECIPIENTS: "one@example.test,two@example.test",
  };

  it("builds the deps from valid env, with the allow-list as an array", () => {
    const deps = createNotifyRequesterDeps(env);
    expect(deps.from).toBe(FROM);
    expect(deps.allowedRecipients).toEqual(["one@example.test", "two@example.test"]);
  });

  it.each(["RESEND_API_KEY", "REPLY_FROM", "REPLY_ALLOWED_RECIPIENTS"])(
    "throws naming %s when it is missing",
    (name) => {
      const broken: Record<string, string | undefined> = { ...env };
      delete broken[name];
      expect(() => createNotifyRequesterDeps(broken)).toThrow(new RegExp(name));
    },
  );

  it("throws naming the variable for an upper-case recipient and for a bad key, never echoing a value", () => {
    expect(() =>
      createNotifyRequesterDeps({ ...env, REPLY_ALLOWED_RECIPIENTS: "One@example.test" }),
    ).toThrow(/REPLY_ALLOWED_RECIPIENTS/);
    let message = "";
    try {
      createNotifyRequesterDeps({ ...env, RESEND_API_KEY: "sk_marker_value_not_a_key" });
    } catch (error) {
      message = String((error as Error).message);
    }
    expect(message).toMatch(/RESEND_API_KEY/);
    expect(message).not.toContain("sk_marker_value_not_a_key");
  });
});
