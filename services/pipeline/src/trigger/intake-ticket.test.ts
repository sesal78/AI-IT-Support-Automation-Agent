import { randomUUID } from "node:crypto";
import type {
  MeterReservationInput,
  SensitiveChecker,
  TopicScores,
  TraceSpan,
} from "@ai-it-support/ai";
import {
  SENSITIVE_TOPICS,
  createAiRuntime,
  createMeter,
  createTypeSafeChecker,
} from "@ai-it-support/ai";
import type { NewRedaction, NewTriage, Ticket } from "@ai-it-support/db";
import { buildCanaries, findCanaries } from "@ai-it-support/shared";
import { HttpResponse } from "msw";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createEgressRecorder } from "../../../../packages/shared/test-support/egress-recorder.js";
import {
  createIntakeDeps,
  intakeTicket,
  intakeTicketPayload,
  runIntakeTicket,
  type IntakeDeps,
} from "./intake-ticket.js";

const ticketId = randomUUID();
const now = "2026-09-30T10:00:00.000000+00:00";

function ticket(title: string, description: string): Ticket {
  return {
    id: ticketId,
    source: "web",
    raw_title: title,
    raw_description: description,
    requester_email: "demo.user@example.test",
    requester_name: "Demo User",
    department: "Finance",
    status: "new",
    servicenow_sys_id: null,
    servicenow_number: null,
    idempotency_key: "key-1",
    is_test: false,
    created_at: now,
  };
}

function scores(value: number, overrides: Partial<TopicScores> = {}): TopicScores {
  const all = Object.fromEntries(SENSITIVE_TOPICS.map((t) => [t, value])) as TopicScores;
  return { ...all, ...overrides };
}

interface Harness {
  deps: IntakeDeps;
  calls: string[];
  redactions: NewRedaction[];
  triages: NewTriage[];
  events: Array<{ type: string; payload: Record<string, unknown> }>;
  check: ReturnType<typeof vi.fn>;
  alerts: Array<{ kind: string; options: unknown }>;
  logs: unknown[][];
}

function harness(found: Ticket | null, checkerImpl: SensitiveChecker["check"]): Harness {
  const calls: string[] = [];
  const redactions: NewRedaction[] = [];
  const triages: NewTriage[] = [];
  const events: Harness["events"] = [];
  const logs: unknown[][] = [];
  const alerts: Harness["alerts"] = [];
  const check = vi.fn(checkerImpl);
  const log = (...args: unknown[]) => {
    logs.push(args);
  };
  const deps: IntakeDeps = {
    repos: {
      getTicket: vi.fn(async () => {
        calls.push("getTicket");
        return found;
      }),
      saveRedaction: vi.fn(async (input: NewRedaction) => {
        calls.push("saveRedaction");
        redactions.push(input);
        return { ...input, created_at: now };
      }),
      saveTriage: vi.fn(async (input: NewTriage) => {
        calls.push("saveTriage");
        triages.push(input);
        return { ...input, created_at: now };
      }),
      addEvent: vi.fn(async (id: string, type: string, payload: Record<string, unknown> = {}) => {
        calls.push(`event:${type}`);
        events.push({ type, payload });
        return { id: events.length, ticket_id: id, type, payload, at: now };
      }),
    },
    checker: { check },
    threshold: 0.5,
    alert: vi.fn(async (kind: string, options?: unknown) => {
      calls.push(`alert:${kind}`);
      alerts.push({ kind, options });
    }),
    logger: { info: log, warn: log, error: log },
  };
  return { deps, calls, redactions, triages, events, check, alerts, logs };
}

const lowScores = async () => ({ scores: scores(0.1), checker: "typesafe:jev-test" });

describe("intake-ticket task", () => {
  it("is registered with id intake-ticket", () => {
    expect(intakeTicket.id).toBe("intake-ticket");
  });

  it("redacts, saves the redaction, checks and saves a non-sensitive triage", async () => {
    const h = harness(ticket("Laptop", "call 0412 345 678 about my laptop"), lowScores);

    const result = await runIntakeTicket({ ticketId }, h.deps);

    expect(h.redactions).toEqual([
      {
        ticket_id: ticketId,
        redacted_title: "Laptop",
        redacted_description: "call [REDACTED_PHONE] about my laptop",
        redaction_log: [{ type: "PHONE", count: 1 }],
      },
    ]);
    expect(h.triages).toEqual([
      {
        ticket_id: ticketId,
        sensitive: false,
        sensitive_flags: [],
        checker: "keywords+typesafe:jev-test",
      },
    ]);
    expect(h.calls).toEqual([
      "getTicket",
      "saveRedaction",
      "event:redacted",
      "saveTriage",
      "event:sensitive_checked",
    ]);
    expect(h.events.map((e) => e.type)).toEqual(["redacted", "sensitive_checked"]);
    expect(result).toEqual({ ticketId, sensitive: false, flags: [] });
  });

  it("flags termination from the keyword layer even when TypeSafe returns 0.0", async () => {
    const h = harness(
      ticket("Files", "I am being terminated tomorrow, need my files"),
      async () => ({ scores: scores(0), checker: "typesafe:jev-test" }),
    );

    await runIntakeTicket({ ticketId }, h.deps);

    expect(h.triages[0]).toMatchObject({ sensitive: true, sensitive_flags: ["termination"] });
    expect(h.events[1]).toEqual({
      type: "sensitive_checked",
      payload: { sensitive: true, flags: ["termination"], checker: "keywords+typesafe:jev-test" },
    });
  });

  it("flags security_incident from a Noul of 0.8 with no keyword hit", async () => {
    const h = harness(ticket("Odd email", "an email asked me to confirm my login"), async () => ({
      scores: scores(0.1, { security_incident: 0.8 }),
      checker: "typesafe:jev-test",
    }));

    await runIntakeTicket({ ticketId }, h.deps);

    expect(h.triages[0]).toMatchObject({ sensitive: true, sensitive_flags: ["security_incident"] });
  });

  it("uses the configured threshold", async () => {
    const h = harness(ticket("Odd email", "an email asked me to confirm my login"), async () => ({
      scores: scores(0.1, { security_incident: 0.8 }),
      checker: "typesafe:jev-test",
    }));
    h.deps.threshold = 0.9;

    await runIntakeTicket({ ticketId }, h.deps);

    expect(h.triages[0]).toMatchObject({ sensitive: false, sensitive_flags: [] });
  });

  it("sends only redacted text to the checker", async () => {
    const rawEmail = "jo.bloggs@example.test";
    const rawPhone = "+61 412 345 678";
    const rawSsn = "123-45-6789";
    const h = harness(
      ticket(`Locked out ${rawEmail}`, `mail ${rawEmail}, call ${rawPhone}, ssn ${rawSsn}`),
      lowScores,
    );

    await runIntakeTicket({ ticketId }, h.deps);

    expect(h.check).toHaveBeenCalledTimes(1);
    const sent = JSON.stringify(h.check.mock.calls);
    for (const raw of [rawEmail, rawPhone, rawSsn, "412 345 678"]) {
      expect(sent).not.toContain(raw);
    }
    expect(h.check).toHaveBeenCalledWith({
      title: "Locked out [REDACTED_EMAIL]",
      description: "mail [REDACTED_EMAIL], call [REDACTED_PHONE], ssn [REDACTED_SSN]",
      ticketId,
    });
    // Title and description counts are summed per type.
    expect(h.redactions[0]!.redaction_log).toEqual(
      expect.arrayContaining([
        { type: "EMAIL", count: 2 },
        { type: "PHONE", count: 1 },
        { type: "SSN", count: 1 },
      ]),
    );
    expect(h.redactions[0]!.redaction_log).toHaveLength(3);
  });

  it("never logs ticket text, raw or redacted", async () => {
    const description = "I clicked a phishing link, my email is jo@x.com";
    const h = harness(ticket("Phishing help", description), lowScores);

    await runIntakeTicket({ ticketId }, h.deps);

    expect(h.logs.length).toBeGreaterThan(0);
    const logged = JSON.stringify(h.logs);
    for (const text of ["Phishing help", "clicked", "jo@x.com", "[REDACTED_EMAIL]"]) {
      expect(logged).not.toContain(text);
    }
    expect(logged).toContain(ticketId);
  });

  it("does not put ticket text in event payloads", async () => {
    const h = harness(ticket("Printer", "call 0412 345 678 about the printer"), lowScores);

    await runIntakeTicket({ ticketId }, h.deps, 2);

    expect(h.events[0]).toEqual({
      type: "redacted",
      payload: { redactions: [{ type: "PHONE", count: 1 }], attempt: 2 },
    });
    expect(JSON.stringify(h.events)).not.toContain("printer");
  });

  it("throws when the checker throws, after the redaction but before any triage row", async () => {
    const h = harness(ticket("Laptop", "call 0412 345 678"), async () => {
      throw new Error("typesafe unavailable");
    });

    await expect(runIntakeTicket({ ticketId }, h.deps)).rejects.toThrow("typesafe unavailable");

    expect(h.triages).toEqual([]);
    expect(h.calls).toEqual(["getTicket", "saveRedaction", "event:redacted"]);
  });

  it("fails with an error naming an unknown ticket id and writes nothing", async () => {
    const h = harness(null, lowScores);

    await expect(runIntakeTicket({ ticketId }, h.deps)).rejects.toThrow(ticketId);

    expect(h.calls).toEqual(["getTicket"]);
    expect(h.check).not.toHaveBeenCalled();
  });
});

// The real checker, meter and runtime. TypeSafe HTTP goes through the msw
// egress recorder; the repositories and the trace sink are faked.
describe("intake-ticket metered sensitive check", () => {
  const egress = createEgressRecorder();
  const TYPESAFE = "https://api.typesafe.ai";
  const okBody = {
    model: "jev-1.13.0",
    answers: Object.fromEntries(SENSITIVE_TOPICS.map((t) => [t, { type: "noul", noul: 0.1 }])),
    usage: { input_tokens: 30, output_tokens: 5 },
  };
  beforeAll(() => egress.start());
  afterAll(() => egress.stop());
  beforeEach(() => {
    egress.reset();
    egress.mock(TYPESAFE, () => HttpResponse.json(okBody));
  });

  function meteredHarness(found: Ticket, allowed: boolean) {
    const h = harness(found, async () => {
      throw new Error("replaced below");
    });
    const reservations: MeterReservationInput[] = [];
    const spans: TraceSpan[] = [];
    const meter = createMeter({
      repos: {
        reserveAiCall: vi.fn(async (input: MeterReservationInput) => {
          reservations.push(input);
          return allowed
            ? { allowed: true, usedCalls: input.calls, callId: "call-1" }
            : { allowed: false, usedCalls: 20000, callId: null };
        }),
        completeAiCall: vi.fn(async () => undefined),
      },
      caps: { llm: 2000, typesafe: 20000 },
      environment: "e2e",
      alert: h.deps.alert,
    });
    const runtime = createAiRuntime({
      meter,
      sink: { record: async (span) => void spans.push(span) },
      addEvent: h.deps.repos.addEvent,
      environment: "e2e",
    });
    const call = vi.spyOn(runtime, "call");
    h.deps.checker = createTypeSafeChecker({ apiKey: "k".repeat(8), runtime });
    return { ...h, reservations, spans, call };
  }

  it("makes exactly one runtime.call: typesafe, sensitive_check, 5 calls, the ticket ID", async () => {
    const h = meteredHarness(ticket("Laptop", "my laptop is slow"), true);

    await runIntakeTicket({ ticketId }, h.deps);

    expect(h.call).toHaveBeenCalledTimes(1);
    expect(h.call.mock.calls[0]![0]).toMatchObject({
      provider: "typesafe",
      kind: "sensitive_check",
      calls: 5,
      ticketId,
    });
    expect(h.reservations).toEqual([
      expect.objectContaining({
        provider: "typesafe",
        kind: "sensitive_check",
        calls: 5,
        ticketId,
      }),
    ]);
    expect(egress.requests()).toHaveLength(1);
    expect(h.spans).toHaveLength(1);
    expect(h.triages[0]).toMatchObject({
      sensitive: false,
      checker: "keywords+typesafe:jev-1.13.0",
    });
    expect(h.alerts).toEqual([]);
    egress.assertClean();
  });

  it("puts only the redacted title and description in the span input, request and logs", async () => {
    // Every plan canary but IPv6, which redact() does not cover until P3-T3b.
    const raw = buildCanaries(egress.runId)
      .filter((canary) => canary.type !== "ipv6")
      .map((canary) => `${canary.type}: ${canary.value}`)
      .join("\n");
    const h = meteredHarness(ticket(`Locked out ${raw}`, raw), true);

    await runIntakeTicket({ ticketId }, h.deps);

    const span = h.spans[0]!;
    const { state } = span.input as { state: { ticket: Record<string, string> } };
    expect(Object.keys(state.ticket)).toEqual(["title", "description"]);
    expect(state.ticket.title).toBe(h.redactions[0]!.redacted_title);
    expect(state.ticket.description).toBe(h.redactions[0]!.redacted_description);
    expect(span).toMatchObject({ ticketId, kind: "sensitive_check", tokensIn: 30, tokensOut: 5 });
    for (const sink of [span, h.logs, h.events]) {
      expect(findCanaries(JSON.stringify(sink), egress.runId)).toEqual([]);
    }
    for (const value of ["Demo User", "demo.user@example.test", "Finance"]) {
      expect(JSON.stringify(span)).not.toContain(value);
    }
    egress.assertClean();
  });

  it("refused budget with a keyword: sensitive, termination, keywords+cap_reached, no request", async () => {
    const h = meteredHarness(ticket("Files", "I am being terminated tomorrow"), false);

    const result = await runIntakeTicket({ ticketId }, h.deps);

    expect(egress.requests()).toEqual([]);
    expect(h.spans).toEqual([]);
    expect(h.triages).toEqual([
      {
        ticket_id: ticketId,
        sensitive: true,
        sensitive_flags: ["termination"],
        checker: "keywords+cap_reached",
      },
    ]);
    expect(result).toEqual({ ticketId, sensitive: true, flags: ["termination"] });
    expect(h.alerts).toEqual([{ kind: "typesafe_cap_reached", options: { ticketId } }]);
  });

  it("refused budget, no keyword: sensitive, no flags, one typesafe_cap_reached event", async () => {
    const h = meteredHarness(ticket("Laptop", "my laptop is slow"), false);

    await runIntakeTicket({ ticketId }, h.deps);

    expect(egress.requests()).toEqual([]);
    expect(h.triages).toEqual([
      {
        ticket_id: ticketId,
        sensitive: true,
        sensitive_flags: [],
        checker: "keywords+cap_reached",
      },
    ]);
    expect(h.events.filter((e) => e.type === "typesafe_cap_reached")).toEqual([
      { type: "typesafe_cap_reached", payload: { kind: "sensitive_check" } },
    ]);
    expect(h.calls).toEqual([
      "getTicket",
      "saveRedaction",
      "event:redacted",
      "saveTriage",
      "event:sensitive_checked",
      "event:typesafe_cap_reached",
      "alert:typesafe_cap_reached",
    ]);
  });

  it("records the cap event and alert once when a failed attempt is retried", async () => {
    const h = meteredHarness(ticket("Laptop", "my laptop is slow"), false);
    const addEvent = h.deps.repos.addEvent;
    let failed = false;
    h.deps.repos.addEvent = vi.fn(async (id: string, type: string, payload = {}) => {
      if (type === "sensitive_checked" && !failed) {
        failed = true;
        throw new Error("db down");
      }
      return addEvent(id, type, payload);
    });

    await expect(runIntakeTicket({ ticketId }, h.deps, 1)).rejects.toThrow("db down");
    await runIntakeTicket({ ticketId }, h.deps, 2);

    expect(h.events.filter((e) => e.type === "typesafe_cap_reached")).toHaveLength(1);
    expect(h.alerts).toHaveLength(1);
    expect(h.triages.every((t) => t.sensitive)).toBe(true);
  });

  it("a failing alert does not fail the run or change the sensitive triage", async () => {
    const h = meteredHarness(ticket("Laptop", "my laptop is slow"), false);
    h.deps.alert = vi.fn(async () => {
      throw new Error("alert down");
    });

    await expect(runIntakeTicket({ ticketId }, h.deps)).resolves.toMatchObject({ sensitive: true });
    expect(h.triages[0]).toMatchObject({ sensitive: true, checker: "keywords+cap_reached" });
    const logged = JSON.stringify(h.logs);
    expect(logged).toContain("alert failed");
    expect(logged).not.toContain("alert down");
  });

  it("a TypeSafe API error still throws and writes no triage row", async () => {
    egress.mock(TYPESAFE, () => HttpResponse.json({ detail: "bad request" }, { status: 400 }));
    const h = meteredHarness(ticket("Laptop", "my laptop is slow"), true);

    await expect(runIntakeTicket({ ticketId }, h.deps)).rejects.toThrow();

    expect(egress.requests()).toHaveLength(1);
    expect(h.triages).toEqual([]);
    expect(h.events.map((e) => e.type)).toEqual(["redacted"]);
    expect(h.alerts).toEqual([]);
    // The failed call is still traced, with the error class name only.
    expect(h.spans).toHaveLength(1);
    expect(h.spans[0]!.error).toEqual(expect.any(String));
  });

  it("a meter reservation failure throws and writes no triage row", async () => {
    const h = meteredHarness(ticket("Laptop", "my laptop is slow"), true);
    const runtime = createAiRuntime({
      meter: { run: async () => Promise.reject(new Error("reserve failed")) },
      sink: { record: async () => undefined },
      addEvent: h.deps.repos.addEvent,
      environment: "e2e",
    });
    h.deps.checker = createTypeSafeChecker({ apiKey: "k".repeat(8), runtime });

    await expect(runIntakeTicket({ ticketId }, h.deps)).rejects.toThrow("reserve failed");

    expect(egress.requests()).toEqual([]);
    expect(h.triages).toEqual([]);
  });
});

describe("intakeTicketPayload", () => {
  it("rejects {} with an error naming ticketId", () => {
    expect(() => intakeTicketPayload.parse({})).toThrow(/ticketId/);
  });

  it("rejects a ticketId that is not a uuid", () => {
    expect(intakeTicketPayload.safeParse({ ticketId: "123" }).success).toBe(false);
  });

  it("accepts a uuid ticketId", () => {
    expect(intakeTicketPayload.parse({ ticketId })).toEqual({ ticketId });
  });
});

describe("createIntakeDeps", () => {
  const env = {
    SUPABASE_URL: "http://127.0.0.1:54321",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
    SUPABASE_DB_SCHEMA: "itsupport",
    TYPESAFE_API_KEY: "test-typesafe-key",
    LANGFUSE_PUBLIC_KEY: "p".repeat(8),
    LANGFUSE_SECRET_KEY: "s".repeat(8),
    LANGFUSE_BASE_URL: "https://langfuse.example.test",
  };

  it("builds deps with the default threshold of 0.5", () => {
    const deps = createIntakeDeps(env);
    expect(deps.threshold).toBe(0.5);
    expect(typeof deps.repos.getTicket).toBe("function");
    expect(typeof deps.checker.check).toBe("function");
  });

  it("reads SENSITIVE_THRESHOLD", () => {
    expect(createIntakeDeps({ ...env, SENSITIVE_THRESHOLD: "0.7" }).threshold).toBe(0.7);
  });

  it("fails naming SENSITIVE_THRESHOLD when it is invalid", () => {
    expect(() => createIntakeDeps({ ...env, SENSITIVE_THRESHOLD: "2" })).toThrow(
      /SENSITIVE_THRESHOLD/,
    );
  });

  it("fails naming TYPESAFE_API_KEY when it is missing", () => {
    expect(() => createIntakeDeps({ ...env, TYPESAFE_API_KEY: undefined })).toThrow(
      /TYPESAFE_API_KEY/,
    );
  });

  it("fails naming LANGFUSE_SECRET_KEY when it is missing", () => {
    expect(() => createIntakeDeps({ ...env, LANGFUSE_SECRET_KEY: undefined })).toThrow(
      /LANGFUSE_SECRET_KEY/,
    );
  });

  it("fails naming SUPABASE_URL when it is missing", () => {
    expect(() => createIntakeDeps({ ...env, SUPABASE_URL: undefined })).toThrow(/SUPABASE_URL/);
  });
});
